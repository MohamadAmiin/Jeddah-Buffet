import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrinterConfig } from './config.ts';
import { DRAWER_PULSE, PAPER_STATUS_QUERY } from './escpos.ts';
import { createDrawer, createQueue, createSeenStore, SEEN_TTL_MS, type Queue } from './queue.ts';
import type { Job } from './server.ts';

// ── Fakes ───────────────────────────────────────────────────────────────────

type Fake = {
	cfg: PrinterConfig;
	/** One entry per connection that carried something other than a status query. */
	jobs: Buffer[];
	queries: number;
	stop: () => Promise<void>;
};

const running: Fake[] = [];
const queues: Queue[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const q of queues.splice(0)) q.close();
	for (const f of running.splice(0)) await f.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const isQuery = (b: Buffer) =>
	b.length === PAPER_STATUS_QUERY.length && b.equals(Buffer.from(PAPER_STATUS_QUERY));

/** A fake raw printer on 127.0.0.1:<port> (0 = any free). It never answers a status query. */
function startFake(port = 0): Promise<Fake> {
	return new Promise((resolve) => {
		const jobs: Buffer[] = [];
		const sockets = new Set<Socket>();
		const fake: Fake = {
			cfg: { host: '127.0.0.1', port, width: 48 },
			jobs,
			queries: 0,
			stop: async () => {}
		};
		const server: Server = createServer((socket) => {
			sockets.add(socket);
			const chunks: Buffer[] = [];
			socket.on('data', (c: Buffer) => chunks.push(c));
			socket.on('close', () => {
				sockets.delete(socket);
				const all = Buffer.concat(chunks);
				if (all.length === 0) return;
				if (isQuery(all)) fake.queries += 1;
				else jobs.push(all);
			});
		});
		fake.stop = () =>
			new Promise((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r(undefined));
			});
		server.listen(port, '127.0.0.1', () => {
			const address = server.address();
			fake.cfg.port = typeof address === 'object' && address ? address.port : port;
			running.push(fake);
			resolve(fake);
		});
	});
}

/** A port nothing listens on right now, which a later startFake(port) can take. */
async function freePort(): Promise<number> {
	const fake = await startFake(0);
	running.splice(running.indexOf(fake), 1);
	await fake.stop();
	return fake.cfg.port;
}

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'matcami-queue-'));
	dirs.push(dir);
	return dir;
}

async function until(cond: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 15));
	}
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const FAST = { retry: { baseMs: 40, maxMs: 160 }, paperStatusTimeoutMs: 40, sendTimeoutMs: 1000 };

function makeQueue(
	dataDir: string,
	receipt: PrinterConfig,
	kitchen: PrinterConfig | null = null,
	now?: () => number
) {
	const q = createQueue({ dataDir, printers: { receipt, kitchen }, now, ...FAST });
	queues.push(q);
	return q;
}

const job = (id: string, text: string, printer: Job['printer'] = 'receipt'): Job => ({
	id,
	printer,
	lines: [{ text }],
	cut: true
});

const textOf = (bytes: Buffer) => bytes.toString('latin1').replace(/[^\x20-\x7e]/g, '');
const queueFiles = (dataDir: string) =>
	readdirSync(join(dataDir, 'queue')).filter((n) => n.endsWith('.json'));

// ── The queue ───────────────────────────────────────────────────────────────

