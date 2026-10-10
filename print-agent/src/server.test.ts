import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig, saveConfig, type AgentConfig, type ReadyPrinters } from './config.ts';
import { claimPairing, openPairing, pairingState, type PairingClaim } from './pairing.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import {
	createAgentServer,
	listen,
	MAX_BODY_BYTES,
	parseJob,
	type AgentDeps,
	type AgentStatus,
	type DrawerOutcome,
	type DrawerRequest,
	type Job,
	type PrintLine,
	type SetPrintersOutcome,
	type SubmitOutcome
} from './server.ts';

const ORIGIN = 'https://pos.example.com';
const TOKEN = 'ab'.repeat(32);

const PRINTERS: ReadyPrinters = {
	receipt: { host: '127.0.0.1', port: 9100, width: 48 },
	kitchen: { host: '127.0.0.1', port: 9101, width: 32 }
};

const config: AgentConfig = {
	origin: ORIGIN,
	token: TOKEN,
	setupSecret: null,
	port: 0,
	printers: PRINTERS,
	dataDir: '/tmp/unused'
};

const status: AgentStatus = {
	agentVersion: 2,
	features: ['printers', 'setup'],
	printers: {
		receipt: { host: '127.0.0.1', port: 9100, width: 48, reachable: true, queued: 0 },
		kitchen: { host: '127.0.0.1', port: 9101, width: 32, reachable: false, queued: 2 }
	}
};

type Call = {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string | Buffer;
};
type Answer = {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	json: unknown;
};

function call(port: number, c: Call): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: '127.0.0.1', port, method: c.method, path: c.path, headers: c.headers ?? {} },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					let json: unknown = null;
					try {
						json = text ? JSON.parse(text) : null;
					} catch {
						json = text;
					}
					resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
				});
			}
		);
		req.on('error', reject);
		if (c.body !== undefined) req.write(c.body);
		req.end();
	});
}

function harness() {
	const jobs: Job[] = [];
	const drawer: DrawerRequest[] = [];
	const printerCalls: AgentConfig['printers'][] = [];
	let submitAnswer: SubmitOutcome = 'queued';
	let drawerAnswer: DrawerOutcome = 'opened';
	let printersAnswer: SetPrintersOutcome = { ok: true };
	let pairingAnswer: PairingClaim = 'not_open';
	let claims = 0;
	const deps: AgentDeps = {
		submitJob: (job) => {
			jobs.push(job);
			return submitAnswer;
		},
		pulseDrawer: async (request) => {
			drawer.push(request);
			return drawerAnswer;
		},
		status: async () => status,
		setPrinters: async (printers) => {
			printerCalls.push(printers);
			return printersAnswer;
		},
		claimPairing: () => {
			claims += 1;
			return pairingAnswer;
		}
	};
	return {
		deps,
		jobs,
		drawer,
		printerCalls,
		claims: () => claims,
		setPairing: (a: PairingClaim) => (pairingAnswer = a),
		setSubmit: (a: typeof submitAnswer) => (submitAnswer = a),
		setDrawer: (a: typeof drawerAnswer) => (drawerAnswer = a),
		setPrintersAnswer: (a: SetPrintersOutcome) => (printersAnswer = a)
	};
}

let servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
	servers = [];
});

async function start(deps: AgentDeps, cfg: AgentConfig = config) {
	const server = createAgentServer(() => cfg, deps);
	servers.push(server);
	const port = await listen(server, 0);
	const good = (extra: Record<string, string> = {}) => ({
		host: `127.0.0.1:${port}`,
		origin: ORIGIN,
		authorization: `Bearer ${TOKEN}`,
		...extra
	});
	return { server, port, good };
}

const jobBody = (over: Partial<Job> = {}) =>
	JSON.stringify({
		id: 'order-1:receipt:0',
		printer: 'receipt',
		lines: [{ text: 'Hello', bold: true }],
		cut: true,
		...over
	});

