import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
	createCategorySchema,
	createItemSchema,
	formatTaxRate,
	parseOptionalRate,
	parsePriceInput
} from './helpers';

// MANDATORY (spec 29 — money arithmetic and rounding): the ONE place a typed
// price becomes minor units.
describe('parsePriceInput — THE price parser', () => {
	it.each([
		['8.50', 850n],
		['8.5', 850n],
		['0.05', 5n],
		['1000', 100000n],
		['0', 0n],
		['  8.50  ', 850n]
	])('reads %j at exponent 2 as %s', (raw, expected) => {
		expect(parsePriceInput(raw, 2)).toEqual({ ok: true, minor: expected });
	});

	it.each(['8.505', '8,50', '', '-1', '1e2', '８.５０', 'abc', '8.', '.5', '1 000'])(
		'rejects %j at exponent 2 with a message, never a coercion',
		(raw) => {
			const result = parsePriceInput(raw, 2);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
		}
	);

	it('reads whole units at exponent 0, and rejects a decimal there', () => {
		expect(parsePriceInput('850', 0)).toEqual({ ok: true, minor: 850n });
		expect(parsePriceInput('8.50', 0).ok).toBe(false);
	});

	it('admits a negative delta only when asked to, with either minus sign', () => {
		expect(parsePriceInput('-0.50', 2, { signed: true })).toEqual({ ok: true, minor: -50n });
		expect(parsePriceInput('−0.50', 2, { signed: true })).toEqual({ ok: true, minor: -50n });
		expect(parsePriceInput('-0.50', 2).ok).toBe(false);
	});

	it('never loses a digit, even past the largest safe JavaScript integer', () => {
		expect(parsePriceInput('90071992547409.93', 2)).toEqual({
			ok: true,
			minor: 9007199254740993n
		});
	});

	it('refuses an exponent that is not a whole number', () => {
		expect(() => parsePriceInput('8.50', 1.5)).toThrow(RangeError);
	});
});

describe('formatTaxRate', () => {
	it.each([
		[825, '8.25%'],
		[850, '8.5%'],
		[1000, '10%'],
		[5, '0.05%'],
		[0, '0%'],
		[10000, '100%'],
		[null, 'restaurant rate']
	])('labels %s as %j', (bp, label) => {
		expect(formatTaxRate(bp)).toBe(label);
	});
});

describe('parseOptionalRate', () => {
	it('reads a blank as "inherit the restaurant rate" (null) and a whole number as itself', () => {
		expect(parseOptionalRate('')).toEqual({ ok: true, value: null });
		expect(parseOptionalRate(null)).toEqual({ ok: true, value: null });
		expect(parseOptionalRate('825')).toEqual({ ok: true, value: 825 });
	});

	it.each(['8.25', '10001', '-1', 'abc'])('refuses %j', (raw) => {
		expect(parseOptionalRate(raw).ok).toBe(false);
	});
});

// menu-and-printing T-11: the category is optional, and a name is capped where
// the sale validator caps it (120) and may carry no control character.
describe('the name and category schemas', () => {
	const uuid = '0f9a4c2e-1b3d-4e5f-8a6b-7c8d9e0f1a2b';

	it('reads a blank category as null, a uuid as itself, and refuses anything else', () => {
		expect(
			createItemSchema.parse({ categoryId: '', name: 'Tea', price: '1' }).categoryId
		).toBeNull();
		expect(createItemSchema.parse({ categoryId: uuid, name: 'Tea', price: '1' }).categoryId).toBe(
			uuid
		);
		const bad = createItemSchema.safeParse({ categoryId: 'nope', name: 'Tea', price: '1' });
		expect(bad.success).toBe(false);
	});

	it("caps a name at 120 characters with the sale validator's message", () => {
		expect(createCategorySchema.safeParse({ name: 'x'.repeat(120) }).success).toBe(true);
		const long = createCategorySchema.safeParse({ name: 'x'.repeat(121) });
		expect(long.success).toBe(false);
		if (!long.success) {
			expect(long.error.issues[0]?.message).toBe('Keep the name under 120 characters.');
		}
	});

	it('refuses a control character in a name', () => {
		const escaped = createItemSchema.safeParse({ categoryId: '', name: 'Tea\u001b', price: '1' });
		expect(escaped.success).toBe(false);
		if (!escaped.success) {
			expect(escaped.error.issues[0]?.message).toBe('Remove the control characters from the name.');
		}
	});
});

// A source tripwire (the idiom components.test.ts uses): no floating-point step
// may appear anywhere in this route. helpers.ts is included on purpose.
describe('the menu route holds no float step', () => {
	it.each(['+page.svelte', '+page.server.ts', 'helpers.ts'])('%s', (file) => {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
		for (const banned of ['parseFloat', 'toFixed', 'Number(', '* 100', '/ 100']) {
			expect(source.includes(banned), `${file} contains ${banned}`).toBe(false);
		}
	});
});
