import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ConfigMissingError,
	createConfig,
	initConfig,
	loadConfig,
	parseConfig,
	parseOrigin,
	isLocalPrinter,
	parsePrinter,
	parsePrinterAddress,
	printerLabel,
	saveConfig,
	writeFileAtomic,
	writeSeam
} from './config.ts';

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
		expect(parsed).toEqual({ ...complete, setupSecret: null });
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

	it("still reads the e2e harness's config (written before the installer: no setupSecret)", () => {
		// e2e/print-agent-harness.ts writeAgentConfig, verbatim in shape.
		const harness = {
			origin: 'http://localhost:4173',
			token: 'b'.repeat(64),
			port: 9512,
			printers: {
				receipt: { host: '127.0.0.1', port: 9513, width: 32 },
				kitchen: { host: '127.0.0.1', port: 9514, width: 48 }
			},
			dataDir: '/tmp/x/data'
		};
		const parsed = parseConfig(harness);
		expect(parsed.setupSecret).toBeNull();
		expect(parsed.printers).toEqual(harness.printers);
	});

	it('a config with no printer yet is valid; a kitchen printer without a receipt printer is not', () => {
		expect(
			parseConfig({ ...complete, printers: { receipt: null, kitchen: null } }).printers
		).toEqual({ receipt: null, kitchen: null });
		expect(parseConfig({ ...complete, printers: {} }).printers).toEqual({
			receipt: null,
			kitchen: null
		});
		expect(() =>
			parseConfig({ ...complete, printers: { receipt: null, kitchen: complete.printers.kitchen } })
		).toThrow('config: printers.kitchen needs a receipt printer first');
	});

	it('the setup key, when present, is 64 lowercase hex', () => {
		expect(parseConfig({ ...complete, setupSecret: 'c'.repeat(64) }).setupSecret).toBe(
			'c'.repeat(64)
		);
		expect(() => parseConfig({ ...complete, setupSecret: 'XYZ' })).toThrow(/setupSecret/);
		expect(() => parseConfig({ ...complete, setupSecret: 'C'.repeat(64) })).toThrow(/setupSecret/);
	});
});

describe('createConfig and saveConfig', () => {
	it('mints a pairing token and a setup key — two different secrets — and no printers', () => {
		const config = createConfig({ origin: 'https://pos.example.com', dataDir: '/tmp/d' });
		expect(config.token).toMatch(/^[0-9a-f]{64}$/);
		expect(config.setupSecret).toMatch(/^[0-9a-f]{64}$/);
		expect(config.setupSecret).not.toBe(config.token);
		expect(config.printers).toEqual({ receipt: null, kitchen: null });
		expect(config.port).toBe(9471);
	});

	it.skipIf(process.platform === 'win32')(
		'saves at mode 0600, leaves no temporary file, and reads back equal',
		() => {
			const dir = tmp();
			const path = join(dir, 'config.json');
			const config = createConfig({ origin: 'https://pos.example.com', dataDir: join(dir, 'd') });
			saveConfig(path, config);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
			expect(loadConfig(path)).toEqual(config);
		}
	);

	it('refuses to save a config that would not load', () => {
		const dir = tmp();
		const config = createConfig({ origin: 'https://pos.example.com', dataDir: join(dir, 'd') });
		expect(() => saveConfig(join(dir, 'c.json'), { ...config, port: 1 })).toThrow(/port/);
	});
});

describe('writeFileAtomic', () => {
	it('a write that fails before the rename leaves the old file untouched and no temporary file', () => {
		const dir = tmp();
		const path = join(dir, 'config.json');
		writeFileSync(path, 'OLD CONTENT');
		const spy = vi.spyOn(writeSeam, 'renameSync').mockImplementation(() => {
			throw new Error('power cut');
		});
		try {
			expect(() => writeFileAtomic(path, 'NEW CONTENT')).toThrow('power cut');
		} finally {
			spy.mockRestore();
		}
		expect(readFileSync(path, 'utf8')).toBe('OLD CONTENT');
		expect(readdirSync(dir)).toEqual(['config.json']);
	});

	it('replaces an existing file', () => {
		const dir = tmp();
		const path = join(dir, 'f.json');
		writeFileSync(path, 'a');
		writeFileAtomic(path, 'b');
		expect(readFileSync(path, 'utf8')).toBe('b');
		expect(readdirSync(dir)).toEqual(['f.json']);
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

	it('local:<name> is a printer this PC knows (feat/local-printers)', () => {
		expect(parsePrinterAddress('local:SomStar-80mm-Series', 48)).toEqual({
			name: 'SomStar-80mm-Series',
			width: 48
		});
		expect(parsePrinterAddress(' local:Front Desk ', 32)).toEqual({
			name: 'Front Desk',
			width: 32
		});
		expect(() => parsePrinterAddress('local:', 32)).toThrow(/printer\.name/);
	});
});

describe('a printer on this PC in the config (feat/local-printers)', () => {
	it('is { name, width }, refuses a name that is empty, too long, not a string or has control characters, and never both kinds', () => {
		expect(parsePrinter({ name: ' SomStar-80mm-Series ', width: 48 }, 'printers.receipt')).toEqual({
			name: 'SomStar-80mm-Series',
			width: 48
		});
		for (const name of [
			'',
			'   ',
			'-Till',
			' -Till',
			'SomStar/draft',
			'x'.repeat(121),
			'a\nb',
			'a\x7fb',
			42,
			true
		]) {
			expect(() => parsePrinter({ name, width: 48 }, 'printers.receipt')).toThrow(
				/printers\.receipt\.name/
			);
		}
		expect(() =>
			parsePrinter({ name: 'SomStar', host: '10.0.0.1', width: 48 }, 'printers.receipt')
		).toThrow(/printers\.receipt\.name/);
		expect(() =>
			parsePrinter({ name: 'SomStar', port: 9100, width: 48 }, 'printers.receipt')
		).toThrow(/printers\.receipt\.name/);
		expect(isLocalPrinter({ name: 'SomStar', width: 48 })).toBe(true);
		expect(isLocalPrinter({ host: '10.0.0.1', port: 9100, width: 48 })).toBe(false);
		expect(printerLabel({ name: 'SomStar', width: 48 })).toBe('local:SomStar');
		expect(printerLabel({ host: '10.0.0.1', port: 9100, width: 48 })).toBe('10.0.0.1:9100');
	});

	it('round-trips through the file, and an older file with host/port still reads as a network printer', () => {
		const path = join(tmp(), 'config.json');
		const config = parseConfig({
			...complete,
			printers: { receipt: { name: 'SomStar-80mm-Series', width: 48 }, kitchen: null }
		});
		saveConfig(path, config);
		expect(loadConfig(path).printers).toEqual({
			receipt: { name: 'SomStar-80mm-Series', width: 48 },
			kitchen: null
		});
		expect(parseConfig(complete).printers.receipt).toEqual(complete.printers.receipt);
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

	it('a MISSING config is a ConfigMissingError; a corrupt one is not (the installer tells them apart)', () => {
		const dir = tmp();
		expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(ConfigMissingError);
		const bad = join(dir, 'bad.json');
		writeFileSync(bad, '{');
		let thrown: unknown;
		try {
			loadConfig(bad);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(ConfigMissingError);
		expect(String(thrown)).toMatch(/not valid JSON/);
	});
});