describe('binding and the three walls', () => {
	it('binds 127.0.0.1 only', async () => {
		const { server } = await start(harness().deps);
		const address = server.address();
		expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
	});

	it('refuses a foreign Host with 403 bad_host before anything else', async () => {
		const h = harness();
		const { port } = await start(h.deps);
		const answer = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: {
				host: `evil.example:${port}`,
				origin: ORIGIN,
				authorization: `Bearer ${TOKEN}`,
				'content-type': 'application/json'
			},
			body: jobBody()
		});
		expect(answer.status).toBe(403);
		expect(answer.json).toEqual({ error: 'bad_host' });
		expect(h.jobs).toHaveLength(0);
	});

	it('refuses a missing or wrong Origin with 403 bad_origin, and never calls submitJob', async () => {
		const h = harness();
		const { port } = await start(h.deps);
		const missing = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: {
				host: `127.0.0.1:${port}`,
				authorization: `Bearer ${TOKEN}`,
				'content-type': 'application/json'
			},
			body: jobBody()
		});
		expect(missing.status).toBe(403);
		expect(missing.json).toEqual({ error: 'bad_origin' });
		const wrong = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: {
				host: `localhost:${port}`,
				origin: 'https://evil.example',
				authorization: `Bearer ${TOKEN}`,
				'content-type': 'application/json'
			},
			body: jobBody()
		});
		expect(wrong.status).toBe(403);
		expect(wrong.json).toEqual({ error: 'bad_origin' });
		expect(h.jobs).toHaveLength(0);
	});

	it('answers a preflight from the configured origin with 204 and the CORS headers, plus PNA when asked', async () => {
		const { port, good } = await start(harness().deps);
		const plain = await call(port, {
			method: 'OPTIONS',
			path: '/jobs',
			headers: { host: `127.0.0.1:${port}`, origin: ORIGIN }
		});
		expect(plain.status).toBe(204);
		expect(plain.headers['access-control-allow-origin']).toBe(ORIGIN);
		expect(plain.headers['access-control-allow-methods']).toBe('GET, POST, PUT');
		expect(plain.headers['access-control-allow-headers']).toBe('authorization, content-type');
		expect(plain.headers['access-control-max-age']).toBe('600');
		expect(plain.headers['vary']).toBe('Origin');
		expect(plain.headers['access-control-allow-private-network']).toBeUndefined();

		const pna = await call(port, {
			method: 'OPTIONS',
			path: '/jobs',
			headers: { ...good(), 'access-control-request-private-network': 'true' }
		});
		expect(pna.status).toBe(204);
		expect(pna.headers['access-control-allow-private-network']).toBe('true');
	});

	it('refuses no token, a wrong token and a token one character short with 401', async () => {
		const h = harness();
		const { port } = await start(h.deps);
		for (const authorization of [
			undefined,
			`Bearer ${'cd'.repeat(32)}`,
			`Bearer ${TOKEN.slice(1)}`,
			TOKEN
		]) {
			const headers: Record<string, string> = { host: `127.0.0.1:${port}`, origin: ORIGIN };
			if (authorization) headers.authorization = authorization;
			const answer = await call(port, { method: 'GET', path: '/status', headers });
			expect(answer.status, String(authorization)).toBe(401);
			expect(answer.json).toEqual({ error: 'unauthorized' });
		}
		expect(h.jobs).toHaveLength(0);
	});
});

