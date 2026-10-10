import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig, saveConfig } from './config.ts';
import { claimPairing, openPairing, pairingState } from './pairing.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import { createAgentServer, listen } from './server.ts';
import { SETUP_CSS, SETUP_HTML, SETUP_JS } from './setup-page.ts';
import { createSetupHandler } from './setup.ts';

describe('the page obeys the CSP setup.ts sends', () => {
	it('the HTML carries no inline script, no event-handler attribute and no inline style', () => {
		expect(SETUP_HTML).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
		expect(SETUP_HTML).not.toMatch(/\son[a-z]+=/i);
		expect(SETUP_HTML).not.toMatch(/\sstyle=/i);
		expect(SETUP_HTML).toContain('<script src="/setup.js" defer></script>');
		expect(SETUP_HTML).toContain('<link rel="stylesheet" href="/setup.css">');
	});

	it('the stylesheet holds no colour literal — only system colours', () => {
		expect(SETUP_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(SETUP_CSS).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|lab|lch)\(/i);
		expect(SETUP_CSS).toContain('Canvas');
		expect(SETUP_CSS).toContain('color-scheme: light dark');
	});
});

describe('the script', () => {
	it('is valid JavaScript (String.raw kept its regular expressions intact)', () => {
		expect(() => new Function(SETUP_JS)).not.toThrow();
		expect(SETUP_JS).toContain('/^(.+?)(?::(\\d{1,5}))?$/');
		expect(SETUP_JS).not.toContain('`');
	});

	it('talks only to the setup API, with the key header, and never uses localStorage', () => {
		expect(SETUP_JS).toContain('/setup/state');
		expect(SETUP_JS).toContain('X-Setup-Secret');
		expect(SETUP_JS).not.toContain('localStorage');
		expect(SETUP_JS).not.toMatch(/fetch\(\s*['"]https?:/);
		for (const path of SETUP_JS.match(/api\('([^']+)'/g) ?? []) {
			expect(path).toMatch(/^api\('\/setup\//);
		}
		expect(SETUP_JS).not.toContain('innerHTML');
	});

	it('every element it reaches for exists in the page', () => {
		const ids = [...SETUP_JS.matchAll(/\$\('([A-Za-z]+)'\)/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(10);
		for (const id of new Set(ids)) expect(SETUP_HTML, id).toContain(`id="${id}"`);
	});

	it('pairs every status with a glyph and words', () => {
		for (const glyph of ['●', '◆', '○', '✕']) expect(SETUP_JS).toContain(glyph);
	});
});

describe('served by the real agent', () => {
	const cleanup: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step();
	});

	it('GET /setup.js and /setup.css answer the strings above', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'matcami-setup-page-'));
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const configPath = join(dir, 'config.json');
		const config = createConfig({ origin: 'https://pos.example.com', dataDir: join(dir, 'data') });
		saveConfig(configPath, config);
		const runtime: Runtime = createRuntime({ configPath, config });
		cleanup.push(() => runtime.close());
		const server: Server = createAgentServer(runtime.config, {
			...runtime.deps,
			claimPairing: () => claimPairing(config.dataDir),
			setup: createSetupHandler({
				runtime,
				openPairing: () => openPairing(config.dataDir),
				pairingState: () => pairingState(config.dataDir),
				rekey: async () => {},
				quit: () => {},
				page: { html: SETUP_HTML, js: SETUP_JS, css: SETUP_CSS }
			})
		});
		cleanup.push(() => new Promise((r) => server.close(() => r())));
		const port = await listen(server, 0);
		const get = (path: string) =>
			new Promise<{ type: string; text: string }>((resolve, reject) => {
				const req = httpRequest(
					{ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } },
					(res) => {
						const chunks: Buffer[] = [];
						res.on('data', (c: Buffer) => chunks.push(c));
						res.on('end', () =>
							resolve({
								type: String(res.headers['content-type']),
								text: Buffer.concat(chunks).toString('utf8')
							})
						);
					}
				);
				req.on('error', reject);
				req.end();
			});
		const js = await get('/setup.js');
		expect(js.type).toBe('text/javascript; charset=utf-8');
		expect(js.text).toBe(SETUP_JS);
		const css = await get('/setup.css');
		expect(css.type).toBe('text/css; charset=utf-8');
		expect(css.text).toBe(SETUP_CSS);
		const html = await get('/setup');
		expect(html.text).toBe(SETUP_HTML);
	});
});