describe('createQueue', () => {
	it('prints a job once: the same id is queued then duplicate, across a restart too', async () => {
		const fake = await startFake();
		const dir = tmp();
		const q = makeQueue(dir, fake.cfg);
		expect(q.submit(job('o1:receipt:0', 'Tea'))).toBe('queued');
		expect(q.submit(job('o1:receipt:0', 'Tea'))).toBe('duplicate');
		await until(() => fake.jobs.length === 1, 4000, 'the first print');
		await settle();
		expect(fake.jobs).toHaveLength(1);
		expect(textOf(fake.jobs[0]!)).toContain('Tea');
		expect(queueFiles(dir)).toEqual([]);
		expect(q.submit(job('o1:receipt:0', 'Tea'))).toBe('duplicate');
		const log = readFileSync(join(dir, 'agent.log'), 'utf8');
		expect(log).toMatch(/Z printed o1:receipt:0\n/);

		q.close();
		const again = makeQueue(dir, fake.cfg);
		expect(again.submit(job('o1:receipt:0', 'Tea'))).toBe('duplicate');
		await settle();
		expect(fake.jobs).toHaveLength(1);
	});

	it('keeps a job on disk while the printer is down, prints it once when it returns, then in order', async () => {
		const port = await freePort();
		const dir = tmp();
		const cfg: PrinterConfig = { host: '127.0.0.1', port, width: 48 };
		const q = makeQueue(dir, cfg);
		expect(q.submit(job('o2:receipt:0', 'First'))).toBe('queued');
		await settle(250);
		expect(queueFiles(dir)).toHaveLength(1);
		const stored = JSON.parse(readFileSync(join(dir, 'queue', queueFiles(dir)[0]!), 'utf8'));
		expect(stored).toMatchObject({ id: 'o2:receipt:0', target: 'receipt' });
		expect(typeof stored.bytesBase64).toBe('string');
		expect(await q.status()).toMatchObject({
			printers: { receipt: { reachable: false, queued: 1 }, kitchen: null }
		});

		const fake = await startFake(port);
		await until(() => fake.jobs.length === 1, 5000, 'the resumed print');
		await settle();
		expect(fake.jobs).toHaveLength(1);
		expect(queueFiles(dir)).toEqual([]);

		expect(q.submit(job('o3:receipt:0', 'Alpha'))).toBe('queued');
		expect(q.submit(job('o4:receipt:0', 'Bravo'))).toBe('queued');
		await until(() => fake.jobs.length === 3, 5000, 'two more prints');
		expect(textOf(fake.jobs[1]!)).toContain('Alpha');
		expect(textOf(fake.jobs[2]!)).toContain('Bravo');
	});

	it('resumes queued files from a previous run in file order', async () => {
		const port = await freePort();
		const dir = tmp();
		const cfg: PrinterConfig = { host: '127.0.0.1', port, width: 48 };
		const first = makeQueue(dir, cfg);
		first.submit(job('r1', 'One'));
		first.submit(job('r2', 'Two'));
		await settle(100);
		first.close();
		expect(queueFiles(dir)).toHaveLength(2);

		const fake = await startFake(port);
		const second = makeQueue(dir, cfg);
		expect(second.submit(job('r1', 'One'))).toBe('duplicate');
		await until(() => fake.jobs.length === 2, 5000, 'the resumed prints');
		expect(textOf(fake.jobs[0]!)).toContain('One');
		expect(textOf(fake.jobs[1]!)).toContain('Two');
		expect(queueFiles(dir)).toEqual([]);
	});

	it('sends a kitchen job to the receipt printer when no kitchen printer is configured', async () => {
		const fake = await startFake();
		const dir = tmp();
		const q = makeQueue(dir, fake.cfg, null);
		expect(q.submit(job('o5:kitchen:0', 'ORDER 5', 'kitchen'))).toBe('queued');
		await until(() => fake.jobs.length === 1, 4000, 'the kitchen ticket');
		expect(textOf(fake.jobs[0]!)).toContain('ORDER 5');
	});

	it('sends a kitchen job to the kitchen printer when one is configured', async () => {
		const receipt = await startFake();
		const kitchen = await startFake();
		const dir = tmp();
		const q = makeQueue(dir, receipt.cfg, { ...kitchen.cfg, width: 32 });
		q.submit(job('o6:kitchen:0', 'ORDER 6', 'kitchen'));
		q.submit(job('o6:receipt:0', 'Receipt 6', 'receipt'));
		await until(() => kitchen.jobs.length === 1 && receipt.jobs.length === 1, 4000, 'both prints');
		expect(textOf(kitchen.jobs[0]!)).toContain('ORDER 6');
		expect(textOf(receipt.jobs[0]!)).toContain('Receipt 6');
		const status = await q.status();
		expect(status.printers.kitchen).toMatchObject({ width: 32, reachable: true, queued: 0 });
	});

	it('prunes seen entries older than 48 hours on start', async () => {
		const dir = tmp();
		const t0 = Date.parse('2026-09-29T09:00:00Z');
		const seen = createSeenStore(dir, () => t0);
		seen.record('old');
		expect(seen.size()).toBe(1);
		const fake = await startFake();
		const later = makeQueue(dir, fake.cfg, null, () => t0 + SEEN_TTL_MS + 1000);
		expect(later.seen.has('old')).toBe(false);
		expect(later.submit(job('old', 'Again'))).toBe('queued');
		const fresh = createSeenStore(dir, () => t0 + SEEN_TTL_MS - 1000);
		fresh.record('young');
		expect(fresh.prune()).toBe(0);
		expect(fresh.has('young')).toBe(true);
	});
});