describe('POST /pair — the one route before the token wall', () => {
	const untokened = (port: number) => ({ host: `127.0.0.1:${port}`, origin: ORIGIN });

	it('hands the token to the till while pairing is open, with no Authorization header', async () => {
		const h = harness();
		h.setPairing('ok');
		const { port } = await start(h.deps);
		const answer = await call(port, { method: 'POST', path: '/pair', headers: untokened(port) });
		expect(answer.status).toBe(200);
		expect(answer.json).toEqual({ token: TOKEN });
		expect(answer.headers['access-control-allow-origin']).toBe(ORIGIN);
		expect(answer.headers['cache-control']).toBe('no-store');
		expect(h.claims()).toBe(1);
	});

	it.each(['claimed', 'not_open'] as const)(
		'refuses with 403 and the reason when pairing is %s, and sends no token',
		async (reason) => {
			const h = harness();
			h.setPairing(reason);
			const { port } = await start(h.deps);
			const answer = await call(port, { method: 'POST', path: '/pair', headers: untokened(port) });
			expect(answer.status).toBe(403);
			expect(answer.json).toEqual({ error: 'pairing_closed', reason });
			expect(JSON.stringify(answer.json)).not.toContain(TOKEN);
		}
	);

	it('stands behind the Host and Origin walls, and never spends the claim on a refused caller', async () => {
		const h = harness();
		h.setPairing('ok');
		const { port } = await start(h.deps);
		const wrong: Record<string, string>[] = [
			{ host: `evil.example:${port}`, origin: ORIGIN },
			{ host: `127.0.0.1:${port}`, origin: 'https://evil.example' },
			{ host: `127.0.0.1:${port}` }
		];
		for (const headers of wrong) {
			const answer = await call(port, { method: 'POST', path: '/pair', headers });
			expect(answer.status, JSON.stringify(headers)).toBe(403);
			expect(JSON.stringify(answer.json)).not.toContain(TOKEN);
		}
		expect(h.claims()).toBe(0);
	});

	it('is POST only: a GET /pair meets the token wall like any other request', async () => {
		const h = harness();
		h.setPairing('ok');
		const { port } = await start(h.deps);
		const answer = await call(port, { method: 'GET', path: '/pair', headers: untokened(port) });
		expect(answer.status).toBe(401);
		expect(h.claims()).toBe(0);
	});
});

describe('routes', () => {
	it('GET /status answers the status with no-store and the CORS headers', async () => {
		const { port, good } = await start(harness().deps);
		const answer = await call(port, { method: 'GET', path: '/status', headers: good() });
		expect(answer.status).toBe(200);
		expect(answer.json).toEqual(status);
		expect(answer.headers['cache-control']).toBe('no-store');
		expect(answer.headers['access-control-allow-origin']).toBe(ORIGIN);
		expect(answer.headers['content-type']).toBe('application/json');
	});

	it('POST /jobs: 415 for text/plain, 413 over 65,536 bytes, 422 for bad lines, 202 queued / 200 duplicate', async () => {
		const h = harness();
		const { port, good } = await start(h.deps);
		const json = good({ 'content-type': 'application/json' });

		expect(
			(
				await call(port, {
					method: 'POST',
					path: '/jobs',
					headers: good({ 'content-type': 'text/plain' }),
					body: jobBody()
				})
			).status
		).toBe(415);
		const huge = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: Buffer.alloc(MAX_BODY_BYTES + 4_464, 0x20)
		});
		expect(huge.status).toBe(413);

		const accent = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: jobBody({ lines: [{ text: 'café' }] })
		});
		expect(accent.status).toBe(422);
		expect(accent.json).toMatchObject({ error: 'bad_job' });
		const long = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: jobBody({ lines: [{ text: 'x'.repeat(49) }] })
		});
		expect(long.status).toBe(422);
		const doubleLong = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: jobBody({ lines: [{ text: 'x'.repeat(25), size: 'double' }] })
		});
		expect(doubleLong.status).toBe(422);
		const kitchenFits = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: jobBody({ printer: 'kitchen', lines: [{ text: 'x'.repeat(32) }] })
		});
		expect(kitchenFits.status).toBe(202);
		const kitchenLong = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: jobBody({ printer: 'kitchen', lines: [{ text: 'x'.repeat(33) }] })
		});
		expect(kitchenLong.status).toBe(422);
		const notJson = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: '{nope'
		});
		expect(notJson.status).toBe(422);
		expect(h.jobs).toHaveLength(1);

		const queued = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: jobBody()
		});
		expect(queued.status).toBe(202);
		expect(queued.json).toEqual({ status: 'queued' });
		h.setSubmit('duplicate');
		const dup = await call(port, { method: 'POST', path: '/jobs', headers: json, body: jobBody() });
		expect(dup.status).toBe(200);
		expect(dup.json).toEqual({ status: 'duplicate' });
		expect(h.jobs.at(-1)).toEqual({
			id: 'order-1:receipt:0',
			printer: 'receipt',
			lines: [{ text: 'Hello', bold: true }],
			cut: true
		});
	});

	it('POST /jobs: an image line beside text is 202, and a width that is not a multiple of 8 is 422', async () => {
		const h = harness();
		const { port, good } = await start(h.deps);
		const json = good({ 'content-type': 'application/json' });
		const lines: PrintLine[] = [
			{ image: { widthDots: 8, heightDots: 2, bitmap: '/4E=' } },
			{ text: 'Hello' }
		];
		const ok = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: jobBody({ lines })
		});
		expect(ok.status).toBe(202);
		expect(ok.json).toEqual({ status: 'queued' });
		expect(h.jobs.at(-1)).toEqual({
			id: 'order-1:receipt:0',
			printer: 'receipt',
			lines,
			cut: true
		});

		const bad = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: json,
			body: jobBody({ lines: [{ image: { widthDots: 12, heightDots: 2, bitmap: '/4E=' } }] })
		});
		expect(bad.status).toBe(422);
		expect(bad.json).toMatchObject({
			error: 'bad_job',
			detail: expect.stringMatching(/widthDots/)
		});
		expect(h.jobs).toHaveLength(1);
	});

	it('POST /drawer maps opened/duplicate → 200, too_late → 409, printer_unreachable → 503, bad body → 422', async () => {
		const h = harness();
		const { port, good } = await start(h.deps);
		const json = good({ 'content-type': 'application/json' });
		const body = JSON.stringify({ id: 'order-1:drawer', completedAt: '2026-09-29T09:00:00.000Z' });

		expect(
			await call(port, { method: 'POST', path: '/drawer', headers: json, body })
		).toMatchObject({ status: 200, json: { status: 'opened' } });
		h.setDrawer('duplicate');
		expect(
			await call(port, { method: 'POST', path: '/drawer', headers: json, body })
		).toMatchObject({ status: 200, json: { status: 'duplicate' } });
		h.setDrawer('too_late');
		expect(
			await call(port, { method: 'POST', path: '/drawer', headers: json, body })
		).toMatchObject({ status: 409, json: { error: 'too_late' } });
		h.setDrawer('printer_unreachable');
		expect(
			await call(port, { method: 'POST', path: '/drawer', headers: json, body })
		).toMatchObject({ status: 503, json: { error: 'printer_unreachable' } });
		const bad = await call(port, {
			method: 'POST',
			path: '/drawer',
			headers: json,
			body: JSON.stringify({ id: 'x', completedAt: 'yesterday' })
		});
		expect(bad.status).toBe(422);
		expect(bad.json).toMatchObject({ error: 'bad_request' });
		expect(h.drawer).toHaveLength(4);
	});

	it('anything else is 404', async () => {
		const { port, good } = await start(harness().deps);
		expect((await call(port, { method: 'GET', path: '/nope', headers: good() })).status).toBe(404);
		expect((await call(port, { method: 'GET', path: '/jobs', headers: good() })).status).toBe(404);
	});
});

