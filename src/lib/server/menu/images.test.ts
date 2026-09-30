import { describe, expect, it } from 'vitest';
import { imageResponse, sniffImageType } from './images';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe('sniffImageType (menu-and-printing T-07)', () => {
	it('recognises JPEG by FF D8 FF', () => {
		expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46))).toBe(
			'image/jpeg'
		);
	});

	it('recognises PNG by its 8-byte signature', () => {
		expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
			'image/png'
		);
	});

	it('recognises WebP by RIFF....WEBP', () => {
		const webp = new Uint8Array([
			...ascii('RIFF'),
			0x24,
			0x00,
			0x00,
			0x00,
			...ascii('WEBP'),
			...ascii('VP8 ')
		]);
		expect(sniffImageType(webp)).toBe('image/webp');
	});

	it('refuses SVG, GIF, WAVE, an empty array and a truncated JPEG signature', () => {
		expect(sniffImageType(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
		expect(sniffImageType(ascii('GIF89a'))).toBeNull();
		expect(
			sniffImageType(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))
		).toBeNull();
		expect(sniffImageType(new Uint8Array(0))).toBeNull();
		expect(sniffImageType(bytes(0xff, 0xd8))).toBeNull();
	});
});

describe('imageResponse', () => {
	it('sets exactly the seven headers and the bytes', async () => {
		const response = imageResponse({ contentType: 'image/webp', bytes: bytes(1, 2, 3) });
		expect(response.status).toBe(200);
		expect([...response.headers.keys()].sort()).toEqual(
			[
				'cache-control',
				'content-disposition',
				'content-length',
				'content-security-policy',
				'content-type',
				'cross-origin-resource-policy',
				'x-content-type-options'
			].sort()
		);
		expect(response.headers.get('Content-Type')).toBe('image/webp');
		expect(response.headers.get('Content-Length')).toBe('3');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
		expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
		expect(response.headers.get('Content-Disposition')).toBe('inline');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes(1, 2, 3));
	});
});
