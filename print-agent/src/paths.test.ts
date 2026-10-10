import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bakedBuild, defaultPaths, installDir, isPackaged, selfCommand } from './paths.ts';

describe('installDir — the per-user folder a packaged agent installs into', () => {
	it('Windows: under %LOCALAPPDATA%, built with Windows separators on any host', () => {
		expect(
			installDir('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a')
		).toBe(win32.join('C:\\Users\\a\\AppData\\Local', 'matcami', 'print-agent'));
	});

	it('Windows without LOCALAPPDATA falls back to the profile’s AppData\\Local', () => {
		expect(installDir('win32', {}, 'C:\\Users\\a')).toBe(
			'C:\\Users\\a\\AppData\\Local\\matcami\\print-agent'
		);
	});

	it('macOS: Application Support', () => {
		expect(installDir('darwin', {}, '/Users/a')).toBe(
			'/Users/a/Library/Application Support/matcami/print-agent'
		);
	});

	it('Linux: $XDG_DATA_HOME, else ~/.local/share', () => {
		expect(installDir('linux', { XDG_DATA_HOME: '/x' }, '/home/a')).toBe('/x/matcami/print-agent');
		expect(installDir('linux', {}, '/home/a')).toBe('/home/a/.local/share/matcami/print-agent');
	});
});

describe('running from source (vitest)', () => {
	it('is not packaged and carries no baked build', () => {
		expect(isPackaged()).toBe(false);
		expect(bakedBuild()).toBeNull();
	});

	it('keeps config.json and data/ beside src/, as before', () => {
		const { configPath, dataDir } = defaultPaths();
		expect(configPath).toMatch(/print-agent[\\/]config\.json$/);
		expect(dataDir).toMatch(/print-agent[\\/]data$/);
	});

	it('relaunches itself as node plus main.ts', () => {
		const { command, args } = selfCommand(['run', '--supervise']);
		expect(command).toBe(process.execPath);
		expect(args.slice(-3)[0]).toMatch(/print-agent[\\/]src[\\/]main\.ts$/);
		expect(args.slice(-2)).toEqual(['run', '--supervise']);
	});
});
