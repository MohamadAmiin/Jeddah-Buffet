// The token contract and the contrast floor, asserted by reading tokens.css as TEXT.
//
// There is no browser here: vitest.config.ts defines exactly two projects, `unit`
// and `integration`, both environment: 'node'. No jsdom, no @testing-library/svelte,
// no browser mode — and none is added. That is a real limit: these tests can prove a
// token exists and that a pair meets a ratio; they cannot prove a rendered page looks
// right. A person opening `pnpm dev` does that.
//
// Why this file exists at all: nothing in this repository verified design-system
// compliance, which is how three typefaces stayed missing for the project's entire
// life while check, lint, test and both e2e specs stayed green.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKENS = fileURLToPath(new URL('./tokens.css', import.meta.url));
const SRC = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Strip comments BEFORE anything else looks at this file. The header comment names
 * all three selectors in prose — `bare :root`, `:root:not([data-theme="light"])`,
 * `:root[data-theme="dark"]` — and also writes `--c-*` and `var(--c-bg)`. A naive
 * indexOf(':root') finds the comment, not the rule, and a naive token regex harvests
 * the comment's example names.
 */
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Return the contents of the brace-balanced block whose selector starts at `from`.
 * Balancing matters for the dark media query: it WRAPS a second selector, so its
 * closing brace is not the first one. Stopping at the first `}` truncates the
 * palette, and the test then passes against almost nothing.
 */
function blockAt(css: string, from: number): string {
	const open = css.indexOf('{', from);
	if (open === -1) throw new Error('no block found');
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === '{') depth++;
		else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
	}
	throw new Error('unbalanced braces in tokens.css');
}

function blockOf(css: string, selector: string): string {
	const at = css.indexOf(selector);
	expect(at, `selector ${selector} is missing from tokens.css`).toBeGreaterThanOrEqual(0);
	return blockAt(css, at);
}

/**
 * Parse by `;`-terminated declaration, never by line. The palette packs several
 * declarations onto one line (`--c-bg:#e9edf0; --c-bg-2:#dfe5e9; …`), so a
 * line-based parser sees one token per line and silently misses most of them.
 */
