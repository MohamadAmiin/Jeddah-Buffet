import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { addExact, exact, minor, roundToMinor, ROUNDING_RULE, sumExact } from './index';
import { formatTaxRate, parsePercentToBp, TAX_MODES, taxOnAmount, taxOnLine } from './tax';

// A seeded linear-congruential generator (Numerical Recipes constants), in bigint,
// so a failing generated case reproduces exactly. No property-testing library.
function generator(seed: bigint) {
	let state = seed;
	return () => {
		state = (state * 1664525n + 1013904223n) % 4294967296n;
		return state;
	};
}

function between(next: () => bigint, lo: bigint, hi: bigint): bigint {
	return lo + (next() % (hi - lo + 1n));
}

describe('tax in BOTH modes (spec 17)', () => {
	// MANDATORY (spec 29 — tax in both modes): spec 17's table, exclusive at 10%.
	it('exclusive: 1000 net at 10% is 100 tax on top, 1100 gross', () => {
		expect(taxOnLine(minor(1000n), 1000, 'exclusive')).toEqual({
			net: exact(1000n),
			tax: exact(100n),
			gross: exact(1100n)
		});
	});

	// MANDATORY (spec 29 — tax in both modes): spec 17's table, inclusive at 10%.
	// Both modes leave the customer paying 1100 and the revenue at 1000.
	it('inclusive: 1100 gross at 10% contains 100 tax on a 1000 net', () => {
		expect(taxOnLine(minor(1100n), 1000, 'inclusive')).toEqual({
			net: exact(1000n),
			tax: exact(100n),
			gross: exact(1100n)
		});
	});

	// MANDATORY (spec 29): spec 18's worked sale — subtotal $10, tax $1, total $11.
	it("matches spec 18's sale: burger 800 + drink 200 at 10% exclusive", () => {
		const lines = [minor(800n), minor(200n)].map((amount) => taxOnLine(amount, 1000, 'exclusive'));

		const tax = sumExact(lines.map((line) => line.tax));
		const total = sumExact(lines.map((line) => line.gross));

		expect(tax).toEqual(exact(100n));
		expect(total).toEqual(exact(1100n));
		expect(roundToMinor(total, ROUNDING_RULE)).toBe(1100n);
	});

	// MANDATORY (spec 29 — the rounding rule actually matters). This case is why
	// the module returns Exact rather than Minor.
	it('spec 17: full precision per line, rounded ONCE on the total — 83, not the per-line 82', () => {
		const lines = [333n, 333n, 334n].map((amount) => taxOnLine(minor(amount), 825, 'exclusive'));

		const perLine = lines
			.map((line) => roundToMinor(line.tax, ROUNDING_RULE))
			.reduce((total, value) => total + value, 0n);
		const total = sumExact(lines.map((line) => line.tax));

		expect(perLine).toBe(82n); // 27 + 27 + 28 — the defect
		expect(total).toEqual(exact(825000n, 10000n)); // 82.5, exactly
		expect(roundToMinor(total, 'half-up')).toBe(83n);
		expect(roundToMinor(total, 'half-even')).toBe(82n); // and it separates the rules
	});

	// MANDATORY (spec 29): a fractional line stays exact — nothing rounds inside.
	it('keeps a fractional exclusive tax exact: 2415 at 8.25% is 199.2375', () => {
		expect(taxOnLine(minor(2415n), 825, 'exclusive').tax).toEqual(exact(1992375n, 10000n));
	});

	// MANDATORY (spec 29 — property, inverse).
	it('splitting a gross into net and tax, then adding the tax back, returns the gross exactly', () => {
		const next = generator(18n);
		for (let i = 0; i < 500; i++) {
			const amount = between(next, 0n, 10_000_000n);
			const rateBp = Number(between(next, 0n, 10_000n));

			const { net } = taxOnLine(minor(amount), rateBp, 'inclusive');

			expect(taxOnAmount(net, rateBp, 'exclusive').gross).toEqual(exact(amount));
		}
	});

	// MANDATORY (spec 29 — property, internal consistency), in both modes.
	it('always has net + tax = gross, and keeps the amount where the mode says it is', () => {
		const next = generator(17n);
		for (let i = 0; i < 500; i++) {
			const amount = between(next, 0n, 10_000_000n);
			const rateBp = Number(between(next, 0n, 10_000n));
			for (const mode of TAX_MODES) {
				const { net, tax, gross } = taxOnLine(minor(amount), rateBp, mode);

				expect(addExact(net, tax)).toEqual(gross);
				if (mode === 'inclusive') expect(gross).toEqual(exact(amount));
				else expect(net).toEqual(exact(amount));
			}
		}
	});

	it('treats a zero rate as legal: no tax, gross equals net', () => {
		const { net, tax, gross } = taxOnLine(minor(1000n), 0, 'exclusive');
		expect(tax).toEqual(exact(0n));
		expect(gross).toEqual(net);
	});

	it('refuses a rate that is not whole basis points in 0..10000', () => {
		for (const rate of [8.25, -1, 10_001, Number.NaN]) {
			expect(() => taxOnLine(minor(1000n), rate, 'exclusive')).toThrow(TypeError);
		}
	});

	it('refuses an unset mode rather than picking one', () => {
		expect(() => taxOnLine(minor(1000n), 1000, null as never)).toThrow(TypeError);
	});
});

