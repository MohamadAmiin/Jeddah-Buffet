// THE CSV WRITER (tasks/sales-report-export T-02). Every report download is
// built here, from TYPED cells, so no caller can forget the formula guard.
//
// Spreadsheets run a cell that starts with = + - @ (or a TAB, CR or LF that
// some of them strip first) as a formula. The till accepts item, modifier and
// table text by length only, so a crafted sale can store `=HYPERLINK(…)`; the
// guard therefore lives in THIS function and nowhere else. A text cell is
// always quoted and, when it starts with one of those characters, prefixed with
// an apostrophe (OWASP, "CSV Injection"). Money and counts are never guarded: a
// negative amount legitimately starts with '-', and both are written by this
// file from typed values, never from caller text.
//
// The file is UTF-8 with a byte-order mark (so Excel reads it as UTF-8) and
// CRLF line ends (RFC 4180). Money comes from formatAmountPlain — integer
// minor units rendered as digits, never a float (invariant 1).

import type { Minor } from '../../money';
import { formatAmountPlain, type MoneyFormat } from '../../money/format';

export type CsvCell =
	| { kind: 'text'; value: string | null }
	| { kind: 'money'; value: Minor | null }
	| { kind: 'count'; value: number | bigint | null };

export const text = (value: string | null): CsvCell => ({ kind: 'text', value });
export const money = (value: Minor | null): CsvCell => ({ kind: 'money', value });
export const count = (value: number | bigint | null): CsvCell => ({ kind: 'count', value });

const FORMULA_START = /^[=+\-@\t\r\n]/;

function encodeText(value: string | null): string {
	if (value === null) return '';
	const guarded = FORMULA_START.test(value) ? `'${value}` : value;
	return `"${guarded.replaceAll('"', '""')}"`;
}

function encode(cell: CsvCell, format: MoneyFormat): string {
	switch (cell.kind) {
		case 'text':
			return encodeText(cell.value);
		case 'money':
			return cell.value === null ? '' : formatAmountPlain(cell.value, format);
		case 'count':
			if (cell.value === null) return '';
			if (typeof cell.value === 'number' && !Number.isSafeInteger(cell.value)) {
				throw new TypeError(`a count is a whole number, not ${String(cell.value)}`);
			}
			return String(cell.value);
	}
}

/** The whole file: BOM, the header row, then every row, each ending in CRLF. */
export function toCsv(
	header: readonly string[],
	rows: readonly (readonly CsvCell[])[],
	format: MoneyFormat
): string {
	let out = '\uFEFF' + header.map((h) => encodeText(h)).join(',') + '\r\n';
	rows.forEach((row, index) => {
		if (row.length !== header.length) {
			throw new RangeError(
				`row ${index + 1} has ${row.length} cells; the header has ${header.length}`
			);
		}
		out += row.map((cell) => encode(cell, format)).join(',') + '\r\n';
	});
	return out;
}