function parseTokens(block: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const decl of block.split(';')) {
		const m = /^\s*(--c-[a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(decl);
		if (m) out.set(m[1], m[2].trim());
	}
	return out;
}

const source = readFileSync(TOKENS, 'utf8');
const css = stripComments(source);

const bare = parseTokens(blockOf(css, ':root {'));
// The media query wraps `:root:not([data-theme="light"])`; take the inner block.
const mediaOuter = blockOf(css, '@media (prefers-color-scheme: dark)');
const mediaDark = parseTokens(blockAt(mediaOuter, mediaOuter.indexOf(':root:not(')));
const stampDark = parseTokens(blockOf(css, ':root[data-theme="dark"]'));

// Dark falls through the bare :root for anything it does not redeclare — the POS
// chrome, and the two derived tokens — exactly as the cascade resolves it.
const palettes = {
	light: bare,
	dark: new Map([...bare, ...stampDark])
} as const;

const POS_CHROME = ['--c-screen', '--c-key', '--c-key-line', '--c-key-ink'];

describe('the token contract', () => {
	it('parsed a real palette out of all three blocks', () => {
		// A parse that silently found nothing would pass every assertion below it.
		expect(bare.size).toBeGreaterThan(20);
		expect(mediaDark.size).toBeGreaterThan(20);
		expect(stampDark.size).toBeGreaterThan(20);
	});

	it('declares every dark-block token in the bare :root as well', () => {
		for (const [name, block] of [
			['@media (prefers-color-scheme: dark)', mediaDark],
			[':root[data-theme="dark"]', stampDark]
		] as const) {
			const missing = [...block.keys()].filter((k) => !bare.has(k));
			expect(
				missing,
				`${missing.join(', ')} is declared in ${name} but NOT in the bare :root. ` +
					'A token defined only inside a media or [data-theme] block is invisible in the ' +
					'un-stamped state, which renders one theme’s text on the other theme’s ground. ' +
					'Declare it in the bare :root.'
			).toEqual([]);
		}
	});

	it('declares the SAME token names in both dark blocks', () => {
		// They are one palette reached by two selectors. A token added to one and
		// forgotten in the other is a silently half-themed page.
		const inMediaOnly = [...mediaDark.keys()].filter((k) => !stampDark.has(k));
		const inStampOnly = [...stampDark.keys()].filter((k) => !mediaDark.has(k));
		expect(inMediaOnly, `missing from :root[data-theme="dark"]: ${inMediaOnly.join(', ')}`).toEqual(
			[]
		);
		expect(
			inStampOnly,
			`missing from @media (prefers-color-scheme: dark): ${inStampOnly.join(', ')}`
		).toEqual([]);
	});

	it('keeps the POS chrome un-themed — bare :root only, neither dark block', () => {
		// The POS shell is a device surface, not page chrome: dark cuts counter glare
		// and keeps the key faces the brightest thing on screen. It stays dark in BOTH
		// themes (CLAUDE.md "Design & UI", docs/design-system.md section 2).
		for (const token of POS_CHROME) {
			expect(bare.has(token), `${token} must be declared in the bare :root`).toBe(true);
			expect(
				mediaDark.has(token),
				`${token} must NOT be redeclared in the dark media block — the POS shell is not themed`
			).toBe(false);
			expect(
				stampDark.has(token),
				`${token} must NOT be redeclared in :root[data-theme="dark"] — the POS shell is not themed`
			).toBe(false);
		}
	});

	it('declares the dashboard scale tokens T-02 added', () => {
		expect(bare.has('--c-ring'), '--c-ring must exist in the bare :root').toBe(true);
		expect(bare.has('--c-control-line'), '--c-control-line must exist in the bare :root').toBe(
			true
		);
		// Derived tokens reference tokens the dark blocks already redefine, and
		// custom-property substitution resolves at USE time, so they follow the theme
		// on their own. Redeclaring them in a dark block would PIN them.
		for (const token of ['--c-ring', '--c-control-line']) {
			expect(mediaDark.has(token), `${token} must not be repeated in the dark media block`).toBe(
				false
			);
			expect(stampDark.has(token), `${token} must not be repeated in the dark stamp block`).toBe(
				false
			);
		}
		for (const token of ['--radius-card', '--radius-control', '--container-page']) {
			expect(source.includes(token), `${token} is missing from tokens.css`).toBe(true);
		}
	});
});

/* ── WCAG contrast, implemented inline — no dependency ───────────────────── */

function channel(c: number): number {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	let h = hex.replace('#', '');
	if (h.length === 3) h = [...h].map((c) => c + c).join('');
	const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Resolve a token to a hex, following a `var(--c-x)` indirection ONE level deep so
 * --c-ring (→ --c-accent) and --c-control-line (→ --c-ink-3) evaluate per theme.
 * Returns null for anything that is not a colour: --c-shadow holds a full box-shadow
 * with commas, parentheses and `rgb(… / .8)`, and must never reach luminance().
 */
function resolve(name: string, palette: Map<string, string>): string | null {
	let value = palette.get(`--c-${name}`);
	if (value === undefined) return null;
	const indirect = /^var\(\s*(--c-[a-z0-9-]+)\s*\)$/i.exec(value);
	if (indirect) value = palette.get(indirect[1]);
	if (value === undefined) return null;
	return HEX.test(value.trim()) ? value.trim() : null;
}

function ratioOf(ink: string, surface: string, theme: 'light' | 'dark'): number {
	const palette = palettes[theme];
	const a = resolve(ink, palette);
	const b = resolve(surface, palette);
	expect(a, `--c-${ink} did not resolve to a hex in the ${theme} palette`).not.toBeNull();
	expect(b, `--c-${surface} did not resolve to a hex in the ${theme} palette`).not.toBeNull();
	return contrast(a as string, b as string);
}

// The LEGAL pairs from docs/design-system.md section 7b, and only those. The known
// failing pairs are deliberately NOT asserted: the grammar forbids using them, so
// pinning them here would freeze a defect in place and make the eventual palette fix
// look like a regression. If a pair below FAILS, stop and report it — do not fix it
// by editing a colour value. Palette re-tuning is a decision the user deferred.
const GROUNDS = ['bg', 'bg-2', 'raise', 'raise-2'];
const STATUS = ['st-new', 'st-sent', 'st-voided', 'st-billed', 'st-paid', 'st-offline'];

const TEXT_PAIRS: Array<[string, string]> = [
	...GROUNDS.map((s): [string, string] => ['ink', s]),
	...GROUNDS.map((s): [string, string] => ['ink-2', s]),
	// raise ONLY: it is the one surface where ink-3 clears 4.5:1 in BOTH themes
	// (5.13 light, 4.87 dark). Light raise-2 passes at 4.76, but dark raise-2 is
	// 4.25, so asserting it would fail.
	['ink-3', 'raise'],
	...['accent', 'ok', 'warn', 'danger'].flatMap((ink): Array<[string, string]> => [
		[ink, 'bg'],
		[ink, 'raise']
	]),
	...STATUS.flatMap((ink): Array<[string, string]> => [
		[ink, 'bg'],
		[ink, 'raise']
	]),
	['accent-ink', 'accent']
];

// WCAG 1.4.11 — UI component boundaries and focus indicators, 3:1.
const NON_TEXT_PAIRS: Array<[string, string]> = [
	['control-line', 'raise'],
	['control-line', 'bg'],
	['ring', 'bg'],
	['ring', 'raise']
];

describe('the contrast floor holds in BOTH themes', () => {
	for (const theme of ['light', 'dark'] as const) {
		it.each(TEXT_PAIRS)(`${theme}: text-%s on bg-%s meets WCAG AA 4.5:1`, (ink, surface) => {
			const ratio = ratioOf(ink, surface, theme);
			expect(
				ratio,
				`text-${ink} on bg-${surface} measures ${ratio.toFixed(2)}:1 in ${theme}, below the ` +
					'4.5:1 floor CLAUDE.md calls non-negotiable. Change WHICH TOKEN is used, never the ' +
					'token’s value — see docs/design-system.md section 7b.'
			).toBeGreaterThanOrEqual(4.5);
		});

		it.each(NON_TEXT_PAIRS)(`${theme}: %s on %s meets WCAG 1.4.11 3:1`, (ink, surface) => {
			const ratio = ratioOf(ink, surface, theme);
			expect(
				ratio,
				`${ink} on ${surface} measures ${ratio.toFixed(2)}:1 in ${theme}, below the 3:1 floor ` +
					'WCAG 1.4.11 asks of a UI component boundary or focus indicator.'
			).toBeGreaterThanOrEqual(3);
		});
	}
});

/* ── No arbitrary values anywhere in the component tree ──────────────────── */

function findSvelte(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) findSvelte(full, found);
		else if (entry.endsWith('.svelte')) found.push(full);
	}
	return found;
}

const svelteFiles = findSvelte(SRC);

describe('no arbitrary value escapes the token file', () => {
	it('finds .svelte files to check at all', () => {
		// A walk that silently found nothing would pass every assertion below it.
		expect(svelteFiles.length).toBeGreaterThan(0);
	});

	it.each(svelteFiles.map((f) => [relative(SRC, f), f]))('%s uses tokens only', (label, file) => {
		const text = readFileSync(file, 'utf8');
		// True at plan time and locked in here. If this fails, the fix is to add a
		// token to src/lib/styles/tokens.css — NEVER to loosen the regex.
		expect(
			/\[#[0-9a-fA-F]{3,8}\]/.exec(text)?.[0],
			`${label} contains an arbitrary colour value. Add a token to tokens.css instead.`
		).toBeUndefined();
		expect(
			/\[\d+(?:\.\d+)?px\]/.exec(text)?.[0],
			`${label} contains an arbitrary size value. Add a token to tokens.css instead.`
		).toBeUndefined();
		expect(
			/#[0-9a-fA-F]{6}\b/.exec(text)?.[0],
			`${label} contains a raw hex. tokens.css is the ONLY place a colour is defined.`
		).toBeUndefined();
	});
});
