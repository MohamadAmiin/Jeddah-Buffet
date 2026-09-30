import { and, eq } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import { menuImages } from '../db/schema/menu';
import { IMAGE_CONTENT_TYPES, type ImageContentType } from '../../menu-images';

// MENU PHOTOS — the read side and the byte-level checks (spec 4, 5; tasks/
// menu-and-printing T-07). The WRITE side (setItemImage, removeItemImage) lives
// in ./index.ts because every menu write must run inside the module-private
// withMenuVersionBump; this file holds what needs no version.
//
// THE TYPE IS DECIDED BY MAGIC BYTES, never by the client's declared MIME type or
// the file's extension: a browser will happily label an SVG "image/png". Only the
// three raster formats in IMAGE_CONTENT_TYPES are recognised; SVG, GIF, HTML and
// anything else sniff to null and are refused upstream.
//
// A PHOTO IS READ ONLY THROUGH A RESTAURANT-SCOPED LOOKUP (invariant 8's
// tenant reading): readImage takes the restaurant id from the device row or the
// session, never from the URL, so restaurant B's device asking for A's photo id
// gets null and the route answers 404 — the id alone is never enough.
//
// IMMUTABLE ON THE WIRE: a menu_images row is never updated (a new photo is a
// new row and a new id), so the response may carry max-age=31536000, immutable.
// `private` keeps it out of shared caches; the sandbox CSP, nosniff and
// same-origin CORP mean the bytes render as a picture and nothing else.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	for (let i = 0; i < text.length; i += 1) {
		if (bytes[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

/** JPEG (FF D8 FF), PNG (the 8-byte signature) or WebP (RIFF....WEBP); else null. */
export function sniffImageType(bytes: Uint8Array): ImageContentType | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}
	if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
		return 'image/png';
	}
	if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
		return 'image/webp';
	}
	return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The photo's type and bytes, or null. A malformed id returns null WITHOUT a
 * query, so a hand-typed URL never raises 22P02 (invalid uuid) into a 500.
 */
export async function readImage(
	database: Executor,
	restaurantId: string,
	imageId: string
): Promise<{ contentType: ImageContentType; bytes: Uint8Array } | null> {
	if (!UUID.test(imageId)) return null;
	const [row] = await database
		.select({ contentType: menuImages.contentType, bytes: menuImages.bytes })
		.from(menuImages)
		.where(and(eq(menuImages.restaurantId, restaurantId), eq(menuImages.id, imageId)))
		.limit(1);
	if (!row) return null;
	// The CHECK constraint guarantees this; a row that somehow escaped it is not a photo.
	if (!(IMAGE_CONTENT_TYPES as readonly string[]).includes(row.contentType)) return null;
	return { contentType: row.contentType as ImageContentType, bytes: row.bytes };
}

/** The one response shape both photo routes send. Exactly these seven headers. */
export function imageResponse(image: {
	contentType: ImageContentType;
	bytes: Uint8Array;
}): Response {
	// A fresh copy pins the body to a plain ArrayBuffer for the Response API.
	const body = new Uint8Array(image.bytes);
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': image.contentType,
			'Content-Length': String(body.byteLength),
			'Cache-Control': 'private, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; sandbox",
			'Cross-Origin-Resource-Policy': 'same-origin',
			'Content-Disposition': 'inline'
		}
	});
}