// MANDATORY (spec 29 — money arithmetic and rounding). Moved here from
// src/lib/pos/menu-view.ts by tasks/settings-tax-payments-receipt T-08.
describe('formatTaxRate — basis points to "x.xx%"', () => {
	it('renders basis points as a two-decimal percentage', () => {
		expect(formatTaxRate(825)).toBe('8.25%');
		expect(formatTaxRate(0)).toBe('0.00%');
		expect(formatTaxRate(10000)).toBe('100.00%');
		expect(formatTaxRate(5)).toBe('0.05%');
		expect(formatTaxRate(1050)).toBe('10.50%');
	});

	it('refuses a rate that is not whole basis points in 0..10000', () => {
		for (const rate of [8.25, -1, 10_001, Number.NaN]) {
			expect(() => formatTaxRate(rate)).toThrow(TypeError);
		}
	});
});

// MANDATORY (spec 29 — money arithmetic and rounding): the ONE parser of a rate
// an owner types as a percent. It never rounds, so it is never a second rounding
// site (invariant 7).
describe('parsePercentToBp — a rate typed as a percent', () => {
	it('accepts up to three whole digits and up to two decimals, as integer basis points', () => {
		const accepted: Array<[string, number]> = [
			['5', 500],
			['5.5', 550],
			['8.25', 825],
			['0', 0], // a 0% rate is legal
			['0.00', 0],
			['0.05', 5],
			['100', 10000],
			['100.00', 10000],
			[' 12.5 ', 1250], // trimmed
			['05', 500] // a leading zero is harmless
		];
		for (const [input, bp] of accepted) {
			expect(parsePercentToBp(input), JSON.stringify(input)).toBe(bp);
		}
	});

	it('refuses everything else with null, and never rounds a third decimal', () => {
		const refused = [
			'',
			'   ',
			'100.01', // above 100%
			'101',
			'1000',
			'-1',
			'+5',
			'5.255', // refused, NOT rounded to 526
			'5,5',
			'1e2',
			'.5',
			'5.',
			'5%',
			'abc',
			'０' // '０', a full-width digit: \d is ASCII 0-9 only
		];
		for (const input of refused) {
			expect(parsePercentToBp(input), JSON.stringify(input)).toBeNull();
		}
	});

	// Pins the dashboard's edit field, which shows a stored rate without its '%'.
	it('round-trips every legal rate through formatTaxRate without the %', () => {
		for (let bp = 0; bp <= 10_000; bp++) {
			expect(parsePercentToBp(formatTaxRate(bp).slice(0, -1))).toBe(bp);
		}
	});
});

describe('tax source tripwire', () => {
	// Math. is NOT forbidden here: formatTaxRate was moved verbatim and uses
	// Math.trunc on a RATE (basis points), which is not money. Money in this file
	// is bigint Exact arithmetic and never meets Math.
	it('uses no float, no Number() and imports only ./index', () => {
		const source = readFileSync(new URL('./tax.ts', import.meta.url), 'utf8');
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		// Import specifiers are read before string literals are blanked out.
		const froms = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		expect(froms).toEqual(['./index']);
		// A decimal inside a message string is not arithmetic; blank strings out.
		const bare = code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
		expect(bare).not.toMatch(/\bparseFloat\b/);
		expect(bare).not.toMatch(/\btoFixed\b/);
		expect(bare).not.toMatch(/\bNumber\(/);
		expect(bare).not.toMatch(/\b\d+\.\d+\b/);
	});
});
