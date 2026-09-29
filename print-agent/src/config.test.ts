import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initConfig, loadConfig, parseConfig, parseOrigin, parsePrinterAddress } from './config.ts';

const complete = {
	origin: 'https://pos.example.com',
	token: 'a'.repeat(64),
	port: 9471,
	printers: {
		receipt: { host: '192.168.1.50', port: 9100, width: 48 },
		kitchen: { host: 'kitchen.local', port: 9100, width: 32 }
	},
	dataDir: '/var/lib/matcami-agent'
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'matcami-agent-'));
	dirs.push(dir);
	return dir;
};

describe('parseConfig', () => {
	it('accepts a complete config and normalises the origin', () => {
		const parsed = parseConfig({ ...complete, origin: 'https://pos.example.com/' });
		expect(parsed).toEqual(complete);
		expect(
			parseConfig({ ...complete, printers: { receipt: complete.printers.receipt } }).printers
				.kitchen
		).toBeNull();
	});

	it.each([
		[{ origin: 'ftp://x' }, /origin/],
		[{ origin: 'http://pos.example.com' }, /origin/],
		[{ origin: 'https://pos.example.com/pos' }, /origin/],
		[{ token: 'abc' }, /token/],
		[{ token: 'A'.repeat(64) }, /token/],
		[{ port: 80 }, /port/],
		[{ port: 9471.5 }, /port/],
		[
			{ printers: { receipt: { ...complete.printers.receipt, width: 40 } } },
			/printers\.receipt\.width/
		],
		[
			{ printers: { receipt: { ...complete.printers.receipt, host: '' } } },
			/printers\.receipt\.host/
		],
		[
			{ printers: { receipt: { ...complete.printers.receipt, host: '10.0.0.1/24' } } },
			/printers\.receipt\.host/
		],
		[
			{ printers: { receipt: { ...complete.printers.receipt, port: 0 } } },
			/printers\.receipt\.port/
		],
		[{ dataDir: '' }, /dataDir/]
	])('refuses %j naming the field', (over, message) => {
		expect(() => parseConfig({ ...complete, ...over })).toThrow(message);
	});

	it('allows http only for localhost and 127.0.0.1 (tests, a LAN trial)', () => {
		expect(parseOrigin('http://localhost:4173')).toBe('http://localhost:4173');
		expect(parseOrigin('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173');
		expect(() => parseOrigin('http://192.168.1.5:5173')).toThrow(/https/);
	});
});

describe('parsePrinterAddress', () => {
	it('reads host[:port] with 9100 as the default port', () => {
		expect(parsePrinterAddress('192.168.1.50', 48)).toEqual({
			host: '192.168.1.50',
			port: 9100,
			width: 48
		});
		expect(parsePrinterAddress('kitchen.local:9101', 32)).toEqual({
			host: 'kitchen.local',
			port: 9101,
			width: 32
		});
		expect(() => parsePrinterAddress('', 32)).toThrow();
	});
});

describe('initConfig', () => {
	it('writes a config with a fresh 64-hex token, and refuses to overwrite without force', () => {
		const dir = tmp();
		const path = join(dir, 'config.json');
		const written = initConfig(path, {
			origin: 'https://pos.example.com',
			receipt: { host: '192.168.1.50', port: 9100, width: 48 },
			dataDir: join(dir, 'data')
		});
		expect(written.token).toMatch(/^[0-9a-f]{64}$/);
		expect(written.port).toBe(9471);
		expect(written.printers.kitchen).toBeNull();
		const onDisk = loadConfig(path);
		expect(onDisk).toEqual(written);

		expect(() =>
			initConfig(path, {
				origin: 'https://other.example.com',
				receipt: { host: '10.0.0.9', port: 9100, width: 32 },
				dataDir: join(dir, 'data')
			})
		).toThrow(/already exists/);
		expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(written, null, '\t') + '\n');

		const replaced = initConfig(path, {
			origin: 'https://other.example.com',
			receipt: { host: '10.0.0.9', port: 9100, width: 32 },
			dataDir: join(dir, 'data'),
			force: true
		});
		expect(replaced.origin).toBe('https://other.example.com');
		expect(replaced.token).not.toBe(written.token);
	});

	it.skipIf(process.platform === 'win32')(
		'the file holding the token is mode 0600 — on a fresh write AND on --force over a looser file',
		() => {
			const dir = tmp();
			const fresh = join(dir, 'fresh.json');
			const args = {
				origin: 'https://pos.example.com',
				receipt: { host: '192.168.1.50', port: 9100, width: 48 as const },
				dataDir: join(dir, 'data')
			};
			initConfig(fresh, args);
			expect(statSync(fresh).mode & 0o777).toBe(0o600);

			// Copied from the example or written by hand: world-readable under the usual umask.
			const loose = join(dir, 'loose.json');
			writeFileSync(loose, '{}');
			chmodSync(loose, 0o644);
			expect(statSync(loose).mode & 0o777).toBe(0o644);
			const rekeyed = initConfig(loose, { ...args, force: true });
			expect(statSync(loose).mode & 0o777).toBe(0o600);
			expect(loadConfig(loose).token).toBe(rekeyed.token);
		}
	);

	it('loadConfig names a missing file and invalid JSON', () => {
		const dir = tmp();
		expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/cannot read/);
		const bad = join(dir, 'bad.json');
		writeFileSync(bad, '{not json');
		expect(() => loadConfig(bad)).toThrow(/not valid JSON/);
	});
});