describe('parseJob', () => {
	it('falls back to the receipt printer width for a kitchen job with no kitchen printer', () => {
		const printers = { receipt: PRINTERS.receipt, kitchen: null };
		expect(() =>
			parseJob(
				{ id: 'k', printer: 'kitchen', lines: [{ text: 'x'.repeat(48) }], cut: false },
				printers
			)
		).not.toThrow();
		expect(() =>
			parseJob(
				{ id: 'k', printer: 'kitchen', lines: [{ text: 'x'.repeat(49) }], cut: false },
				printers
			)
		).toThrow(/49 characters/);
	});

	it('refuses a bad id, an empty line list, a non-boolean cut and unknown sizes', () => {
		const printers = PRINTERS;
		expect(() =>
			parseJob({ id: 'has space', printer: 'receipt', lines: [{ text: 'a' }], cut: true }, printers)
		).toThrow(/id/);
		expect(() => parseJob({ id: 'a', printer: 'receipt', lines: [], cut: true }, printers)).toThrow(
			/lines/
		);
		expect(() =>
			parseJob({ id: 'a', printer: 'receipt', lines: [{ text: 'a' }], cut: 'yes' }, printers)
		).toThrow(/cut/);
		expect(() =>
			parseJob(
				{ id: 'a', printer: 'receipt', lines: [{ text: 'a', size: 'huge' }], cut: true },
				printers
			)
		).toThrow(/size/);
		expect(() =>
			parseJob({ id: 'a', printer: 'fax', lines: [{ text: 'a' }], cut: true }, printers)
		).toThrow(/printer/);
	});

	const bitmapOf = (bytes: number) => Buffer.alloc(bytes, 0x00).toString('base64');
	const imageJob = (
		printer: Job['printer'],
		widthDots: number,
		heightDots: number,
		bitmap = bitmapOf((widthDots / 8) * heightDots)
	) => ({ id: 'img', printer, lines: [{ image: { widthDots, heightDots, bitmap } }], cut: false });

	it("accepts image lines up to the target printer's dots", () => {
		const printers = PRINTERS;
		// 48 columns on the receipt printer: 576 dots.
		expect(() => parseJob(imageJob('receipt', 576, 1), printers)).not.toThrow();
		// 32 columns on the kitchen printer: 384 dots, and not one byte more.
		expect(() => parseJob(imageJob('kitchen', 384, 1), printers)).not.toThrow();
		expect(() => parseJob(imageJob('kitchen', 392, 1), printers)).toThrow(/widthDots/);
		// With no kitchen printer a kitchen job falls back to the receipt width.
		const noKitchen = { receipt: printers.receipt, kitchen: null };
		expect(() => parseJob(imageJob('kitchen', 576, 1), noKitchen)).not.toThrow();
		expect(() => parseJob(imageJob('receipt', 384, 240), printers)).not.toThrow();
		// The parsed line is a fresh object holding exactly the three fields.
		const raw = imageJob('receipt', 8, 1, 'AA==');
		const parsed = parseJob(raw, printers);
		expect(parsed.lines).toEqual([{ image: { widthDots: 8, heightDots: 1, bitmap: 'AA==' } }]);
		expect(parsed.lines[0]).not.toBe(raw.lines[0]);
		// A job holding only an image line is valid; two image lines are allowed.
		expect(() => parseJob({ ...raw, lines: [raw.lines[0], raw.lines[0]] }, printers)).not.toThrow();
	});

	it('refuses malformed image lines', () => {
		const printers = PRINTERS;
		const bad = (lines: unknown[]) => () =>
			parseJob({ id: 'a', printer: 'receipt', lines, cut: true }, printers);
		const img = (over: Record<string, unknown> = {}) => ({
			image: { widthDots: 8, heightDots: 2, bitmap: '/4E=', ...over }
		});
		expect(bad([img({ widthDots: 12 })])).toThrow(/lines\[0\]\.image\.widthDots/);
		expect(bad([img({ widthDots: 0 })])).toThrow(/widthDots/);
		expect(bad([img({ widthDots: '8' })])).toThrow(/widthDots/);
		expect(bad([img({ heightDots: 0 })])).toThrow(/heightDots/);
		expect(bad([img({ heightDots: 241 })])).toThrow(/heightDots/);
		expect(bad([img({ heightDots: 1.5 })])).toThrow(/heightDots/);
		// Node decodes all three leniently to FF 81; the canonical round trip refuses them.
		for (const bitmap of ['/4F=', '/4E', '_4E=']) {
			expect(Buffer.from(bitmap, 'base64')).toEqual(Buffer.from([0xff, 0x81]));
			expect(bad([img({ bitmap })]), bitmap).toThrow(/bitmap/);
		}
		// Three bytes for an 8 × 2 image (two bytes): same base64 length, wrong byte count.
		expect(bad([img({ bitmap: 'AAAA' })])).toThrow(/bitmap/);
		expect(bad([img({ bitmap: 42 })])).toThrow(/bitmap/);
		// Nothing beside the image, and nothing inside it but the three fields.
		expect(bad([{ ...img(), bold: true }])).toThrow(/lines\[0\] with an image/);
		expect(bad([img({ dither: 1 })])).toThrow(/lines\[0\]\.image must have exactly/);
		expect(bad([{ text: 'a', ...img() }])).toThrow(/lines\[0\] with an image/);
		expect(bad([{ image: 'AA==' }])).toThrow(/lines\[0\]\.image must be an object/);
		const one = { image: { widthDots: 8, heightDots: 1, bitmap: 'AA==' } };
		expect(bad([one, one, one])).toThrow(/at most 2/);
	});
});

