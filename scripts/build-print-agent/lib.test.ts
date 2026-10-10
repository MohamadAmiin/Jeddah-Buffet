import { describe, expect, it } from 'vitest';
import { BUILD_SCRIPT_VERSION, buildKey, NODE_VERSION, OUTPUT_NAME, TARGETS } from './lib';

describe('the installer targets', () => {
	it('are exactly the four the plan names, each pinned to a SHA-256', () => {
		expect(TARGETS.map((t) => t.id)).toEqual([
			'linux-x64',
			'windows-x64',
			'macos-arm64',
			'macos-x64'
		]);
		for (const t of TARGETS) {
			expect(t.sha256, t.id).toMatch(/^[0-9a-f]{64}$/);
			expect(t.output, t.id).toMatch(OUTPUT_NAME);
			expect(t.archive.includes(NODE_VERSION.slice(1)) || t.archive === 'win-x64/node.exe').toBe(
				true
			);
		}
	});

	it('Windows ships a bare .exe; Linux and macOS ship zips (a browser drops the execute bit)', () => {
		expect(TARGETS.find((t) => t.id === 'windows-x64')!.output).toBe(
			'matcami-print-agent-windows-x64.exe'
		);
		for (const t of TARGETS.filter((t) => t.os !== 'windows')) expect(t.output).toMatch(/\.zip$/);
	});
});

describe('buildKey', () => {
	const base = {
		bundleSha: 'a'.repeat(64),
		origin: 'https://pos.example.com',
		nodeVersion: NODE_VERSION,
		scriptVersion: BUILD_SCRIPT_VERSION
	};

	it('is stable for the same inputs', () => {
		expect(buildKey(base)).toBe(buildKey({ ...base }));
		expect(buildKey(base)).toMatch(/^[0-9a-f]{64}$/);
	});

	it.each([
		['bundleSha', { bundleSha: 'b'.repeat(64) }],
		['origin', { origin: 'https://other.example.com' }],
		['nodeVersion', { nodeVersion: 'v24.22.0' }],
		['scriptVersion', { scriptVersion: BUILD_SCRIPT_VERSION + 1 }]
	])('changes when %s changes', (_name, over) => {
		expect(buildKey({ ...base, ...over })).not.toBe(buildKey(base));
	});
});
