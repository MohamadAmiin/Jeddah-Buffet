import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	LOGO_MAX_HEIGHT_DOTS,
	LOGO_MAX_WIDTH_DOTS,
	isValidLogoShape,
	logoByteSize
} from './receipt-layout';
import {
	decodeBitmap,
	encodeBitmap,
	logoTargetSize,
	packRows,
	toGray,
	toMonochrome,
	unpackRows
} from './receipt-logo';

// The pure part only: readLogoFile needs a browser (createImageBitmap, canvas)
// and is exercised by the e2e journey that uploads a logo through
// /settings/receipt.

/** A small seeded generator, so the round-trip field is the same on every run. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

describe('logoTargetSize (settings-tax-payments-receipt T-30)', () => {
	it('fits 384 × 160 keeping the ratio, the width rounded down to a multiple of 8', () => {
		expect(logoTargetSize(1000, 500)).toEqual({ widthDots: 320, heightDots: 160 });
		expect(logoTargetSize(2000, 100)).toEqual({ widthDots: 384, heightDots: 19 });
		expect(logoTargetSize(390, 100)).toEqual({ widthDots: 384, heightDots: 98 });
		expect(logoTargetSize(384, 160)).toEqual({ widthDots: 384, heightDots: 160 });
	});

	it('never upscales, and still rounds the width down', () => {
		expect(logoTargetSize(100, 50)).toEqual({ widthDots: 96, heightDots: 50 });
	});

	it('never goes below 8 dots wide', () => {
		expect(logoTargetSize(7, 7)).toEqual({ widthDots: 8, heightDots: 7 });
		expect(logoTargetSize(10, 1000)).toEqual({ widthDots: 8, heightDots: 160 });
	});

	it('refuses a side that is not a positive integer', () => {
		expect(() => logoTargetSize(0, 5)).toThrow(RangeError);
		expect(() => logoTargetSize(5.5, 5)).toThrow(RangeError);
	});

	it('always yields a shape the receipt_logos CHECKs accept', () => {
		for (let w = 1; w <= 800; w += 37) {
			for (let h = 1; h <= 400; h += 23) {
				const r = logoTargetSize(w, h);
				const bytes = logoByteSize(r.widthDots, r.heightDots);
				expect(isValidLogoShape(r.widthDots, r.heightDots, bytes)).toBe(true);
				expect(r.widthDots).toBeLessThanOrEqual(LOGO_MAX_WIDTH_DOTS);
				expect(r.heightDots).toBeLessThanOrEqual(LOGO_MAX_HEIGHT_DOTS);
			}
		}
	});
});

describe('toGray', () => {
	const pixel = (r: number, g: number, b: number, a: number): number =>
		toGray(Uint8ClampedArray.of(r, g, b, a), 1, 1)[0];

	it('maps opaque black to 0 and opaque white to 255', () => {
		expect(pixel(0, 0, 0, 255)).toBe(0);
		expect(pixel(255, 255, 255, 255)).toBe(255);
	});

	it('composites a fully transparent pixel onto white, whatever its colour', () => {
		expect(pixel(0, 0, 0, 0)).toBe(255);
		expect(pixel(255, 0, 0, 0)).toBe(255);
		expect(pixel(17, 200, 90, 0)).toBe(255);
	});

	it('weights opaque pure red at 76', () => {
		expect(pixel(255, 0, 0, 255)).toBe(76);
	});

	it('returns one byte per pixel', () => {
		const rgba = new Uint8ClampedArray(3 * 2 * 4).fill(255);
		expect(toGray(rgba, 3, 2).length).toBe(6);
	});

	it('refuses a buffer of the wrong length', () => {
		expect(() => toGray(new Uint8ClampedArray(7), 1, 2)).toThrow(RangeError);
	});
});

describe('toMonochrome', () => {
	it('keeps a white field white and a black field black', () => {
		const white = new Uint8ClampedArray(64).fill(255);
		expect(Array.from(toMonochrome(white, 8, 8))).toEqual(new Array(64).fill(0));
		const black = new Uint8ClampedArray(64).fill(0);
		expect(Array.from(toMonochrome(black, 8, 8))).toEqual(new Array(64).fill(1));
	});

	it('dithers a mid-gray field to about half black', () => {
		const mid = new Uint8ClampedArray(64 * 64).fill(128);
		const mono = toMonochrome(mid, 64, 64);
		let ones = 0;
		for (const bit of mono) ones += bit;
		expect(ones).toBeGreaterThanOrEqual(0.45 * 4096);
		expect(ones).toBeLessThanOrEqual(0.55 * 4096);
	});

	it('refuses a buffer of the wrong length', () => {
		expect(() => toMonochrome(new Uint8ClampedArray(63), 8, 8)).toThrow(RangeError);
	});
});

describe('packRows and unpackRows', () => {
	it('packs MSB first, widthDots / 8 bytes per row', () => {
		expect(Array.from(packRows(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0), 8, 1))).toEqual([0x80]);
		const ninth = new Uint8Array(16);
		ninth[8] = 1;
		expect(Array.from(packRows(ninth, 16, 1))).toEqual([0x00, 0x80]);
		expect(Array.from(packRows(new Uint8Array(8).fill(1), 8, 1))).toEqual([0xff]);
	});

	it('refuses a width that is not a multiple of 8', () => {
		expect(() => packRows(new Uint8Array(12), 12, 1)).toThrow(RangeError);
	});

	it('round-trips a seeded pseudo-random field', () => {
		const next = seeded(20261005);
		const m = Uint8Array.from({ length: 24 * 5 }, () => (next() < 0.5 ? 1 : 0));
		const packed = packRows(m, 24, 5);
		expect(packed.length).toBe(logoByteSize(24, 5));
		expect(Array.from(unpackRows(packed, 24, 5))).toEqual(Array.from(m));
	});

	it('refuses a bitmap with one byte too many', () => {
		expect(() => unpackRows(new Uint8Array(logoByteSize(24, 5) + 1), 24, 5)).toThrow(RangeError);
	});

	it('packs to exactly logoByteSize bytes at the largest shape', () => {
		const largest = packRows(new Uint8Array(384 * 160), 384, 160);
		expect(largest.length).toBe(logoByteSize(384, 160));
		expect(largest.length).toBe(7680);
	});
});

describe('encodeBitmap and decodeBitmap', () => {
	it('use standard padded base64', () => {
		expect(encodeBitmap(Uint8Array.of(0x80, 0xff))).toBe('gP8=');
		expect(Array.from(decodeBitmap('gP8='))).toEqual([0x80, 0xff]);
	});

	it('round-trip a full-size logo', () => {
		const next = seeded(7);
		const bitmap = Uint8Array.from({ length: 7680 }, () => Math.floor(next() * 256));
		expect(Array.from(decodeBitmap(encodeBitmap(bitmap)))).toEqual(Array.from(bitmap));
	});
});

describe('the module', () => {
	it('imports in the node environment without touching the DOM', async () => {
		// The static import above already ran; a fresh dynamic import proves the
		// module body itself reaches for no document, window or canvas.
		await expect(import('./receipt-logo')).resolves.toHaveProperty('readLogoFile');
	});

	// The one-import rule, enforced in source text (the src/lib/menu-images.test.ts
	// idiom) — comments stripped first, because the header talks about importing.
	it('imports only ./receipt-layout', () => {
		const source = readFileSync(new URL('./receipt-logo.ts', import.meta.url), 'utf8');
		const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		const specifiers = [...stripped.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers) expect(specifier).toBe('./receipt-layout');
		expect(stripped).not.toMatch(/\bimport\(/);
		expect(stripped).not.toMatch(/\brequire\(/);
	});
});
