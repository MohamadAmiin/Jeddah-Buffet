import { describe, it, expect } from 'vitest';
import { minor } from './index';
import { formatAmount, formatMoney, moneyFormatFor, SUPPORTED_CURRENCIES } from './format';

// Not MANDATORY (spec 29): rendering a bigint as a string is none of spec 29's six
// areas, because this module does no arithmetic and no rounding. The tests are
// still required and ship with the code.

const usd = moneyFormatFor('USD');
const MINUS = '−';

// A seeded linear-congruential generator (Numerical Recipes constants), in bigint,
// so a failing generated case reproduces exactly.
function generator(seed: bigint) {
	let state = seed;
	return () => {
		state = (state * 1664525n + 1013904223n) % 4294967296n;
		return state;
	};
}

/**
 * The test's own parser, and deliberately not exported: nothing in the
 * application parses a formatted amount — form input arrives as digits and is
 * validated on the server.
 */
function parseBack(text: string): bigint {
	return BigInt(text.replaceAll(',', '').replace(MINUS, '-').replace('.', ''));
}

describe('formatAmount', () => {
	it('renders zero, a sub-unit amount, an ordinary one and a grouped one', () => {
		expect(formatAmount(minor(0n), usd)).toBe('0.00');
		expect(formatAmount(minor(5n), usd)).toBe('0.05');
		expect(formatAmount(minor(850n), usd)).toBe('8.50');
		expect(formatAmount(minor(123456789n), usd)).toBe('1,234,567.89');
	});

	it('puts a U+2212 minus sign on a negative, never a hyphen', () => {
		expect(formatAmount(minor(-850n), usd)).toBe('−8.50');
		expect(formatAmount(minor(-5n), usd)).toBe('−0.05');
		expect(formatAmount(minor(-123456789n), usd)).toBe('−1,234,567.89');
		expect(formatAmount(minor(-850n), usd)).not.toContain('-');
	});

	it('renders an exponent of 0 with no decimal point at all', () => {
		const whole = { code: 'XYZ', exponent: 0 };
		expect(formatAmount(minor(5n), whole)).toBe('5');
		expect(formatAmount(minor(-5n), whole)).toBe('−5');
		expect(formatAmount(minor(1234n), whole)).toBe('1,234');
	});

	it('refuses an exponent that is not a whole number', () => {
		expect(() => formatAmount(minor(5n), { code: 'XYZ', exponent: 1.5 })).toThrow(RangeError);
		expect(() => formatAmount(minor(5n), { code: 'XYZ', exponent: -1 })).toThrow(RangeError);
	});

	it('reads back as exactly the amount it was given, for 500 generated amounts', () => {
		const next = generator(35n);
		for (let i = 0; i < 500; i++) {
			const amount = ((next() * next()) % 200_000_001n) - 100_000_000n;
			expect(parseBack(formatAmount(minor(amount), usd))).toBe(amount);
		}
	});
});

describe('formatMoney', () => {
	it('appends a no-break space and the ISO code after the number', () => {
		expect(formatMoney(minor(850n), usd)).toBe('8.50 USD');
		expect(formatMoney(minor(-850n), usd)).toBe('−8.50 USD');
	});
});

describe('the currency table', () => {
	it('holds exactly the currency T-03 recorded: USD, exponent 2', () => {
		expect(Object.keys(SUPPORTED_CURRENCIES)).toEqual(['USD']);
		expect(moneyFormatFor('USD')).toEqual({ code: 'USD', exponent: 2 });
	});

	it('refuses a code it cannot render, rather than falling back', () => {
		expect(() => moneyFormatFor('ZZZ')).toThrow(RangeError);
		expect(() => moneyFormatFor('toString')).toThrow(RangeError);
	});
});
