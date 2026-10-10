import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	firstRunSteps,
	guessPlatform,
	isDownloadFile,
	osLabel,
	recommend,
	shortOsLabel,
	sizeLabel,
	type DownloadFile
} from './print-agent-download';

const FILE = (name: string, os: DownloadFile['os'], arch: DownloadFile['arch']): DownloadFile => ({
	name,
	os,
	arch,
	bytes: 1,
	sha256: 'a'.repeat(64),
	verified: os !== 'macos',
	url: `/downloads/print-agent/${name}`
});
const FILES = [
	FILE('matcami-print-agent-linux-x64.zip', 'linux', 'x64'),
	FILE('matcami-print-agent-windows-x64.exe', 'windows', 'x64'),
	FILE('matcami-print-agent-macos-x64.zip', 'macos', 'x64'),
	FILE('matcami-print-agent-macos-arm64.zip', 'macos', 'arm64')
];

describe('which installer the till recommends (print-agent-installer T-15)', () => {
	it('Windows Chrome → the .exe first', () => {
		const platform = guessPlatform({
			userAgent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
			userAgentData: { platform: 'Windows' }
		});
		expect(platform).toBe('windows');
		expect(recommend(FILES, platform).primary.map((f) => f.name)).toEqual([
			'matcami-print-agent-windows-x64.exe'
		]);
	});

	it('a Mac → BOTH Mac zips, Apple silicon first; the rest under others', () => {
		const platform = guessPlatform({
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
		});
		expect(platform).toBe('macos');
		const { primary, others } = recommend(FILES, platform);
		expect(primary.map((f) => f.arch)).toEqual(['arm64', 'x64']);
		expect(others.map((f) => f.os)).toEqual(['linux', 'windows']);
	});

	it('X11 Linux → the Linux zip', () => {
		const platform = guessPlatform({
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142'
		});
		expect(platform).toBe('linux');
		expect(recommend(FILES, platform).primary.map((f) => f.os)).toEqual(['linux']);
	});

	it('an empty or phone user agent → unknown, every file under others', () => {
		expect(guessPlatform({ userAgent: '' })).toBe('unknown');
		expect(
			guessPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/142' })
		).toBe('unknown');
		expect(recommend(FILES, 'unknown')).toEqual({ primary: [], others: FILES });
	});

	it('labels the till keys and checks every manifest entry before it becomes a link', () => {
		expect(shortOsLabel('macos', 'arm64')).toBe('Mac (Apple silicon)');
		expect(shortOsLabel('macos', 'x64')).toBe('Mac (Intel)');
		expect(shortOsLabel('windows', 'x64')).toBe('Windows');
		for (const file of FILES) expect(isDownloadFile(file)).toBe(true);
		expect(isDownloadFile({ ...FILES[0], url: 'https://evil.example/x.exe' })).toBe(false);
		expect(isDownloadFile({ ...FILES[0], os: 'plan9' })).toBe(false);
		expect(isDownloadFile({ ...FILES[0], sha256: 'x' })).toBe(false);
		expect(isDownloadFile(null)).toBe(false);
	});
});

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
