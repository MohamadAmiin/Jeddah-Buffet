import { describe, expect, it } from 'vitest';
import {
	isCalendarDate,
	parseRangeParams,
	presetsFor,
	rangeDays,
	resolveRange,
	shiftDate
} from './range';

// tasks/sales-report-export T-08 — Contract A, the pure parts.

const parse = (query: string) => parseRangeParams(new URLSearchParams(query));

describe('parseRangeParams', () => {
	it('reads from and to, a legacy date, one side alone, and nothing at all', () => {
		expect(parse('from=2026-09-01&to=2026-09-30')).toEqual({
			kind: 'range',
			from: '2026-09-01',
			to: '2026-09-30'
		});
		expect(parse('date=2026-09-28')).toEqual({
			kind: 'range',
			from: '2026-09-28',
			to: '2026-09-28'
		});
		expect(parse('from=2026-09-28')).toEqual({
			kind: 'range',
			from: '2026-09-28',
			to: '2026-09-28'
		});
		expect(parse('to=2026-09-28')).toEqual({ kind: 'range', from: '2026-09-28', to: '2026-09-28' });
		expect(parse('')).toEqual({ kind: 'default' });
		// from/to win over a stray date.
		expect(parse('date=2026-01-01&from=2026-09-28&to=2026-09-29')).toEqual({
			kind: 'range',
			from: '2026-09-28',
			to: '2026-09-29'
		});
	});

	it('refuses a non-date, a reversed range and more than 366 days', () => {
		expect(parse('date=2026-02-30')).toEqual({ kind: 'invalid' });
		expect(parse('from=2026-9-1&to=2026-09-30')).toEqual({ kind: 'invalid' });
		expect(parse('from=2026-09-30&to=2026-09-01')).toEqual({ kind: 'invalid' });
		expect(parse('from=2025-10-12&to=2026-10-12')).toEqual({
			kind: 'range',
			from: '2025-10-12',
			to: '2026-10-12'
		});
		expect(parse('from=2025-10-11&to=2026-10-12')).toEqual({ kind: 'invalid' });
	});
});

describe('the date helpers', () => {
	it('checks calendar dates, shifts across month ends and counts days inclusively', () => {
		expect(isCalendarDate('2028-02-29')).toBe(true);
		expect(isCalendarDate('2027-02-29')).toBe(false);
		expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
		expect(rangeDays({ from: '2026-09-28', to: '2026-09-28' })).toBe(1);
		expect(rangeDays({ from: '2026-09-01', to: '2026-09-30' })).toBe(30);
	});

	it('builds the presets from the current business date', () => {
		expect(presetsFor('2026-10-12')).toEqual({
			today: { from: '2026-10-12', to: '2026-10-12' },
			last7: { from: '2026-10-06', to: '2026-10-12' },
			month: { from: '2026-10-01', to: '2026-10-12' }
		});
		expect(presetsFor('2026-03-01').last7).toEqual({ from: '2026-02-23', to: '2026-03-01' });
	});
});

describe('resolveRange', () => {
	it('uses the current business date only when nothing is named', async () => {
		const today = async () => '2026-09-28';
		expect(await resolveRange(new URLSearchParams(''), today)).toEqual({
			from: '2026-09-28',
			to: '2026-09-28'
		});
		expect(await resolveRange(new URLSearchParams('date=2026-01-02'), today)).toEqual({
			from: '2026-01-02',
			to: '2026-01-02'
		});
	});

	it('answers 400 with the contract sentence', async () => {
		await expect(
			resolveRange(new URLSearchParams('date=nope'), async () => '2026-09-28')
		).rejects.toMatchObject({ status: 400 });
	});
});
