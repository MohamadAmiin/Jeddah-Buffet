import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firstRunSteps, osLabel, sizeLabel } from './print-agent-download';

describe('the words beside the print agent downloads (print-agent-installer T-13)', () => {
	it('names each PC in the owner’s words', () => {
		expect(osLabel('windows', 'x64')).toBe('Windows 10 or 11 (64-bit)');
		expect(osLabel('linux', 'x64')).toBe('Linux (64-bit)');
		expect(osLabel('macos', 'arm64')).toBe('Mac with Apple silicon (M1 or later)');
		expect(osLabel('macos', 'x64')).toBe('Mac with Intel');
	});

	it('says how to get an unsigned file past each OS on its first run', () => {
		expect(firstRunSteps('windows').join(' ')).toMatch(/More info → Run anyway/);
		expect(firstRunSteps('macos').join(' ')).toMatch(/Open Anyway/);
		expect(firstRunSteps('linux').join(' ')).toMatch(/allow executing/);
		for (const os of ['windows', 'macos', 'linux'] as const) {
			expect(firstRunSteps(os).at(-1)).toMatch(/Printer → Pair this till/);
		}
	});

	it('rounds a size to whole megabytes', () => {
		expect(sizeLabel(44_294_855)).toBe('42 MB');
		expect(sizeLabel(93_796_864)).toBe('89 MB');
		expect(sizeLabel(10)).toBe('1 MB');
	});

	// The isomorphic rule: no sibling, no $lib, no Node builtin — comments stripped
	// first, because the header talks about importing.
	it('imports nothing', () => {
		const source = readFileSync(new URL('./print-agent-download.ts', import.meta.url), 'utf8');
		const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		expect(stripped).not.toMatch(/^\s*import\b/m);
		expect(stripped).not.toMatch(/\bfrom\s+['"]/);
		expect(stripped).not.toMatch(/\bimport\(/);
		expect(stripped).not.toMatch(/\brequire\(/);
	});
});
