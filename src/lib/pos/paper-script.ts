// ARABIC ON PAPER — what the till can put on a receipt beyond printable ASCII
// (decided 2026-10-25, amending "Printing — decided 2026-09-29", which was
// Latin script only). Pure: no DOM, no IndexedDB.
//
// A thermal printer prints one fixed shape per byte. Arabic letters change
// shape with their neighbours and run right to left, so even a printer with an
// Arabic code page cannot join them by itself. The till therefore DRAWS every
// line that holds Arabic as a 1-bit picture (text-image.ts) — the browser shapes
// and orders the letters exactly as on screen — and the print agent prints it
// like the logo. This file says which text that is, and what the same line
// becomes as plain text when it cannot be a picture: each Arabic character a
// '?', exactly as every receipt printed before this change, so the columns of
// the line are unchanged.

/**
 * The Arabic blocks: Arabic, Arabic Supplement, Arabic Extended-A, and the two
 * presentation-form blocks (though toPrintable folds presentation forms back
 * to letters before any of this runs).
 */
const ARABIC_CHAR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u;
const ARABIC_GLOBAL = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/gu;
const PLAIN_ASCII = /^[\x20-\x7e]*$/;

/** One Arabic character (a single code point). */
export function isArabicChar(ch: string): boolean {
	return ARABIC_CHAR.test(ch);
}

/** The text holds at least one Arabic character. */
export function hasArabic(text: string): boolean {
	return ARABIC_CHAR.test(text);
}

/** Printable ASCII only — what a printer prints as text, needing no picture. */
export function isPlainAscii(text: string): boolean {
	return PLAIN_ASCII.test(text);
}

/** The same line as plain text: each Arabic character a '?', so the length is unchanged. */
export function asciiFallback(text: string): string {
	return text.replace(ARABIC_GLOBAL, '?');
}

/** One stretch of a line: plain ASCII, or Arabic (with the spaces between its words). */
export type Run = { text: string; start: number; arabic: boolean };

/**
 * Split a line into runs, by character index (every character the formatter
 * lays out is one column). An Arabic run starts and ends on an Arabic
 * character and takes in the spaces BETWEEN its words, so the drawing shapes a
 * phrase as one: "برجر لحم" is one run, while "برجر 2" is the run "برجر" then
 * the ASCII run " 2". Anything else is ASCII by the time it gets here
 * (toPrintable leaves nothing else).
 */
export function runs(text: string): Run[] {
	const chars = [...text];
	const out: Run[] = [];
	let i = 0;
	while (i < chars.length) {
		const start = i;
		if (isArabicChar(chars[i]!)) {
			let end = i + 1;
			let j = end;
			while (j < chars.length) {
				if (isArabicChar(chars[j]!)) {
					j += 1;
					end = j;
				} else if (chars[j] === ' ') {
					j += 1;
				} else break;
			}
			out.push({ text: chars.slice(start, end).join(''), start, arabic: true });
			i = end;
		} else {
			let j = i + 1;
			while (j < chars.length && !isArabicChar(chars[j]!)) j += 1;
			out.push({ text: chars.slice(start, j).join(''), start, arabic: false });
			i = j;
		}
	}
	return out;
}
