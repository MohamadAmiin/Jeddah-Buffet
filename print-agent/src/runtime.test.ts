import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig, saveConfig, type AgentConfig, type PrinterConfig } from './config.ts';
import { DRAWER_PULSE, PAPER_STATUS_QUERY } from './escpos.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import type { Job } from './server.ts';

// ── Fakes (the queue.test.ts pattern) ───────────────────────────────────────

type Fake = { cfg: PrinterConfig; jobs: Buffer[]; stop: () => Promise<void> };

const fakes: Fake[] = [];
const runtimes: Runtime[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const r of runtimes.splice(0)) await r.close();
	for (const f of fakes.splice(0)) await f.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const isQuery = (b: Buffer) =>
	b.length === PAPER_STATUS_QUERY.length && b.equals(Buffer.from(PAPER_STATUS_QUERY));

/** A raw printer on 127.0.0.1:<port> (0 = any free) that records every job it receives. */
function startFake(port = 0): Promise<Fake> {
	return new Promise((resolve) => {
		const sockets = new Set<Socket>();
		const fake: Fake = {
			cfg: { host: '127.0.0.1', port, width: 48 },
			jobs: [],
			stop: async () => {}
		};
		const server: Server = createServer((socket) => {
			sockets.add(socket);
			const chunks: Buffer[] = [];
			socket.on('data', (c: Buffer) => chunks.push(c));
			socket.on('close', () => {
				sockets.delete(socket);
				const all = Buffer.concat(chunks);
				if (all.length > 0 && !isQuery(all)) fake.jobs.push(all);
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
			fakes.push(fake);
			resolve(fake);
		});
	});
}

/** A port nothing listens on: a printer that is down. */
async function downPrinter(width: 32 | 48 = 48): Promise<PrinterConfig> {
	const fake = await startFake(0);
	fakes.splice(fakes.indexOf(fake), 1);
	await fake.stop();
	return { ...fake.cfg, width };
}

async function until(cond: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 15));
	}
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const FAST = { retry: { baseMs: 40, maxMs: 160 }, paperStatusTimeoutMs: 40, sendTimeoutMs: 1000 };
const T0 = Date.parse('2026-10-10T09:00:00Z');

function setUp(printers: AgentConfig['printers'], now?: () => number) {
	const dir = mkdtempSync(join(tmpdir(), 'matcami-runtime-'));
	dirs.push(dir);
	const configPath = join(dir, 'config.json');
	const config = createConfig({
		origin: 'https://pos.example.com',
		dataDir: join(dir, 'data'),
		printers
	});
	saveConfig(configPath, config);
	const runtime = createRuntime({ configPath, config, queue: { ...FAST, now } });
	runtimes.push(runtime);
	return { runtime, configPath, dataDir: join(dir, 'data') };
}

const job = (id: string, text: string): Job => ({
	id,
	printer: 'receipt',
	lines: [{ text }],
	cut: true
});
/** A receipt that carries the logo: one 8 × 1 image line, then text. */
const logoJob = (id: string, text: string): Job => ({
	id,
	printer: 'receipt',
	lines: [{ image: { widthDots: 8, heightDots: 1, bitmap: 'AA==' } }, { text }],
	cut: true
});
/** The start of every GS v 0 band the encoder writes. */
const RASTER = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
const textOf = (b: Buffer) => b.toString('latin1').replace(/[^\x20-\x7e]/g, '');
const onDisk = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;

// ── No printer yet ──────────────────────────────────────────────────────────

describe('a runtime with no receipt printer', () => {
	it('answers no_printer for jobs and pulses, reports nulls with its features, and opens no queue', async () => {
		const { runtime, dataDir } = setUp({ receipt: null, kitchen: null });
		expect(await runtime.deps.status()).toEqual({
			agentVersion: 2,
			features: ['printers', 'setup'],
			printers: { receipt: null, kitchen: null }
		});
		expect(await runtime.deps.submitJob(job('a', 'Tea'))).toBe('no_printer');
		expect(await runtime.deps.pulseDrawer({ id: 'd', completedAt: new Date().toISOString() })).toBe(
			'no_printer'
		);
		// No queue was built, so nothing was written and no printer was contacted.
		expect(existsSync(join(dataDir, 'queue'))).toBe(false);
	});

	it('setting a receipt printer saves it and the next job prints there', async () => {
		const a = await startFake();
		const { runtime, configPath } = setUp({ receipt: null, kitchen: null });
		expect(await runtime.deps.setPrinters({ receipt: a.cfg, kitchen: null })).toEqual({ ok: true });
		expect(onDisk(configPath).printers.receipt).toEqual(a.cfg);
		expect(runtime.config().printers.receipt).toEqual(a.cfg);
		expect(await runtime.deps.submitJob(job('first', 'Hello'))).toBe('queued');
		await until(() => a.jobs.length === 1, 4000, 'the print on A');
		expect(textOf(a.jobs[0]!)).toContain('Hello');
	});
});

