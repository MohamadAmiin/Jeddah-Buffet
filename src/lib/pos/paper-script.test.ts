import { describe, expect, it } from 'vitest';
import { asciiFallback, hasArabic, isArabicChar, isPlainAscii, runs } from './paper-script';

describe('which text is Arabic', () => {
	it('finds Arabic letters, Arabic-Indic digits and Arabic punctuation', () => {
		expect(hasArabic('برجر')).toBe(true);
		expect(hasArabic('Tea ٢')).toBe(true);
		expect(hasArabic('شاي، قهوة')).toBe(true);
		expect(hasArabic('Tea 2.50')).toBe(false);
		expect(isArabicChar('ب')).toBe(true);
		expect(isArabicChar('b')).toBe(false);
	});

	it('plain ASCII is what a printer prints as text', () => {
		expect(isPlainAscii('TOTAL        19.95')).toBe(true);
		expect(isPlainAscii('برجر')).toBe(false);
		expect(isPlainAscii('')).toBe(true);
	});
});

describe('asciiFallback — the line as plain text', () => {
	it('turns each Arabic character into one question mark, keeping the length', () => {
		const line = 'برجر لحم            17.00';
		expect(asciiFallback(line)).toBe('???? ???            17.00');
		expect(asciiFallback(line)).toHaveLength(line.length);
		expect(asciiFallback('Tea 2.50')).toBe('Tea 2.50');
	});
});

describe('runs — the stretches a line is drawn in', () => {
	it('keeps an Arabic phrase together, spaces between its words included', () => {
		expect(runs('برجر لحم            17.00')).toEqual([
			{ text: 'برجر لحم', start: 0, arabic: true },
			{ text: '            17.00', start: 8, arabic: false }
		]);
	});

	it('ends an Arabic run at the first ASCII character that is not a space', () => {
		expect(runs('برجر 2')).toEqual([
			{ text: 'برجر', start: 0, arabic: true },
			{ text: ' 2', start: 4, arabic: false }
		]);
	});

	it('handles ASCII first, Arabic in the middle, and a line with no Arabic', () => {
		expect(runs('  2 @ شاي x')).toEqual([
			{ text: '  2 @ ', start: 0, arabic: false },
			{ text: 'شاي', start: 6, arabic: true },
			{ text: ' x', start: 9, arabic: false }
		]);
		expect(runs('TOTAL')).toEqual([{ text: 'TOTAL', start: 0, arabic: false }]);
		expect(runs('')).toEqual([]);
	});

	it('every character lands in exactly one run, in order', () => {
		const line = 'مطعم جدة · Jeddah ٢٠٢٦ end';
		const joined = runs(line)
			.map((r) => r.text)
			.join('');
		expect(joined).toBe(line);
	});
});
