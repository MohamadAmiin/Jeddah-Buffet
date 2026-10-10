import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig, saveConfig, type AgentConfig, type NetworkPrinter } from './config.ts';
import { DRAWER_PULSE, PAPER_STATUS_QUERY } from './escpos.ts';
import { forgetLocalPrinters, localIo } from './local-printer.ts';
import { claimPairing, openPairing, pairingState } from './pairing.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import { createAgentServer, listen } from './server.ts';
import { createSetupHandler, setupTestLines } from './setup.ts';

const APP = 'https://pos.example.com';
const PAGE = { html: '<!doctype html><title>setup page</title>', js: '/* js */', css: '/* css */' };

const servers: Server[] = [];
const runtimes: Runtime[] = [];
const printers: TcpServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
	for (const r of runtimes.splice(0)) await r.close();
	for (const p of printers.splice(0)) await new Promise((r) => p.close(() => r(undefined)));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Answer = { status: number; headers: Record<string, unknown>; text: string; json: unknown };

function call(
	port: number,
	method: string,
	path: string,
	headers: Record<string, string>,
	body?: string
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				let json: unknown = null;
				try {
					json = text ? JSON.parse(text) : null;
				} catch {
					json = null;
				}
				resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
			});
		});
		req.on('error', reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/** A raw printer that records every job; it never answers a status query. */
function fakePrinter(): Promise<{ cfg: NetworkPrinter; jobs: Buffer[] }> {
	return new Promise((resolve) => {
		const jobs: Buffer[] = [];
		const sockets = new Set<Socket>();
		const server = createTcpServer((socket) => {
			sockets.add(socket);
			const chunks: Buffer[] = [];
			socket.on('data', (c: Buffer) => chunks.push(c));
			socket.on('close', () => {
				sockets.delete(socket);
				const all = Buffer.concat(chunks);
				const query = Buffer.from(PAPER_STATUS_QUERY);
				if (all.length > 0 && !(all.length === query.length && all.equals(query))) jobs.push(all);
			});
		});
		const close = server.close.bind(server);
		server.close = ((cb?: (err?: Error) => void) => {
			for (const s of sockets) s.destroy();
			return close(cb);
		}) as typeof server.close;
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			printers.push(server);
			resolve({ cfg: { host: '127.0.0.1', port, width: 32 }, jobs });
		});
	});
}

async function agent(opts: { printers?: AgentConfig['printers']; noSecret?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'matcami-setup-'));
	dirs.push(dir);
	const configPath = join(dir, 'config.json');
	let config = createConfig({
		origin: APP,
		dataDir: join(dir, 'data'),
		printers: opts.printers ?? { receipt: null, kitchen: null }
	});
	if (opts.noSecret) config = { ...config, setupSecret: null };
	saveConfig(configPath, config);
	const runtime = createRuntime({
		configPath,
		config,
		queue: { retry: { baseMs: 40, maxMs: 160 }, paperStatusTimeoutMs: 40, sendTimeoutMs: 1000 }
	});
	runtimes.push(runtime);
	let quits = 0;
	const setup = createSetupHandler({
		runtime,
		openPairing: () => openPairing(config.dataDir),
		pairingState: () => pairingState(config.dataDir),
		rekey: async () => {
			await runtime.setToken(randomBytes(32).toString('hex'));
			openPairing(config.dataDir);
		},
		quit: () => (quits += 1),
		page: PAGE
	});
	const server = createAgentServer(runtime.config, {
		...runtime.deps,
		claimPairing: () => claimPairing(config.dataDir),
		setup
	});
	servers.push(server);
	const port = await listen(server, 0);
	const own = `http://127.0.0.1:${port}`;
	const api = (path: string, body: unknown = {}, extra: Record<string, string> = {}) =>
		call(
			port,
			'POST',
			path,
			{
				host: `127.0.0.1:${port}`,
				origin: own,
				'content-type': 'application/json',
				'x-setup-secret': config.setupSecret ?? '',
				...extra
			},
			JSON.stringify(body)
		);
	return { port, own, api, runtime, configPath, config, quits: () => quits };
}

