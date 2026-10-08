import { describe, expect, it } from 'vitest';
import { DRAWER_PULSE, encodeJob, PAPER_STATUS_QUERY } from './escpos.ts';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n: number) => new Array<number>(n).fill(0x00);
const b64 = (bytes: ArrayLike<number>) => Buffer.from(bytes).toString('base64');
const image = (widthDots: number, heightDots: number, bitmap: string) => ({
	image: { widthDots, heightDots, bitmap }
});
const RASTER_HEADER = [0x1d, 0x76, 0x30, 0x00];

/** Every index at which `needle` occurs in `hay`. */
function indexesOf(hay: Uint8Array, needle: ArrayLike<number>): number[] {
	const found: number[] = [];
	for (let i = 0; i + needle.length <= hay.length; i += 1) {
		let k = 0;
		while (k < needle.length && hay[i + k] === needle[k]) k += 1;
		if (k === needle.length) found.push(i);
	}
	return found;
}

describe('encodeJob', () => {
	it('encodes a two-line job with a cut byte for byte', () => {
		const lines = [
			{ text: 'ORDER 231', size: 'double', align: 'center', bold: true } as const,
			{ text: 'Tea' }
		];
		const bytes = encodeJob(lines, { cut: true, columns: 48 });
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
		// `columns` does not affect text: a 32-column printer gets the identical stream.
		expect(Array.from(encodeJob(lines, { cut: true, columns: 32 }))).toEqual(expected);
	});

	it('omits the cut sequence when cut is false, and encodes tall as double height only', () => {
		const bytes = Array.from(encodeJob([{ text: 'x', size: 'tall' }], { cut: false, columns: 48 }));
		expect(bytes.slice(-3)).toEqual([0x1b, 0x64, 0x04]);
		const sizeAt = bytes.indexOf(0x1d);
		expect(bytes.slice(sizeAt, sizeAt + 3)).toEqual([0x1d, 0x21, 0x01]);
		expect(bytes).not.toContain(0x56);
	});

	it('throws on a character outside printable ASCII — the second wall behind parseJob', () => {
		const opts = { cut: false, columns: 48 } as const;
		expect(() => encodeJob([{ text: 'café' }], opts)).toThrow(/U\+00e9/);
		expect(() => encodeJob([{ text: 'tab\there' }], opts)).toThrow(/not printable/);
		expect(() => encodeJob([{ text: '\u001b@' }], opts)).toThrow(/not printable/);
	});

	it('an empty line list still initialises, resets, feeds and cuts', () => {
		expect(Array.from(encodeJob([], { cut: true, columns: 48 }))).toEqual([
			0x1b, 0x40, 0x1b, 0x74, 0x00, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00, 0x1b,
			0x64, 0x04, 0x1d, 0x56, 0x42, 0x00
		]);
	});
});

