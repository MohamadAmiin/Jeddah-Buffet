import { describe, expect, it } from 'vitest';
import { minor } from '../../money';
import { moneyFormatFor } from '../../money/format';
import { count, money, text, toCsv } from './csv';

// tasks/sales-report-export T-02. Money cells go through formatAmountPlain
// (MANDATORY spec 29 money area, covered in format.test.ts); this file pins the
// file shape and the formula guard.

const usd = moneyFormatFor('USD');
const one = (cell: ReturnType<typeof text>) => toCsv(['A'], [[cell]], usd).split('\r\n')[1];

describe('toCsv', () => {
	it('writes a BOM, a quoted header and CRLF after every row', () => {
		const csv = toCsv(['Item', 'Qty'], [[text('Tea'), count(3)]], usd);
		expect(csv).toBe('\uFEFF"Item","Qty"\r\n"Tea",3\r\n');
	});

	it('guards every text cell that a spreadsheet would run as a formula', () => {
		expect(one(text('=HYPERLINK("x")'))).toBe('"\'=HYPERLINK(""x"")"');
		expect(one(text('-2+3'))).toBe('"\'-2+3"');
		expect(one(text('+1'))).toBe('"\'+1"');
		expect(one(text('@SUM(A1)'))).toBe('"\'@SUM(A1)"');
		expect(one(text('\tx'))).toBe('"\'\tx"');
		expect(one(text('\rx'))).toBe('"\'\rx"');
		expect(one(text('\nx'))).toBe('"\'\nx"');
	});

	it('quotes commas, quotes and newlines inside one cell', () => {
		expect(one(text('Burger, large'))).toBe('"Burger, large"');
		const csv = toCsv(['A'], [[text('two\r\nlines')]], usd);
		expect(csv).toBe('\uFEFF"A"\r\n"two\r\nlines"\r\n');
	});

	it('writes money and counts bare and never guards them', () => {
		expect(one(money(minor(-850n)))).toBe('-8.50');
		expect(one(money(minor(123456n)))).toBe('1234.56');
		expect(one(count(3))).toBe('3');
		expect(one(count(12n))).toBe('12');
	});

	it('writes null as an empty cell', () => {
		expect(toCsv(['A', 'B', 'C'], [[text(null), money(null), count(null)]], usd)).toBe(
			'\uFEFF"A","B","C"\r\n,,\r\n'
		);
	});

	it('refuses a fractional count', () => {
		expect(() => one(count(1.5))).toThrow(TypeError);
	});

	it('refuses a row that does not match the header', () => {
		expect(() => toCsv(['A', 'B'], [[text('x')]], usd)).toThrow(RangeError);
	});
});