// ── tasks/print-agent-installer T-04 ────────────────────────────────────────

const tempDirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
	for (const r of runtimes.splice(0)) await r.close();
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshInstall(printers: AgentConfig['printers'] = { receipt: null, kitchen: null }) {
	const dir = mkdtempSync(join(tmpdir(), 'matcami-agent-server-'));
	tempDirs.push(dir);
	const configPath = join(dir, 'config.json');
	const fresh = createConfig({ origin: ORIGIN, dataDir: join(dir, 'data'), printers });
	saveConfig(configPath, fresh);
	return { configPath, fresh };
}

const putPrinters = (port: number, headers: Record<string, string>, body: unknown) =>
	call(port, {
		method: 'PUT',
		path: '/printers',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body)
	});

describe('the origin is never adopted from a request (the installer plan’s BLOCKER)', () => {
	it('MANDATORY: a fresh install with pairing OPEN refuses /pair from another origin and changes nothing', async () => {
		const { configPath, fresh } = freshInstall();
		openPairing(fresh.dataDir);
		const before = readFileSync(configPath, 'utf8');
		const deps = { ...harness().deps, claimPairing: () => claimPairing(fresh.dataDir) };
		const { port } = await start(deps, fresh);
		const hostile = await call(port, {
			method: 'POST',
			path: '/pair',
			headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example' }
		});
		expect(hostile.status).toBe(403);
		expect(hostile.json).toEqual({ error: 'bad_origin' });
		// The CORS header names the configured app, so the hostile page cannot read even the refusal.
		expect(hostile.headers['access-control-allow-origin']).toBe(ORIGIN);
		expect(pairingState(fresh.dataDir)).toBe('open');
		expect(readFileSync(configPath, 'utf8')).toBe(before);
		// The app itself still pairs, once.
		const own = await call(port, {
			method: 'POST',
			path: '/pair',
			headers: { host: `127.0.0.1:${port}`, origin: ORIGIN }
		});
		expect(own.status).toBe(200);
		expect(own.json).toEqual({ token: fresh.token });
		expect(pairingState(fresh.dataDir)).toBe('claimed');
	});
});

