import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { minor } from './index';
import { changeDue, quickTenders } from './change';

function generator(seed: bigint) {
	let state = seed;
	return () => {
		state = (state * 1664525n + 1013904223n) & 0xffffffffn;
		return state;
	};
}
function between(next: () => bigint, lo: bigint, hi: bigint): bigint {
	const span = hi - lo + 1n;
	return lo + (next() % span);
}

describe('changeDue', () => {
	it('subtracts the total from the tender', () => {
		expect(changeDue(minor(2000n), minor(1237n))).toBe(763n);
		expect(changeDue(minor(1237n), minor(1237n))).toBe(0n);
		expect(changeDue(minor(3000n), minor(2750n))).toBe(250n);
	});

	it('refuses a shortfall with RangeError', () => {
		expect(() => changeDue(minor(1000n), minor(1237n))).toThrow(RangeError);
	});
});

describe('quickTenders', () => {
	it('offers the total then rounded-up cash keys', () => {
		expect(quickTenders(minor(1237n), 2)).toEqual([1237n, 1300n, 1500n, 2000n]);
	});

	it('de-duplicates when steps coincide', () => {
		// 2750 → 2800 (100), 3000 (500), 3000 (1000) — the last two coincide.
		expect(quickTenders(minor(2750n), 2)).toEqual([2750n, 2800n, 3000n]);
	});

	it('a round total still gets strictly-above keys', () => {
		expect(quickTenders(minor(2000n), 2)).toEqual([2000n, 2100n, 2500n, 3000n]);
	});

	it('zero total returns [0n]', () => {
		expect(quickTenders(minor(0n), 2)).toEqual([0n]);
	});

	it('exponent 0 (a zero-decimal currency)', () => {
		expect(quickTenders(minor(1237n), 0)).toEqual([1237n, 1238n, 1240n]);
	});

	it('de-duplication at exponent 2', () => {
		expect(quickTenders(minor(1700n), 2)).toEqual([1700n, 1800n, 2000n]);
		expect(quickTenders(minor(99n), 2)).toEqual([99n, 100n, 500n, 1000n]);
	});

	it('refuses a negative total, a non-integer exponent and a negative exponent', () => {
		expect(() => quickTenders(minor(-1n), 2)).toThrow(RangeError);
		expect(() => quickTenders(minor(100n), 1.5)).toThrow(RangeError);
		expect(() => quickTenders(minor(100n), -1)).toThrow(RangeError);
	});
});

describe('quickTenders — property test', () => {
	it('every entry is strictly above or equal to the total and change is non-negative', () => {
		const next = generator(20260928n);
		for (let i = 0; i < 500; i++) {
			const total = minor(between(next, 1n, 10_000_000n));
			const exponent = Number(between(next, 0n, 3n));
			const result = quickTenders(total, exponent);
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result.length).toBeLessThanOrEqual(4);
			expect(result[0]).toBe(total);
			for (let j = 1; j < result.length; j++) {
				expect(result[j]).toBeGreaterThan(total);
				expect(result[j]).toBeGreaterThan(result[j - 1]);
			}
			for (const t of result) {
				const change = changeDue(t, total);
				expect(change).toBeGreaterThanOrEqual(0n);
				expect(t - change).toBe(total);
			}
		}
	});
});

describe('change source tripwire', () => {
	it('imports only ./index and does no float arithmetic', () => {
		const source = readFileSync(new URL('./change.ts', import.meta.url), 'utf8');
		const stripped = source
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1');
		expect(stripped).not.toMatch(/\bNumber\(/);
		expect(stripped).not.toMatch(/\bparseFloat\b/);
		expect(stripped).not.toMatch(/\btoFixed\b/);
		expect(stripped).not.toMatch(/\bMath\./);
		expect(stripped).not.toMatch(/\d\.\d/);
		const froms = [...stripped.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		expect(froms).toEqual(['./index']);
	});
});