// ── The drawer ──────────────────────────────────────────────────────────────

describe('createDrawer', () => {
	const pulseBytes = Buffer.from(DRAWER_PULSE);

	it('pulses once for a fresh sale, and a repeat id is a duplicate with no bytes', async () => {
		const fake = await startFake();
		const dir = tmp();
		const t0 = Date.parse('2026-09-29T09:00:00Z');
		const q = makeQueue(dir, fake.cfg, null, () => t0);
		const drawer = createDrawer({ receipt: fake.cfg, seen: q.seen, log: q.log, now: () => t0 });
		const request = { id: 'o7:drawer', completedAt: new Date(t0 - 5000).toISOString() };
		expect(await drawer.pulse(request)).toBe('opened');
		await until(() => fake.jobs.length === 1, 3000, 'the pulse');
		expect(fake.jobs[0]!.equals(pulseBytes)).toBe(true);
		expect(await drawer.pulse(request)).toBe('duplicate');
		await settle();
		expect(fake.jobs).toHaveLength(1);
		expect(readFileSync(join(dir, 'agent.log'), 'utf8')).toMatch(/Z drawer o7:drawer\n/);
		expect(queueFiles(dir)).toEqual([]);
	});

	it('refuses a pulse 31 s old, 31 s in the future, or with an unparsable time — no bytes', async () => {
		const fake = await startFake();
		const dir = tmp();
		const t0 = Date.parse('2026-09-29T09:00:00Z');
		const q = makeQueue(dir, fake.cfg, null, () => t0);
		const drawer = createDrawer({ receipt: fake.cfg, seen: q.seen, log: q.log, now: () => t0 });
		expect(
			await drawer.pulse({ id: 'late', completedAt: new Date(t0 - 31_000).toISOString() })
		).toBe('too_late');
		expect(
			await drawer.pulse({ id: 'early', completedAt: new Date(t0 + 31_000).toISOString() })
		).toBe('too_late');
		expect(await drawer.pulse({ id: 'garbage', completedAt: 'yesterday' })).toBe('too_late');
		expect(
			await drawer.pulse({ id: 'edge', completedAt: new Date(t0 - 30_000).toISOString() })
		).toBe('opened');
		await until(() => fake.jobs.length === 1, 3000, 'the edge pulse');
		await settle();
		expect(fake.jobs).toHaveLength(1);
		expect(q.seen.has('late')).toBe(false);
	});

	it('answers printer_unreachable when the receipt printer is down, and NEVER pulses later', async () => {
		const port = await freePort();
		const dir = tmp();
		const cfg: PrinterConfig = { host: '127.0.0.1', port, width: 48 };
		const t0 = Date.now();
		const q = makeQueue(dir, cfg, null, () => t0);
		const drawer = createDrawer({
			receipt: cfg,
			seen: q.seen,
			log: q.log,
			now: () => t0,
			sendTimeoutMs: 500
		});
		expect(await drawer.pulse({ id: 'o8:drawer', completedAt: new Date(t0).toISOString() })).toBe(
			'printer_unreachable'
		);
		expect(queueFiles(dir)).toEqual([]);
		expect(q.seen.has('o8:drawer')).toBe(false);
		const fake = await startFake(port);
		await settle(400);
		expect(fake.jobs).toEqual([]);
		// The till may ask again while the sale is still fresh; that is a new send, not a replay.
		expect(await drawer.pulse({ id: 'o8:drawer', completedAt: new Date(t0).toISOString() })).toBe(
			'opened'
		);
	});
});