describe('PUT /printers', () => {
	const valid = { receipt: { host: '192.168.1.50', width: 48 }, kitchen: null };

	it('needs the token (401) and the app origin (403), and calls nothing otherwise', async () => {
		const h = harness();
		const { port, good } = await start(h.deps);
		const noToken = await putPrinters(port, { host: `127.0.0.1:${port}`, origin: ORIGIN }, valid);
		expect(noToken.status).toBe(401);
		const wrongOrigin = await putPrinters(port, good({ origin: 'https://evil.example' }), valid);
		expect(wrongOrigin.status).toBe(403);
		expect(wrongOrigin.json).toEqual({ error: 'bad_origin' });
		expect(h.printerCalls).toHaveLength(0);
	});

	it('saves the printers (port defaults to 9100, only the three fields travel) and answers the new status', async () => {
		const h = harness();
		const { port, good } = await start(h.deps);
		const answer = await putPrinters(port, good(), {
			receipt: { host: '192.168.1.50', width: 48, extra: 'dropped' },
			kitchen: { host: '192.168.1.51', port: 9101, width: 32 }
		});
		expect(answer.status).toBe(200);
		expect(answer.json).toEqual({ printers: status.printers });
		expect(h.printerCalls).toEqual([
			{
				receipt: { host: '192.168.1.50', port: 9100, width: 48 },
				kitchen: { host: '192.168.1.51', port: 9101, width: 32 }
			}
		]);
	});

	it('names the bad field with 422 bad_printers', async () => {
		const h = harness();
		const { port, good } = await start(h.deps);
		const host = await putPrinters(port, good(), { receipt: { host: 'a b', width: 48 } });
		expect(host.status).toBe(422);
		expect(host.json).toEqual({ error: 'bad_printers', field: 'receipt.host' });
		const width = await putPrinters(port, good(), { receipt: { host: '10.0.0.5', width: 40 } });
		expect(width.json).toEqual({ error: 'bad_printers', field: 'receipt.width' });
		const missing = await putPrinters(port, good(), { kitchen: null });
		expect(missing.json).toEqual({ error: 'bad_printers', field: 'receipt' });
		const kitchenPort = await putPrinters(port, good(), {
			receipt: { host: '10.0.0.5', width: 48 },
			kitchen: { host: '10.0.0.6', port: 0, width: 32 }
		});
		expect(kitchenPort.json).toEqual({ error: 'bad_printers', field: 'kitchen.port' });
		expect(h.printerCalls).toHaveLength(0);
	});

	it('answers 409 jobs_waiting when the runtime refuses a width change', async () => {
		const h = harness();
		h.setPrintersAnswer({ ok: false, error: 'jobs_waiting', target: 'receipt', queued: 3 });
		const { port, good } = await start(h.deps);
		const answer = await putPrinters(port, good(), valid);
		expect(answer.status).toBe(409);
		expect(answer.json).toEqual({ error: 'jobs_waiting', target: 'receipt', queued: 3 });
	});

	it('keeps the shared body rules: 415 unless JSON, 400 on a body that is not JSON', async () => {
		const { port, good } = await start(harness().deps);
		const notJson = await call(port, {
			method: 'PUT',
			path: '/printers',
			headers: good({ 'content-type': 'text/plain' }),
			body: '{}'
		});
		expect(notJson.status).toBe(415);
		const garbled = await call(port, {
			method: 'PUT',
			path: '/printers',
			headers: good({ 'content-type': 'application/json' }),
			body: '{'
		});
		expect(garbled.status).toBe(400);
	});
});