describe('the setup page itself', () => {
	it('is served with a strict CSP, no framing, no CORS — and no secret in it', async () => {
		const { port, config } = await agent();
		const page = await call(port, 'GET', '/setup', { host: `127.0.0.1:${port}` });
		expect(page.status).toBe(200);
		expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
		// The whole policy, so loosening any one directive fails here.
		expect(page.headers['content-security-policy']).toBe(
			"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		);
		const css = await call(port, 'GET', '/setup.css', { host: `127.0.0.1:${port}` });
		expect(css.headers['content-security-policy']).toBe(page.headers['content-security-policy']);
		expect(page.headers['x-frame-options']).toBe('DENY');
		expect(page.headers['access-control-allow-origin']).toBeUndefined();
		expect(page.text).toBe(PAGE.html);
		expect(page.text).not.toContain(config.token);
		expect(page.text).not.toContain(config.setupSecret!);
		const js = await call(port, 'GET', '/setup.js', { host: `127.0.0.1:${port}` });
		expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
		expect(js.text).toBe(PAGE.js);
	});

	it('the Host wall still runs first', async () => {
		const { port } = await agent();
		const page = await call(port, 'GET', '/setup', { host: `evil.example:${port}` });
		expect(page.status).toBe(403);
		expect(page.json).toEqual({ error: 'bad_host' });
	});
});

describe('the setup API walls', () => {
	it('refuses no Origin, the APP origin, a cross-site fetch, no key and a wrong key', async () => {
		const { port, own, api, config } = await agent();
		const base = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
		const secret = { 'x-setup-secret': config.setupSecret! };
		const none = await call(port, 'POST', '/setup/state', { ...base, ...secret }, '{}');
		expect(none.status).toBe(403);
		const app = await call(port, 'POST', '/setup/state', { ...base, ...secret, origin: APP }, '{}');
		expect(app.status).toBe(403);
		expect(app.json).toEqual({ error: 'bad_origin' });
		const cross = await api('/setup/state', {}, { 'sec-fetch-site': 'cross-site' });
		expect(cross.status).toBe(403);
		expect(cross.json).toEqual({ error: 'cross_site' });
		const noKey = await call(port, 'POST', '/setup/state', { ...base, origin: own }, '{}');
		expect(noKey.status).toBe(401);
		const wrong = await api('/setup/state', {}, { 'x-setup-secret': 'f'.repeat(64) });
		expect(wrong.status).toBe(401);
	});

	it('answers its own origin with the state — and never the token or the key', async () => {
		const { api, config } = await agent();
		const state = await api('/setup/state', {}, { 'sec-fetch-site': 'same-origin' });
		expect(state.status).toBe(200);
		expect(state.json).toMatchObject({
			agentVersion: 2,
			packaged: false,
			builtAt: null,
			origin: APP,
			pairing: 'not_open',
			printers: { receipt: null, kitchen: null }
		});
		expect(state.text).not.toContain(config.token);
		expect(state.text).not.toContain(config.setupSecret!);
		expect(state.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('a config without a setup key (written before the installer) disables every API route', async () => {
		const { port, own } = await agent({ noSecret: true });
		for (const path of [
			'/setup/state',
			'/setup/printers',
			'/setup/origin',
			'/setup/pairing',
			'/setup/rekey',
			'/setup/test-print',
			'/setup/quit'
		]) {
			const answer = await call(
				port,
				'POST',
				path,
				{ host: `127.0.0.1:${port}`, origin: own, 'content-type': 'application/json' },
				'{}'
			);
			expect(answer.status, path).toBe(403);
			expect(answer.json, path).toEqual({ error: 'setup_disabled' });
		}
	});

	it('the API is POST only', async () => {
		const { port, own } = await agent();
		const get = await call(port, 'GET', '/setup/state', { host: `127.0.0.1:${port}`, origin: own });
		expect(get.status).toBe(405);
	});
});

describe('the setup API routes', () => {
	it('/setup/printers saves the printers; a width change with a job waiting is 409', async () => {
		const down = await fakePrinter();
		await new Promise((r) => printers.pop()!.close(() => r(undefined)));
		const { api, configPath, runtime } = await agent();
		const set = await api('/setup/printers', {
			receipt: { host: '127.0.0.1', port: down.cfg.port, width: 48 },
			kitchen: null
		});
		expect(set.status).toBe(200);
		expect(JSON.parse(readFileSync(configPath, 'utf8')).printers.receipt).toEqual({
			host: '127.0.0.1',
			port: down.cfg.port,
			width: 48
		});
		await runtime.deps.submitJob({
			id: 'w1',
			printer: 'receipt',
			lines: [{ text: 'x' }],
			cut: true
		});
		const refused = await api('/setup/printers', {
			receipt: { host: '127.0.0.1', port: down.cfg.port, width: 32 }
		});
		expect(refused.status).toBe(409);
		expect(refused.json).toEqual({ error: 'jobs_waiting', target: 'receipt', queued: 1 });
		const bad = await api('/setup/printers', { receipt: { host: 'a b', width: 48 } });
		expect(bad.json).toEqual({ error: 'bad_printers', field: 'receipt.host' });
	});

	it('/setup/origin needs confirm; then the old origin is refused and pairing is open', async () => {
		const { port, api, config, configPath } = await agent();
		expect((await api('/setup/origin', { origin: 'https://new.example.com' })).status).toBe(422);
		expect(
			(await api('/setup/origin', { origin: 'http://evil.example', confirm: true })).json
		).toEqual({
			error: 'bad_origin_value'
		});
		const moved = await api('/setup/origin', { origin: 'https://new.example.com', confirm: true });
		expect(moved.status).toBe(200);
		expect(JSON.parse(readFileSync(configPath, 'utf8')).origin).toBe('https://new.example.com');
		expect(pairingState(config.dataDir)).toBe('open');
		const old = await call(port, 'GET', '/status', {
			host: `127.0.0.1:${port}`,
			origin: APP,
			authorization: `Bearer ${config.token}`
		});
		expect(old.status).toBe(403);
		expect(old.json).toEqual({ error: 'bad_origin' });
	});

	it('/setup/rekey replaces the token: the old one is refused, pairing opens', async () => {
		const { port, api, config, configPath } = await agent();
		expect((await api('/setup/rekey', {})).status).toBe(422);
		expect((await api('/setup/rekey', { confirm: true })).status).toBe(200);
		const token = JSON.parse(readFileSync(configPath, 'utf8')).token;
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(token).not.toBe(config.token);
		expect(pairingState(config.dataDir)).toBe('open');
		const old = await call(port, 'GET', '/status', {
			host: `127.0.0.1:${port}`,
			origin: APP,
			authorization: `Bearer ${config.token}`
		});
		expect(old.status).toBe(401);
	});

	it('/setup/pairing opens pairing', async () => {
		const { api, config } = await agent();
		expect((await api('/setup/pairing')).json).toEqual({ pairing: 'open' });
		expect(pairingState(config.dataDir)).toBe('open');
	});

	it('/setup/test-print: 503 with no printer; text only — never the drawer pulse — on a real printer', async () => {
		const empty = await agent();
		expect((await empty.api('/setup/test-print')).status).toBe(503);

		const printer = await fakePrinter();
		const { api } = await agent({ printers: { receipt: printer.cfg, kitchen: null } });
		const sent = await api('/setup/test-print');
		expect(sent.status).toBe(202);
		const start = Date.now();
		while (printer.jobs.length === 0 && Date.now() - start < 4000) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(printer.jobs).toHaveLength(1);
		const bytes = printer.jobs[0]!;
		expect(bytes.toString('latin1')).toContain('Test page');
		expect(bytes.includes(Buffer.from(DRAWER_PULSE))).toBe(false);
	});

	it('setupTestLines fits the paper and is printable ASCII', () => {
		for (const width of [32, 48] as const) {
			for (const line of setupTestLines(width, new Date('2026-10-10T09:05:00'))) {
				expect(line.text.length).toBeLessThanOrEqual(width);
				expect(line.text).toMatch(/^[\x20-\x7e]*$/);
			}
		}
		expect(setupTestLines(32).map((l) => l.text)).toContain('Paper: 58 mm (32)');
	});

	it('/setup/quit answers with its process id, then quits once', async () => {
		const { api, quits } = await agent();
		expect((await api('/setup/quit')).json).toEqual({ quitting: true, pid: process.pid });
		await new Promise((r) => setTimeout(r, 20));
		expect(quits()).toBe(1);
	});
});

describe('/setup/local-printers', () => {
	it("lists the printers the PC's print service knows, through the real runtime", async () => {
		const realExec = localIo.exec;
		localIo.exec = async (cmd, args) =>
			cmd === 'lpstat' && args[0] === '-p'
				? {
						status: 0,
						stdout:
							'printer SomStar-80mm-Series is idle.  enabled since Sat Oct 10 15:54:12 2026\n',
						stderr: ''
					}
				: { status: 127, stdout: '', stderr: 'not faked' };
		forgetLocalPrinters();
		try {
			const { api } = await agent();
			const listed = await api('/setup/local-printers');
			expect(listed.status).toBe(200);
			expect(listed.json).toEqual({ printers: [{ name: 'SomStar-80mm-Series', state: 'idle' }] });
		} finally {
			localIo.exec = realExec;
			forgetLocalPrinters();
		}
	});
});