describe('encodeJob — image lines (GS v 0)', () => {
	it('8 × 2 on a 32-column printer, byte for byte: ESC a 0, one band, rows padded to centre', () => {
		// '/4E=' is FF 81: the top row all black, the bottom row its two edge dots.
		const bytes = Array.from(encodeJob([image(8, 2, '/4E=')], { cut: false, columns: 32 }));
		// prettier-ignore
		const expected = [
			0x1b, 0x40,                                     // ESC @  initialise
			0x1b, 0x74, 0x00,                               // ESC t 0  code page PC437
			0x1b, 0x61, 0x00, 0x1b, 0x45, 0x00, 0x1d, 0x21, 0x00, // ESC a 0, ESC E 0, GS ! 0
			0x1d, 0x76, 0x30, 0x00, 0x30, 0x00, 0x02, 0x00, // GS v 0 0, 48 bytes wide, 2 rows
			...zeros(23), 0xff, ...zeros(24),               // row 1
			...zeros(23), 0x81, ...zeros(24),               // row 2 — no LF after a band
			0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x61, 0x00, // reset size, bold, align
			0x1b, 0x64, 0x04                                // ESC d 4, and no cut
		];
		expect(bytes).toHaveLength(130);
		expect(bytes).toEqual(expected);
	});

	it('centres a 384-dot row on 80 mm paper with 12 zero bytes each side', () => {
		const bytes = Array.from(
			encodeJob([image(384, 1, b64(new Array<number>(48).fill(0xff)))], {
				cut: false,
				columns: 48
			})
		);
		const h = 14;
		expect(bytes.slice(h, h + 8)).toEqual([0x1d, 0x76, 0x30, 0x00, 0x48, 0x00, 0x01, 0x00]);
		expect(bytes.slice(h + 8, h + 8 + 72)).toEqual([
			...zeros(12),
			...new Array<number>(48).fill(0xff),
			...zeros(12)
		]);
		expect(bytes).toHaveLength(h + 8 + 72 + 12);
	});

	it('splits 130 rows into bands of 64, 64 and 2, each with its own header', () => {
		const bitmap = Array.from({ length: 48 * 130 }, (_, i) => i & 0xff);
		const bytes = encodeJob([image(384, 130, b64(bitmap))], { cut: true, columns: 32 });
		const headers = indexesOf(bytes, RASTER_HEADER);
		expect(headers).toEqual([14, 3094, 6174]);
		expect(headers.map((h) => bytes[h + 6])).toEqual([0x40, 0x40, 0x02]);
		for (const h of headers) {
			expect(Array.from(bytes.slice(h + 4, h + 6))).toEqual([0x30, 0x00]);
			expect(bytes[h + 7]).toBe(0x00);
		}
		// The three windows carry the whole bitmap in order and nothing else: 48 × 130 bytes.
		const data = headers.flatMap((h) =>
			Array.from(bytes.slice(h + 8, h + 8 + 48 * (bytes[h + 6]! + 256 * bytes[h + 7]!)))
		);
		expect(data).toHaveLength(6240);
		expect(data).toEqual(bitmap);
		expect(bytes).toHaveLength(6294);
	});

	it('starts the raster on an empty line: the text before it ended in LF', () => {
		const bytes = encodeJob([{ text: 'TOP' }, image(8, 1, 'AA==')], { cut: false, columns: 48 });
		const [h] = indexesOf(bytes, RASTER_HEADER);
		expect(h).toBeDefined();
		expect(Array.from(bytes.slice(h! - 9, h))).toEqual([
			0x1b, 0x61, 0x00, 0x1b, 0x45, 0x00, 0x1d, 0x21, 0x00
		]);
		expect(bytes[h! - 10]).toBe(0x0a);
	});

	it('is the second wall: with parseJob bypassed, a wrong shape throws before any byte is written', () => {
		const bitmapOf = (n: number) => b64(zeros(n));
		const opts32 = { cut: false, columns: 32 } as const;
		// A bitmap one byte short.
		expect(() => encodeJob([image(8, 2, bitmapOf(1))], opts32)).toThrow(/escpos: image/);
		// Wider than a 32-column printer prints.
		expect(() => encodeJob([image(392, 1, bitmapOf(49))], opts32)).toThrow(/escpos: image/);
		// Not a multiple of 8.
		expect(() => encodeJob([image(12, 1, bitmapOf(2))], opts32)).toThrow(/escpos: image/);
		// Taller than the cap.
		expect(() =>
			encodeJob([image(384, 241, bitmapOf(48 * 241))], { cut: false, columns: 48 })
		).toThrow(/escpos: image/);
		// A fractional height passes every other check (48 × 1.5 = 72 bytes) and is still refused.
		expect(() => encodeJob([image(384, 1.5, bitmapOf(72))], opts32)).toThrow(/escpos: image/);
	});
});

describe('REQUIRED (Risk 6) — a logo cannot carry the drawer pulse', () => {
	it('a pulse-filled logo changes nothing outside the raster windows the headers fix', () => {
		// One drawer pulse per row of a 40 × 70 image: 70 × 5 = 350 bytes.
		const evil = Buffer.concat(Array.from({ length: 70 }, () => Buffer.from(DRAWER_PULSE)));
		const clean = Buffer.alloc(350, 0x00);
		expect(evil).toHaveLength(350);
		const lines = (bitmap: Buffer) => [
			{ text: 'TOP' },
			image(40, 70, bitmap.toString('base64')),
			{ text: 'BOTTOM' }
		];
		const a = encodeJob(lines(evil), { cut: true, columns: 32 });
		const b = encodeJob(lines(clean), { cut: true, columns: 32 });

		// Walk B: at each GS v 0 header the window is [h + 8, h + 8 + x·y), then skip to its end.
		const windows: Array<[number, number]> = [];
		for (let i = 0; i + 8 <= b.length;) {
			if (b[i] === 0x1d && b[i + 1] === 0x76 && b[i + 2] === 0x30 && b[i + 3] === 0x00) {
				const x = b[i + 4]! + 256 * b[i + 5]!;
				const y = b[i + 6]! + 256 * b[i + 7]!;
				const start = i + 8;
				windows.push([start, start + x * y]);
				i = start + x * y;
			} else {
				i += 1;
			}
		}
		expect(windows).toHaveLength(2);
		expect(windows.reduce((n, [start, end]) => n + (end - start), 0)).toBe(48 * 70);

		expect(a.length).toBe(b.length);
		const inside = (k: number) => windows.some(([start, end]) => k >= start && k < end);
		const outside = (stream: Uint8Array) =>
			Array.from(stream, (byte, k) => (inside(k) ? -1 : byte));
		expect(outside(a)).toEqual(outside(b));

		expect(indexesOf(b, DRAWER_PULSE)).toEqual([]);
		const pulses = indexesOf(a, DRAWER_PULSE);
		expect(pulses).toHaveLength(70);
		for (const p of pulses) {
			expect(
				windows.some(([start, end]) => p >= start && p + DRAWER_PULSE.length <= end),
				`pulse at ${p}`
			).toBe(true);
		}
	});
});

describe('the two fixed byte strings', () => {
	it('DRAWER_PULSE is ESC p 0 25 250 and PAPER_STATUS_QUERY is DLE EOT 4', () => {
		expect(Array.from(DRAWER_PULSE)).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
		expect(Array.from(PAPER_STATUS_QUERY)).toEqual([0x10, 0x04, 0x04]);
	});
});
