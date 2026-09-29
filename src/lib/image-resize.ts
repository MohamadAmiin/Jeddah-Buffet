// BROWSER-ONLY photo resizer for the dashboard's /menu panel. There is NO DOM
// access at import time — the module is safe to import in a Node test — and
// only resizePhoto() touches createImageBitmap, document and a canvas.
//
// Why the browser resizes at all: a phone photo is 3–8 MB; adapter-node refuses
// request bodies over 512K and Nginx over 1m, so the original can never be sent
// (src/lib/menu-images.ts owns the numbers). The output is WebP when the browser
// can encode it, else JPEG — NEVER PNG, whose lossless re-encode can EXCEED the
// cap. The server still validates independently (magic bytes and size): this
// is a convenience for the owner, not a control.
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE } from './menu-images';

/**
 * Scale so the LONGER edge is at most `maxEdge`, keeping the ratio. Never scales
 * up, rounds with Math.round, and never returns less than 1 on either side.
 */
export function targetSize(
	width: number,
	height: number,
	maxEdge = IMAGE_MAX_EDGE
): { width: number; height: number } {
	const longer = Math.max(width, height);
	if (longer <= maxEdge) {
		return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
	}
	const scale = maxEdge / longer;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}

// Encoder quality steps, best first. These are canvas encoder settings, not money.
const QUALITIES = [0.85, 0.75, 0.65, 0.5];

const UNREADABLE = 'That file is not a photo this browser can read.';
const TOO_LARGE = 'This photo cannot be made smaller than 400 KB. Try another photo.';

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Try every quality for one type. Resolves to the first blob that fits, or null
 * when nothing fits — or immediately null when the browser answers with ANOTHER
 * type, which is how a canvas says it has no encoder for the one asked (Safari
 * and WebP, for example).
 */
async function encodeUnder(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
	for (const quality of QUALITIES) {
		const blob = await toBlob(canvas, type, quality);
		if (!blob) continue;
		if (blob.type !== type) return null;
		if (blob.size <= IMAGE_MAX_BYTES) return blob;
	}
	return null;
}

/**
 * Decode a photo, scale it to at most IMAGE_MAX_EDGE on the longer side, and
 * re-encode it under IMAGE_MAX_BYTES as WebP, else JPEG. If nothing fits at the
 * first size, halve the dimensions ONCE and try again; then give up with a
 * message the panel shows as it is.
 */
export async function resizePhoto(file: File): Promise<Blob> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		throw new Error(UNREADABLE);
	}
	try {
		let size = targetSize(bitmap.width, bitmap.height);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const canvas = document.createElement('canvas');
			canvas.width = size.width;
			canvas.height = size.height;
			const context = canvas.getContext('2d');
			if (!context) throw new Error(UNREADABLE);
			context.drawImage(bitmap, 0, 0, size.width, size.height);
			const blob =
				(await encodeUnder(canvas, 'image/webp')) ?? (await encodeUnder(canvas, 'image/jpeg'));
			if (blob) return blob;
			size = targetSize(size.width / 2, size.height / 2);
		}
	} finally {
		bitmap.close();
	}
	throw new Error(TOO_LARGE);
}
