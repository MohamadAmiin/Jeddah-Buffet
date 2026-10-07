// THE RECEIPT LOGO CONVERTER — BROWSER-ONLY for readLogoFile(), the one
// function that touches createImageBitmap, document and a canvas, and PURE for
// everything else. There is NO DOM access at import time, so the module is
// safe to import in a Node test (the src/lib/image-resize.ts precedent), and
// it imports only ./receipt-layout (tasks/settings-tax-payments-receipt T-30).
//
// WHAT COMES OUT IS PLAIN PIXEL DATA, never printer bytes: 1-bit raster rows,
// 1 = black, packed MSB first with widthDots / 8 bytes per row — the layout
// `GS v 0` expects (RESEARCH.md). The result { widthDots, heightDots, bitmap }
// is checked by shape on the server (setReceiptLogo) and by the receipt_logos
// CHECKs, and print agent v2 is the ONLY writer of printer command bytes
// (risk 6), so no uploaded byte can reach the printer as a command — the
// drawer pulse included.
//
// This is pixel arithmetic, not money: Math.round and the dither's Float32Array
// error buffer are fine here, and this file is not in the money tripwires.
import {
	LOGO_MAX_HEIGHT_DOTS,
	LOGO_MAX_WIDTH_DOTS,
	isValidLogoShape,
	logoByteSize
} from './receipt-layout';

/** The largest file readLogoFile() decodes at all — refused BEFORE decoding. */
const LOGO_FILE_MAX_BYTES = 2_097_152;

const TOO_LARGE = 'That image is larger than 2 MB. Choose a smaller file.';
const UNREADABLE = 'That image could not be read.';
const UNCONVERTIBLE = 'That image could not be converted.';

function isPositiveInteger(n: number): boolean {
	return Number.isInteger(n) && n > 0;
}

/**
 * The dot size a logo of `width` × `height` pixels is drawn at: it fits
 * LOGO_MAX_WIDTH_DOTS × LOGO_MAX_HEIGHT_DOTS keeping the ratio, is never
 * scaled up, and its width is rounded DOWN to a multiple of 8 — never below 8,
 * the floor of the receipt_logos_width_dots_valid CHECK. Throws RangeError
 * unless both sides are positive integers.
 */
export function logoTargetSize(
	width: number,
	height: number
): { widthDots: number; heightDots: number } {
	if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
		throw new RangeError('logoTargetSize: width and height must be positive integers');
	}
	let w0: number;
	let h0: number;
	if (width <= LOGO_MAX_WIDTH_DOTS && height <= LOGO_MAX_HEIGHT_DOTS) {
		w0 = width;
		h0 = height;
	} else if (width * LOGO_MAX_HEIGHT_DOTS >= height * LOGO_MAX_WIDTH_DOTS) {
		// The width binds.
		w0 = LOGO_MAX_WIDTH_DOTS;
		h0 = Math.round((height * LOGO_MAX_WIDTH_DOTS) / width);
	} else {
		// The height binds.
		h0 = LOGO_MAX_HEIGHT_DOTS;
		w0 = Math.floor((width * LOGO_MAX_HEIGHT_DOTS) / height);
	}
	return {
		widthDots: Math.max(8, Math.floor(w0 / 8) * 8),
		heightDots: Math.max(1, Math.min(LOGO_MAX_HEIGHT_DOTS, h0))
	};
}

/**
 * One gray byte per pixel from RGBA: alpha composited onto WHITE,
 * c' = (c · a + 255 · (255 − a)) / 255, then luminance with integer weights,
 * Math.round((299 r' + 587 g' + 114 b') / 1000). Throws RangeError when the
 * buffer is not width × height × 4 bytes.
 */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
	if (rgba.length !== width * height * 4) {
		throw new RangeError('toGray: rgba must hold width * height * 4 bytes');
	}
	const pixels = width * height;
	const gray = new Uint8ClampedArray(pixels);
	for (let p = 0; p < pixels; p += 1) {
		const i = p * 4;
		const a = rgba[i + 3];
		const white = 255 * (255 - a);
		const r = (rgba[i] * a + white) / 255;
		const g = (rgba[i + 1] * a + white) / 255;
		const b = (rgba[i + 2] * a + white) / 255;
		gray[p] = Math.round((299 * r + 587 * g + 114 * b) / 1000);
	}
	return gray;
}

/**
 * Floyd–Steinberg dithering to 1 bit, 1 = black, on a Float32Array working
 * copy (pixel data, not money): a pixel below 128 becomes black (new value 0),
 * any other white (255), and the error old − new is spread 7/16 right, 3/16
 * down-left, 5/16 down and 1/16 down-right, inside the image only. Throws
 * RangeError when the buffer is not width × height bytes.
 */