describe('no printer yet', () => {
	it('a no_printer outcome is 503 { error: no_printer } for jobs and for the drawer', async () => {
		const h = harness();
		h.setSubmit('no_printer');
		h.setDrawer('no_printer');
		const { port, good } = await start(h.deps);
		const job = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: good({ 'content-type': 'application/json' }),
			body: jobBody()
		});
		expect(job.status).toBe(503);
		expect(job.json).toEqual({ error: 'no_printer' });
		const drawer = await call(port, {
			method: 'POST',
			path: '/drawer',
			headers: good({ 'content-type': 'application/json' }),
			body: JSON.stringify({ id: 'd-1', completedAt: new Date().toISOString() })
		});
		expect(drawer.status).toBe(503);
		expect(drawer.json).toEqual({ error: 'no_printer' });
	});

	it('through a real runtime: status reports nulls, jobs and pulses are 503, and PUT /printers sets one', async () => {
		const { configPath, fresh } = freshInstall();
		const runtime = createRuntime({ configPath, config: fresh });
		runtimes.push(runtime);
		const server = createAgentServer(runtime.config, {
			...runtime.deps,
			claimPairing: () => claimPairing(fresh.dataDir)
		});
		servers.push(server);
		const port = await listen(server, 0);
		const headers = {
			host: `127.0.0.1:${port}`,
			origin: ORIGIN,
			authorization: `Bearer ${fresh.token}`
		};
		const before = await call(port, { method: 'GET', path: '/status', headers });
		expect(before.status).toBe(200);
		expect(before.json).toEqual({
			agentVersion: 2,
			features: ['printers', 'setup'],
			printers: { receipt: null, kitchen: null }
		});
		const job = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: { ...headers, 'content-type': 'application/json' },
			body: jobBody()
		});
		expect(job.status).toBe(503);
		expect(job.json).toEqual({ error: 'no_printer' });
		const drawer = await call(port, {
			method: 'POST',
			path: '/drawer',
			headers: { ...headers, 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'd-2', completedAt: new Date().toISOString() })
		});
		expect(drawer.status).toBe(503);
		expect(drawer.json).toEqual({ error: 'no_printer' });

		const set = await putPrinters(port, headers, {
			receipt: { host: '127.0.0.1', port: 9, width: 32 },
			kitchen: null
		});
		expect(set.status).toBe(200);
		expect(set.json).toMatchObject({
			printers: { receipt: { host: '127.0.0.1', port: 9, width: 32 }, kitchen: null }
		});
		// The server reads the config per request, so the new printer is live at once.
		expect(runtime.config().printers.receipt).toEqual({ host: '127.0.0.1', port: 9, width: 32 });
		const queued = await call(port, {
			method: 'POST',
			path: '/jobs',
			headers: { ...headers, 'content-type': 'application/json' },
			body: jobBody({ lines: [{ text: 'x'.repeat(32) }] })
		});
		expect(queued.status).toBe(202);
	});
});
