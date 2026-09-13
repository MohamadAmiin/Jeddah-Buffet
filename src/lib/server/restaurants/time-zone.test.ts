import { describe, it, expect } from 'vitest';
import { isValidTimeZone, canonicalTimeZone, timeZoneSuggestions } from './time-zone';

describe('isValidTimeZone', () => {
	// The first five are EXACTLY the values a list-membership check rejects:
	// measured on the pinned Node 24.21.0, Intl.supportedValuesOf('timeZone')
	// contains none of them. This test would fail against the implementation T-16
	// forbids.
	it.each([
		'UTC',
		'Etc/UTC',
		'Asia/Kolkata',
		'Europe/Kyiv',
		'America/Argentina/Buenos_Aires',
		'Asia/Riyadh',
		'Africa/Mogadishu'
	])('accepts %s', (tz) => {
		expect(isValidTimeZone(tz)).toBe(true);
	});

	it.each([
		['a nonexistent zone', 'Not/AZone'],
		['the empty string', ''],
		['whitespace', '   '],
		['an SQL injection attempt', "'; drop table users; --"],
		['a number', '42']
	])('rejects %s', (_label, tz) => {
		expect(isValidTimeZone(tz)).toBe(false);
	});

	// The whole point of validating by construction rather than by list.
	it('accepts every value a list-membership check would reject', () => {
		const list = new Set(timeZoneSuggestions());
		const absentFromList = [
			'UTC',
			'Etc/UTC',
			'Asia/Kolkata',
			'Europe/Kyiv',
			'America/Argentina/Buenos_Aires'
		].filter((tz) => !list.has(tz));

		// Guard the premise: if a future ICU adds these to the list, this test should
		// say so rather than silently stop proving anything.
		expect(absentFromList.length).toBeGreaterThan(0);
		for (const tz of absentFromList) {
			expect(isValidTimeZone(tz), `${tz} is absent from the list but must be valid`).toBe(true);
		}
	});
});

describe('canonicalTimeZone', () => {
	it('resolves an alias to its canonical spelling', () => {
		// Asia/Calcutta is the legacy alias for Asia/Kolkata.
		expect(canonicalTimeZone('Asia/Calcutta')).toBe(canonicalTimeZone('Asia/Kolkata'));
	});

	it('leaves an already-canonical zone alone', () => {
		expect(canonicalTimeZone('Africa/Mogadishu')).toBe('Africa/Mogadishu');
	});

	it('is stable — canonicalising twice changes nothing', () => {
		const once = canonicalTimeZone('Europe/Kyiv');
		expect(canonicalTimeZone(once)).toBe(once);
	});
});