// ── Changing printers under a running queue ─────────────────────────────────

describe('setPrinters re-wires the queue and the drawer', () => {
	it('a host change with the same width: jobs queued for the dead printer print on the new one', async () => {
		const a = await downPrinter(48);
		const { runtime } = setUp({ receipt: a, kitchen: null });
		expect(await runtime.deps.submitJob(job('q1', 'One'))).toBe('queued');
		expect(await runtime.deps.submitJob(job('q2', 'Two'))).toBe('queued');
		await settle();
		const b = await startFake();
		expect(await runtime.deps.setPrinters({ receipt: b.cfg, kitchen: null })).toEqual({ ok: true });
		await until(() => b.jobs.length === 2, 5000, 'both queued jobs on B');
		expect(textOf(b.jobs[0]!)).toContain('One');
		expect(textOf(b.jobs[1]!)).toContain('Two');
		// A job id printed before the rebuild is still a duplicate after it.
		expect(await runtime.deps.submitJob(job('q1', 'One'))).toBe('duplicate');
	});

	// THE LOGO GATE ACROSS A PRINTER CHANGE. A receipt carries the logo only for
	// the printer its confirmation was watched on; one queued for printer A and
	// moved to B — which nobody test-printed, and which may read a raster as
	// ordinary bytes, the drawer pulse included — prints in full WITHOUT it.
	it('a queued receipt that carries the logo goes to a NEW printer without it', async () => {
		const a = await downPrinter(48);
		const { runtime, dataDir } = setUp({ receipt: a, kitchen: null });
		expect(await runtime.deps.submitJob(logoJob('l1', 'Logo receipt'))).toBe('queued');
		await settle();
		const b = await startFake();
		expect(await runtime.deps.setPrinters({ receipt: b.cfg, kitchen: null })).toEqual({ ok: true });
		await until(() => b.jobs.length === 1, 5000, 'the queued receipt on B');
		expect(textOf(b.jobs[0]!)).toContain('Logo receipt');
		expect(b.jobs[0]!.includes(RASTER)).toBe(false);
		expect(readFileSync(join(dataDir, 'agent.log'), 'utf8')).toContain(
			'printed l1 without its logo: the receipt printer changed'
		);
	});

	it('the same receipt back on the printer it was laid out for keeps its logo', async () => {
		const a = await downPrinter(48);
		const { runtime } = setUp({ receipt: a, kitchen: null });
		expect(await runtime.deps.submitJob(logoJob('l2', 'Logo receipt'))).toBe('queued');
		await settle();
		// Away to another (also dead) printer, then back to A before anything printed.
		expect(
			await runtime.deps.setPrinters({ receipt: await downPrinter(48), kitchen: null })
		).toEqual({ ok: true });
		await settle();
		expect(await runtime.deps.setPrinters({ receipt: a, kitchen: null })).toEqual({ ok: true });
		const back = await startFake(a.port);
		await until(() => back.jobs.length === 1, 5000, 'the receipt on A');
		expect(back.jobs[0]!.includes(RASTER)).toBe(true);
		expect(textOf(back.jobs[0]!)).toContain('Logo receipt');
	});

	it('a width change is REFUSED while that printer has a job waiting, and nothing is written', async () => {
		const a = await downPrinter(48);
		const { runtime, configPath } = setUp({ receipt: a, kitchen: null });
		expect(await runtime.deps.submitJob(job('w1', 'Waiting'))).toBe('queued');
		const before = readFileSync(configPath, 'utf8');
		expect(await runtime.deps.setPrinters({ receipt: { ...a, width: 32 }, kitchen: null })).toEqual(
			{
				ok: false,
				error: 'jobs_waiting',
				target: 'receipt',
				queued: 1
			}
		);
		expect(readFileSync(configPath, 'utf8')).toBe(before);
		expect(runtime.config().printers.receipt).toEqual(a);
	});

	it('a width change with nothing waiting is accepted', async () => {
		const b = await startFake();
		const { runtime, configPath } = setUp({ receipt: b.cfg, kitchen: null });
		expect(
			await runtime.deps.setPrinters({ receipt: { ...b.cfg, width: 32 }, kitchen: null })
		).toEqual({
			ok: true
		});
		expect(onDisk(configPath).printers.receipt?.width).toBe(32);
		const status = await runtime.deps.status();
		expect(status.printers.receipt).toMatchObject({ port: b.cfg.port, width: 32 });
	});

	it('the drawer pulses the NEW printer after a change; a 31-second-old pulse opens nothing', async () => {
		const a = await startFake();
		const b = await startFake();
		const { runtime } = setUp({ receipt: a.cfg, kitchen: null }, () => T0);
		await runtime.deps.setPrinters({ receipt: b.cfg, kitchen: null });
		expect(
			await runtime.deps.pulseDrawer({
				id: 'sale-1:drawer',
				completedAt: new Date(T0 - 5000).toISOString()
			})
		).toBe('opened');
		await until(() => b.jobs.length === 1, 3000, 'the pulse on B');
		expect(b.jobs[0]!.equals(Buffer.from(DRAWER_PULSE))).toBe(true);
		expect(
			await runtime.deps.pulseDrawer({
				id: 'sale-2:drawer',
				completedAt: new Date(T0 - 31_000).toISOString()
			})
		).toBe('too_late');
		await settle();
		expect(a.jobs).toHaveLength(0);
		expect(b.jobs).toHaveLength(1);
	});

	it('two changes at once run one after the other — the last one wins, whole', async () => {
		const a = await startFake();
		const b = await startFake();
		const { runtime, configPath } = setUp({ receipt: null, kitchen: null });
		const [first, second] = await Promise.all([
			runtime.deps.setPrinters({ receipt: a.cfg, kitchen: null }),
			runtime.deps.setPrinters({ receipt: b.cfg, kitchen: null })
		]);
		expect(first).toEqual({ ok: true });
		expect(second).toEqual({ ok: true });
		expect(onDisk(configPath).printers.receipt).toEqual(b.cfg);
		expect((await runtime.deps.status()).printers.receipt).toMatchObject({ port: b.cfg.port });
		expect(await runtime.deps.submitJob(job('after', 'Last'))).toBe('queued');
		await until(() => b.jobs.length === 1, 4000, 'the print on B');
		expect(a.jobs).toHaveLength(0);
	});

	// What serialising buys: unserialised, both rebuilds close the same old queue
	// and each builds its own new one, and both new queues resume the waiting
	// job from disk — two queues on one data/, the receipt printed twice.
	it('two rebuilds at once leave ONE queue: a waiting job prints exactly once', async () => {
		const a = await downPrinter(48);
		const { runtime } = setUp({ receipt: a, kitchen: null });
		expect(await runtime.deps.submitJob(job('once', 'Exactly once'))).toBe('queued');
		await settle();
		const b = await startFake();
		const [first, second] = await Promise.all([
			runtime.deps.setPrinters({ receipt: b.cfg, kitchen: null }),
			runtime.deps.setPrinters({ receipt: b.cfg, kitchen: null })
		]);
		expect(first).toEqual({ ok: true });
		expect(second).toEqual({ ok: true });
		await until(() => b.jobs.length >= 1, 5000, 'the waiting job on B');
		await settle(600);
		expect(b.jobs).toHaveLength(1);
	});
});

describe('setOrigin', () => {
	it('saves the new origin and the runtime answers with it', async () => {
		const { runtime, configPath } = setUp({ receipt: null, kitchen: null });
		await runtime.setOrigin('https://new.example.com/');
		expect(runtime.config().origin).toBe('https://new.example.com');
		expect(onDisk(configPath).origin).toBe('https://new.example.com');
		await expect(runtime.setOrigin('http://evil.example')).rejects.toThrow(/origin/);
		expect(runtime.config().origin).toBe('https://new.example.com');
	});
});
