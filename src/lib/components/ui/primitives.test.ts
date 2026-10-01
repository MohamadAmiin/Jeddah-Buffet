import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

function readPrimitive(name: string): string {
	return readFileSync(fileURLToPath(new URL(`./${name}.svelte`, import.meta.url)), 'utf8');
}

describe('dashboard UI primitives', () => {
	it('CheckField puts its checkbox inside a label', () => {
		const source = readPrimitive('CheckField');

		expect(source).toMatch(/<label[^>]*>[\s\S]*<input[^>]*type="checkbox"/);
	});

	it('SelectField renders a select with the control-line token', () => {
		const source = readPrimitive('SelectField');

		expect(source).toContain('<select');
		expect(source).toContain('border-control-line');
	});

	it('Table has an accessible caption and mobile column labels', () => {
		const source = readPrimitive('Table');

		expect(source).toMatch(/<caption[^>]*class="[^"]*sr-only/);
		expect(source).toMatch(/<span[^>]*class="[^"]*md:hidden/);
	});

	it('StatusMark contains the three dashboard status glyphs', () => {
		const source = readPrimitive('StatusMark');

		expect(source).toContain('\u25CF');
		expect(source).toContain('\u25CB');
		expect(source).toContain('\u2715');
	});

	it('PinField enforces the dashboard PIN input contract', () => {
		const source = readPrimitive('PinField');

		expect(source).toContain('inputmode="numeric"');
		expect(source).toContain('pattern="[0-9]*"');
		expect(source).toContain('maxlength={PIN_MAX_DIGITS}');
		expect(source).toContain("replace(/\\D/g, '')");
		expect(source).toContain('aria-pressed');
		expect(source).not.toContain('console.');
		expect(source).not.toContain('localStorage');
		expect(source).not.toContain('sessionStorage');
	});

	// docs/redesign Phase 6: a primary is chosen on purpose, one per view.
	it('Button defaults to the secondary variant and merges a caller class', () => {
		const source = readPrimitive('Button');

		expect(source).toContain("variant = 'secondary'");
		expect(source).toContain('${className}');
	});

	it('Table insets headers and cells alike, headers in the body face', () => {
		const source = readPrimitive('Table');

		expect(source).toContain('px-6 py-3 text-start');
		expect(source).toContain('md:px-6');
		expect(source).not.toMatch(/<th[\s\S]*?font-mono[\s\S]*?<\/th>/);
	});

	it('ActionBar is a sticky bar at the bottom that follows the page container', () => {
		const source = readPrimitive('ActionBar');

		expect(source).toContain('sticky bottom-0');
		expect(source).toContain('mt-auto');
		expect(source).toContain('max-w-page');
	});

	it('PageColumns keeps the main content first in the DOM unless asideFirst', () => {
		const source = readPrimitive('PageColumns');

		expect(source).toContain('{#if asideFirst}{@render side()}{/if}');
		expect(source).toContain('{#if !asideFirst}{@render side()}{/if}');
		expect(source).toContain('order-first xl:sticky xl:top-6 xl:order-none');
	});

	it.each([
		'CheckField',
		'SelectField',
		'Table',
		'PageHeader',
		'PageBody',
		'PageColumns',
		'CreatePanel',
		'ActionBar',
		'Callout',
		'StatTile'
	])('%s uses no arbitrary values or POS-only tokens', (name) => {
		const source = readPrimitive(name);

		const arbitraryColor = new RegExp('\\[#[0-9a-fA-F]{3,8}\\]');
		const arbitrarySize = new RegExp('\\[\\d+(?:\\.\\d+)?px\\]');
		const posTouch = ['p', 'touch'].join('-');
		const screenToken = ['--c', 'screen'].join('-');

		expect(source).not.toMatch(arbitraryColor);
		expect(source).not.toMatch(arbitrarySize);
		expect(source).not.toContain(posTouch);
		expect(source).not.toContain(screenToken);
	});
});
