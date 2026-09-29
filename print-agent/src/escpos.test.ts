import { describe, expect, it } from 'vitest';
import { DRAWER_PULSE, encodeJob, PAPER_STATUS_QUERY } from './escpos.ts';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('encodeJob', () => {
	it('encodes a two-line job with a cut byte for byte', () => {
		const bytes = encodeJob(
			[{ text: 'ORDER 231', size: 'double', align: 'center', bold: true }, { text: 'Tea' }],
			{ cut: true }
		);
		// prettier-ignore
		const expected = [
			0x1b, 0x40,             // ESC @  initialise
			0x1b, 0x74, 0x00,       // ESC t 0  code page PC437
			0x1b, 0x61, 0x01,       // ESC a 1  centre
			0x1b, 0x45, 0x01,       // ESC E 1  bold on
			0x1d, 0x21, 0x11,       // GS ! 0x11  double width and height
			...ascii('ORDER 231'),
			0x0a,
			0x1b, 0x61, 0x00,       // ESC a 0  left
			0x1b, 0x45, 0x00,       // ESC E 0  bold off
			0x1d, 0x21, 0x00,       // GS ! 0  normal
			...ascii('Tea'),
			0x0a,
			0x1d, 0x21, 0x00,       // reset size
			0x1b, 0x45, 0x00,       // reset bold
			0x1b, 0x61, 0x00,       // reset align
			0x1b, 0x64, 0x04,       // ESC d 4  feed four lines
			0x1d, 0x56, 0x42, 0x00  // GS V B 0  partial cut
		];
		expect(Array.from(bytes)).toEqual(expected);
	});

	it('omits the cut sequence when cut is false, and encodes tall as double height only', () => {
		const bytes = Array.from(encodeJob([{ text: 'x', size: 'tall' }], { cut: false }));
		expect(bytes.slice(-3)).toEqual([0x1b, 0x64, 0x04]);
		const sizeAt = bytes.indexOf(0x1d);
		expect(bytes.slice(sizeAt, sizeAt + 3)).toEqual([0x1d, 0x21, 0x01]);
		expect(bytes).not.toContain(0x56);
	});

	it('throws on a character outside printable ASCII — the second wall behind parseJob', () => {
		expect(() => encodeJob([{ text: 'café' }], { cut: false })).toThrow(/U\+00e9/);
		expect(() => encodeJob([{ text: 'tab\there' }], { cut: false })).toThrow(/not printable/);
		expect(() => encodeJob([{ text: '\u001b@' }], { cut: false })).toThrow(/not printable/);
	});

	it('an empty line list still initialises, resets, feeds and cuts', () => {
		expect(Array.from(encodeJob([], { cut: true }))).toEqual([
			0x1b, 0x40, 0x1b, 0x74, 0x00, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00, 0x1b,
			0x64, 0x04, 0x1d, 0x56, 0x42, 0x00
		]);
	});
});

describe('the two fixed byte strings', () => {
	it('DRAWER_PULSE is ESC p 0 25 250 and PAPER_STATUS_QUERY is DLE EOT 4', () => {
		expect(Array.from(DRAWER_PULSE)).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
		expect(Array.from(PAPER_STATUS_QUERY)).toEqual([0x10, 0x04, 0x04]);
	});
});
