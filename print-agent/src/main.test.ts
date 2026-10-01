import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { DEFAULT_CONFIG_PATH, DEFAULT_DATA_DIR, pairingLink, parseFlags, runInit } from './main.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'matcami-agent-cli-'));
	dirs.push(dir);
	return dir;
};

// The README's own command line (section 3), split the way a shell would.
const README_INIT = [
	'init',
	'--origin',
	'https://pos.example.com',
	'--receipt',
	'192.168.10.50',
	'--width',
	'48',
	'--kitchen',
	'192.168.10.51',
	'--kitchen-width',
	'32'
];

describe('parseFlags', () => {
	it("reads the README's init command line", () => {
		expect(parseFlags(README_INIT)).toEqual({
			command: 'init',
			flags: {
				origin: 'https://pos.example.com',
				receipt: '192.168.10.50',
				width: '48',
				kitchen: '192.168.10.51',
				'kitchen-width': '32'
			}
		});
	});

	it('reads a bare flag as true, keeps the last of a repeated flag, and refuses a second command', () => {
		expect(parseFlags(['run', '--config', '/a', '--config', '/b'])).toEqual({
			command: 'run',
			flags: { config: '/b' }
		});
		expect(parseFlags(['init', '--force', '--origin', 'https://x.example'])).toEqual({
			command: 'init',
			flags: { force: true, origin: 'https://x.example' }
		});
		expect(parseFlags(['--help'])).toEqual({ command: null, flags: { help: true } });
		expect(() => parseFlags(['init', 'extra'])).toThrow(/unexpected argument "extra"/);
	});
});

describe('runInit', () => {
	it('writes the config the README describes, with a fresh token, mode 0600', () => {
		const path = join(tmp(), 'config.json');
		const { flags } = parseFlags([...README_INIT, '--config', path]);
		const { path: written, config } = runInit(flags);
		expect(written).toBe(path);
		expect(config).toEqual({
			origin: 'https://pos.example.com',
			token: config.token,
			port: 9471,
			printers: {
				receipt: { host: '192.168.10.50', port: 9100, width: 48 },
				kitchen: { host: '192.168.10.51', port: 9100, width: 32 }
			},
			dataDir: DEFAULT_DATA_DIR
		});
		expect(config.token).toMatch(/^[0-9a-f]{64}$/);
		expect(loadConfig(path)).toEqual(config);
		if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('the kitchen width defaults to the receipt width; --port and host:port are read', () => {
		const path = join(tmp(), 'config.json');
		const { config } = runInit(
			parseFlags([
				'init',
				'--origin',
				'https://pos.example.com',
				'--receipt',
				'10.0.0.5:9101',
				'--width',
				'32',
				'--kitchen',
				'kitchen.local',
				'--port',
				'9500',
				'--config',
				path
			]).flags
		);
		expect(config.port).toBe(9500);
		expect(config.printers.receipt).toEqual({ host: '10.0.0.5', port: 9101, width: 32 });
		expect(config.printers.kitchen).toEqual({ host: 'kitchen.local', port: 9100, width: 32 });
	});

	it('names the missing or wrong flag, and refuses to overwrite without --force', () => {
		const path = join(tmp(), 'config.json');
		const base = ['init', '--receipt', '10.0.0.5', '--width', '48', '--config', path];
		expect(() => runInit(parseFlags(base).flags)).toThrow(/--origin is required/);
		expect(() =>
			runInit(parseFlags(['init', '--origin', 'https://x.example', '--width', '48']).flags)
		).toThrow(/--receipt is required/);
		expect(() =>
			runInit(parseFlags(['init', '--origin', 'https://x.example', '--receipt', '10.0.0.5']).flags)
		).toThrow(/--width is required/);
		const good = [...base, '--origin', 'https://x.example'];
		expect(() => runInit(parseFlags([...good, '--width', '40']).flags)).toThrow(/32 or 48/);
		expect(() => runInit(parseFlags([...good, '--port', 'abc']).flags)).toThrow(/port/);
		const first = runInit(parseFlags(good).flags).config;
		expect(() => runInit(parseFlags(good).flags)).toThrow(/already exists/);
		const second = runInit(parseFlags([...good, '--force']).flags).config;
		expect(second.token).not.toBe(first.token);
	});

	it('the default paths sit beside src/, inside print-agent/', () => {
		expect(DEFAULT_CONFIG_PATH).toMatch(/print-agent[\\/]config\.json$/);
		expect(DEFAULT_DATA_DIR).toMatch(/print-agent[\\/]data$/);
	});
});

describe('pairingLink', () => {
	const token = 'ab'.repeat(32);

	it("is the app's Printer screen with the agent address and the secret in the fragment", () => {
		// The exact shape src/lib/pos/print-client.test.ts parses.
		expect(pairingLink({ origin: 'https://pos.example.com', token, port: 9471 })).toBe(
			`https://pos.example.com/pos/printer#agent=http%3A%2F%2F127.0.0.1%3A9471&token=${token}`
		);
	});

	it('keeps the secret out of everything a browser sends to a server', () => {
		const link = new URL(pairingLink({ origin: 'http://localhost:5173', token, port: 9500 }));
		expect(link.origin).toBe('http://localhost:5173');
		expect(link.pathname).toBe('/pos/printer');
		expect(link.search).toBe('');
		expect(new URLSearchParams(link.hash.slice(1)).get('agent')).toBe('http://127.0.0.1:9500');
		expect(new URLSearchParams(link.hash.slice(1)).get('token')).toBe(token);
	});

	it('follows the config init wrote', () => {
		const path = join(tmp(), 'config.json');
		const { config } = runInit(parseFlags([...README_INIT, '--config', path]).flags);
		expect(pairingLink(loadConfig(path))).toBe(
			`https://pos.example.com/pos/printer#agent=http%3A%2F%2F127.0.0.1%3A9471&token=${config.token}`
		);
	});
});
