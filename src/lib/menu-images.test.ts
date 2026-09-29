import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	IMAGE_CONTENT_TYPES,
	IMAGE_MAX_BYTES,
	IMAGE_MAX_EDGE,
	dashboardImageUrl,
	tillImageUrl
} from './menu-images';

describe('menu photo limits (menu-and-printing T-12)', () => {
	it("stays under adapter-node's default 512K body limit with multipart headroom", () => {
		expect(IMAGE_MAX_BYTES).toBe(409_600);
		// The cap plus generous multipart framing must fit under 512K = 524,288.
		expect(IMAGE_MAX_BYTES + 16_384).toBeLessThan(524_288);
	});

	it('pins the edge and the three raster types — never SVG', () => {
		expect(IMAGE_MAX_EDGE).toBe(1024);
		expect([...IMAGE_CONTENT_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
		expect([...IMAGE_CONTENT_TYPES]).not.toContain('image/svg+xml');
	});

	it('builds the till and dashboard URLs', () => {
		expect(tillImageUrl('abc')).toBe('/api/menu/images/abc');
		expect(dashboardImageUrl('abc')).toBe('/menu/images/abc');
	});

	// The isomorphic rule: no sibling, no $lib, no Node builtin — comments stripped
	// first, because the header talks about importing.
	it('imports nothing', () => {
		const source = readFileSync(new URL('./menu-images.ts', import.meta.url), 'utf8');
		const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		expect(stripped).not.toMatch(/^\s*import\b/m);
		expect(stripped).not.toMatch(/\bfrom\s+['"]/);
		expect(stripped).not.toMatch(/\bimport\(/);
		expect(stripped).not.toMatch(/\brequire\(/);
	});
});