export function toMonochrome(gray: Uint8ClampedArray, width: number, height: number): Uint8Array {
	if (gray.length !== width * height) {
		throw new RangeError('toMonochrome: gray must hold width * height bytes');
	}
	const work = Float32Array.from(gray);
	const mono = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		const rowBelow = y + 1 < height;
		for (let x = 0; x < width; x += 1) {
			const i = y * width + x;
			const old = work[i];
			const black = old < 128;
			const updated = black ? 0 : 255;
			mono[i] = black ? 1 : 0;
			const err = old - updated;
			if (x + 1 < width) work[i + 1] += (err * 7) / 16;
			if (rowBelow) {
				if (x > 0) work[i + width - 1] += (err * 3) / 16;
				work[i + width] += (err * 5) / 16;
				if (x + 1 < width) work[i + width + 1] += err / 16;
			}
		}
	}
	return mono;
}

/**
 * Pack 0/1 pixels into raster rows, MSB first: pixel (x, y) sets bit
 * 7 − (x % 8) of byte y · (width / 8) + ⌊x / 8⌋ when it is 1. Throws
 * RangeError when the width is not a multiple of 8 or the buffer is not
 * width × height bytes.
 */
export function packRows(mono: Uint8Array, width: number, height: number): Uint8Array {
	if (width % 8 !== 0) throw new RangeError('packRows: width must be a multiple of 8');
	if (mono.length !== width * height) {
		throw new RangeError('packRows: mono must hold width * height bytes');
	}
	const bytesPerRow = width / 8;
	const bitmap = new Uint8Array(bytesPerRow * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (mono[y * width + x] === 1) {
				bitmap[y * bytesPerRow + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
			}
		}
	}
	return bitmap;
}

/**
 * The inverse of packRows: one 0/1 byte per dot. Throws RangeError when the
 * width is not a multiple of 8 or the bitmap is not
 * logoByteSize(widthDots, heightDots) bytes long.
 */
export function unpackRows(bitmap: Uint8Array, widthDots: number, heightDots: number): Uint8Array {
	if (widthDots % 8 !== 0) throw new RangeError('unpackRows: widthDots must be a multiple of 8');
	if (bitmap.length !== logoByteSize(widthDots, heightDots)) {
		throw new RangeError('unpackRows: bitmap must hold logoByteSize(widthDots, heightDots) bytes');
	}
	const bytesPerRow = widthDots / 8;
	const mono = new Uint8Array(widthDots * heightDots);
	for (let y = 0; y < heightDots; y += 1) {
		for (let x = 0; x < widthDots; x += 1) {
			const byte = bitmap[y * bytesPerRow + Math.floor(x / 8)];
			mono[y * widthDots + x] = (byte >> (7 - (x % 8))) & 1;
		}
	}
	return mono;
}

/**
 * Standard padded base64 of the packed rows — the form the hidden form field
 * and the wire carry. The binary string is built in a loop: spreading a
 * 7,680-byte array into String.fromCharCode would hit the argument limit.
 */
export function encodeBitmap(bitmap: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bitmap.length; i += 1) binary += String.fromCharCode(bitmap[i]);
	return btoa(binary);
}

/** The inverse of encodeBitmap. */
export function decodeBitmap(text: string): Uint8Array {
	const binary = atob(text);
	const bitmap = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bitmap[i] = binary.charCodeAt(i);
	return bitmap;
}

/**
 * BROWSER-ONLY. Decode an image file, draw it at logoTargetSize(), and turn it
 * into packed 1-bit rows: toGray → toMonochrome → packRows. Files over 2 MB are
 * refused before decoding; a file the browser cannot decode fails with a
 * message the page shows as it is. The result always satisfies
 * isValidLogoShape — a failure there is a bug, not an input problem.
 */
export async function readLogoFile(
	file: File
): Promise<{ widthDots: number; heightDots: number; bitmap: Uint8Array }> {
	if (file.size > LOGO_FILE_MAX_BYTES) throw new Error(TOO_LARGE);
	let image: ImageBitmap;
	try {
		image = await createImageBitmap(file);
	} catch {
		throw new Error(UNREADABLE);
	}
	try {
		const { widthDots, heightDots } = logoTargetSize(image.width, image.height);
		const canvas = document.createElement('canvas');
		canvas.width = widthDots;
		canvas.height = heightDots;
		const context = canvas.getContext('2d');
		if (!context) throw new Error(UNREADABLE);
		context.drawImage(image, 0, 0, widthDots, heightDots);
		const { data } = context.getImageData(0, 0, widthDots, heightDots);
		const gray = toGray(data, widthDots, heightDots);
		const bitmap = packRows(toMonochrome(gray, widthDots, heightDots), widthDots, heightDots);
		if (!isValidLogoShape(widthDots, heightDots, bitmap.length)) {
			throw new Error(UNCONVERTIBLE);
		}
		return { widthDots, heightDots, bitmap };
	} finally {
		image.close();
	}
}
