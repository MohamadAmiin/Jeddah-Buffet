// THE REPORT RANGE (tasks/sales-report-export T-08, Contract A) — shared by the
// /reports page and the /reports/export download, so the two can never read a
// URL differently. Pure: the default business date arrives as a callback, so
// this file touches no database and the unit tests need none.
//
// Every date is a BUSINESS date written YYYY-MM-DD (invariant 11). The presets
// end on the CURRENT business date — the one defaultReportDate returns, which
// is the open shift's at 01:30 — never on the calendar date.

import { error } from '@sveltejs/kit';

export type ReportRange = { from: string; to: string };

export const MAX_RANGE_DAYS = 366;

export const RANGE_MESSAGE =
	'Dates must be calendar dates written YYYY-MM-DD, from on or before to, at most 366 days apart.';

const SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function utc(value: string): number {
	const [y, m, d] = value.split('-').map(Number);
	return Date.UTC(y, m - 1, d);
}

export function isCalendarDate(value: string): boolean {
	if (!SHAPE.test(value)) return false;
	const [y, m, d] = value.split('-').map(Number);
	const date = new Date(utc(value));
	return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** UTC arithmetic on the string, so no server or browser time zone leaks in. */
export function shiftDate(value: string, days: number): string {
	const [y, m, d] = value.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Inclusive: 2026-09-28..2026-09-28 is one day. */
export function rangeDays(range: ReportRange): number {
	return Math.round((utc(range.to) - utc(range.from)) / 86_400_000) + 1;
}

export function isSingleDay(range: ReportRange): boolean {
	return range.from === range.to;
}

export type ParsedRange =
	{ kind: 'default' } | { kind: 'range'; from: string; to: string } | { kind: 'invalid' };

/**
 * `from` and `to`; one of them alone means both; the legacy `date` means
 * from = to = date when neither is given; nothing at all is the default.
 */
export function parseRangeParams(params: URLSearchParams): ParsedRange {
	const rawFrom = params.get('from');
	const rawTo = params.get('to');
	const rawDate = params.get('date');
	let from: string;
	let to: string;
	if (rawFrom !== null || rawTo !== null) {
		from = rawFrom ?? (rawTo as string);
		to = rawTo ?? (rawFrom as string);
	} else if (rawDate !== null) {
		from = rawDate;
		to = rawDate;
	} else {
		return { kind: 'default' };
	}
	if (!isCalendarDate(from) || !isCalendarDate(to)) return { kind: 'invalid' };
	if (from > to) return { kind: 'invalid' };
	if (rangeDays({ from, to }) > MAX_RANGE_DAYS) return { kind: 'invalid' };
	return { kind: 'range', from, to };
}

/** The range a request names, or the current business date; 400 on anything else. */
export async function resolveRange(
	params: URLSearchParams,
	currentBusinessDate: () => Promise<string>
): Promise<ReportRange> {
	const parsed = parseRangeParams(params);
	if (parsed.kind === 'invalid') error(400, RANGE_MESSAGE);
	if (parsed.kind === 'range') return { from: parsed.from, to: parsed.to };
	const today = await currentBusinessDate();
	return { from: today, to: today };
}

export type Presets = { today: ReportRange; last7: ReportRange; month: ReportRange };

/** Today, the last 7 days and this month, each ending on `today` (a business date). */
export function presetsFor(today: string): Presets {
	return {
		today: { from: today, to: today },
		last7: { from: shiftDate(today, -6), to: today },
		month: { from: today.slice(0, 8) + '01', to: today }
	};
}
