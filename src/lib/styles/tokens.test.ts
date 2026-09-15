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
const BASE = fileURLToPath(new URL('./base.css', import.meta.url));
const APP_CSS = fileURLToPath(new URL('../../app.css', import.meta.url));
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
const posScope = parseTokens(blockOf(css, '[data-surface="pos"]'));

// Dark falls through the bare :root for anything it does not redeclare — the two
// derived aliases — exactly as the cascade resolves it. The POS scope is PINNED,
// so it is asserted twice: as itself, and layered under a dark page. Those two must
// be value-identical, because the till does not follow the viewer's theme.
const palettes = {
	light: bare,
	dark: new Map([...bare, ...stampDark]),
	pos: new Map([...bare, ...posScope]),
	'pos-under-dark': new Map([...bare, ...stampDark, ...posScope])
} as const;

// Retired 2026-09-14. Once [data-surface="pos"] re-declares --c-bg / --c-raise /
// --c-line for the till, these four had no consumer, and two vocabularies for one
// surface is exactly what the scope removes.
const RETIRED_CHROME = ['--c-screen', '--c-key', '--c-key-line', '--c-key-ink'];

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

	it('retired the four POS chrome tokens', () => {
		// They are gone, and nothing may reach for them again: --c-screen/--c-key
		// described a device surface that [data-surface="pos"] now expresses with the
		// ordinary ground names, so a component is portable between surfaces.
		for (const token of RETIRED_CHROME) {
			expect(source.includes(token), `${token} is retired — remove it from tokens.css`).toBe(false);
		}
	});

	it('pins the POS scope — it declares every token the dark blocks theme', () => {
		// The rule this test exists to enforce: PIN EVERY TOKEN, NOT JUST THE GROUNDS.
		// A surface pinned one way whose inks still theme is the defect that has now
		// appeared twice — pinned dark with light inks (1.08:1), then pinned light with
		// dark inks (1.21:1). If the dark blocks theme a token, the POS scope must
		// declare its own value for it, or a dark-theme viewer inherits it into a
		// permanently light surface.
		const themed = [...stampDark.keys()];
		const missing = themed.filter((t) => !posScope.has(t));
		expect(
			missing,
			`[data-surface="pos"] must declare these or a dark viewer inherits them into a ` +
				`pinned-light surface: ${missing.join(', ')}`
		).toEqual([]);
	});

	it('pins the POS scope against EVERY token of the bare :root, not only the themed ones', () => {
		// The stronger form of the test above: adding a themed token to :root and
		// forgetting the POS scope now fails here, even before a dark block themes it.
		// There is exactly ONE exemption list — the six menu-category bands — and it is
		// PROVED rather than trusted: a token may be exempt only while it is
		// theme-invariant, i.e. absent from both dark blocks.
		const CATEGORY_BANDS = [
			'--c-cat-grills',
			'--c-cat-rice',
			'--c-cat-somali',
			'--c-cat-drinks',
			'--c-cat-sides',
			'--c-cat-sweets'
		];
		for (const band of CATEGORY_BANDS) {
			expect(bare.has(band), `${band} is not in the bare :root`).toBe(true);
			expect(
				mediaDark.has(band),
				`${band} is exempt from the POS scope only while it is theme-invariant, but the dark media block themes it`
			).toBe(false);
			expect(
				stampDark.has(band),
				`${band} is exempt from the POS scope only while it is theme-invariant, but the dark stamp block themes it`
			).toBe(false);
		}

		const missing = [...bare.keys()].filter(
			(token) => !posScope.has(token) && !CATEGORY_BANDS.includes(token)
		);
		expect(
			missing,
			`[data-surface="pos"] must declare its own value for every token of the bare :root: ${missing.join(', ')}`
		).toEqual([]);
	});

	it('re-declares its var() aliases inside the POS scope', () => {
		// A custom property's var() is substituted at COMPUTED-VALUE time on the element
		// that DECLARES it, and the resolved literal is what inherits. [data-surface="pos"]
		// is an element inside <body>, not :root, so an alias declared above it never
		// recomputes there. The dark blocks need no copy (same element); this scope does.
		// A contrast assertion cannot catch this: resolve() follows var() in TEXT and
		// would report the intended value either way. The declaration check is the defence.
		for (const alias of [...bare.keys()].filter((k) => /^var\(--c-/.test(bare.get(k) ?? ''))) {
			expect(
				posScope.has(alias),
				`${alias} is a var() alias and MUST be re-declared in [data-surface="pos"] — ` +
					`it will not recompute there on its own`
			).toBe(true);
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

function ratioOf(ink: string, surface: string, theme: keyof typeof palettes): number {
	const palette = palettes[theme];
	const a = resolve(ink, palette);
	const b = resolve(surface, palette);
	expect(a, `--c-${ink} did not resolve to a hex in the ${theme} palette`).not.toBeNull();
	expect(b, `--c-${surface} did not resolve to a hex in the ${theme} palette`).not.toBeNull();
	return contrast(a as string, b as string);
}

// THE FULL CENSUS, generated rather than listed. Every ground token against every
// ink token, in every surface state. A failing pair is repaired by re-solving the
// token's VALUE and re-running this census — never by removing the pair from the
// list. The earlier hand-written "legal pairs" list hid 30 real failures simply by
// not naming them.
const GROUNDS = [
	'bg',
	'bg-2',
	'raise',
	'raise-2',
	'accent-soft',
	'ok-bg',
	'warn-bg',
	'danger-bg',
	'st-new-bg',
	'st-sent-bg',
	'st-voided-bg',
	'st-billed-bg',
	'st-paid-bg',
	'st-offline-bg'
];
const INKS = [
	'ink',
	'ink-2',
	'ink-3',
	'accent',
	'ok',
	'warn',
	'danger',
	'st-new',
	'st-sent',
	'st-voided',
	'st-billed',
	'st-paid',
	'st-offline'
];

const TEXT_PAIRS: Array<[string, string]> = GROUNDS.flatMap((g) =>
	INKS.map((i): [string, string] => [i, g])
);

// On-fill pairs: ink rendered ON a filled control rather than on a page ground.
const ON_FILL_PAIRS: Array<[string, string]> = [
	['accent-ink', 'accent'],
	['danger-ink', 'danger'],
	['disabled-ink', 'disabled-bg'],
	// The navigation rail is a coloured object, so everything it holds is an
	// on-fill pair. The page inks are built for a light ground and are illegible
	// here — --c-ink-2 on --c-rail measures 1.23:1 — which is precisely why the
	// rail has its own family and why those pairs are asserted rather than assumed.
	['rail-ink', 'rail'],
	['rail-ink', 'rail-active'], // the SELECTED row's label, on the accent
	['rail-ink-2', 'rail'],
	['rail-ink-2', 'rail-raise'], // hover, and any pill that takes a fill
	['rail', 'rail-ink'] // the brand tile: rail-coloured letter on a white square
	// NOT ['rail-ink-2', 'rail-active']: the muted ink never lands on the selected
	// row. It did when rail-active was a deeper teal that the Soon pill used as a
	// fill; the pill now takes a border and rail-active means "the page you are on",
	// where the label is rail-ink. Asserting a pair the product cannot render is how
	// a census stops describing the product.
];

// WCAG 1.4.11 — UI component boundaries and focus indicators, 3:1.
const NON_TEXT_PAIRS: Array<[string, string]> = [
	['control-line', 'raise'],
	['control-line', 'bg'],
	['control-line', 'bg-2'],
	['control-line', 'raise-2'],
	['ring', 'bg'],
	['ring', 'raise'],
	['rail-line', 'rail'],
	// The SELECTED ROW'S INDICATOR, not its fill. --c-rail-active on --c-rail is
	// 1.54:1 by design — a quiet wash, because the selection is carried by the left
	// bar (this pair), by font weight and by aria-current, never by the fill alone.
	// Asserting the fill at 3:1 would be applying a boundary rule to something that
	// is not a boundary, and would force a selected row loud enough to shout.
	['rail-ink', 'rail']
];

describe('the contrast floor holds in BOTH themes', () => {
	for (const theme of ['light', 'dark', 'pos', 'pos-under-dark'] as const) {
		it.each(TEXT_PAIRS)(`${theme}: text-%s on bg-%s meets WCAG AA 4.5:1`, (ink, surface) => {
			const ratio = ratioOf(ink, surface, theme);
			expect(
				ratio,
				`text-${ink} on bg-${surface} measures ${ratio.toFixed(2)}:1 in ${theme}, below the ` +
					'4.5:1 floor CLAUDE.md calls non-negotiable. Change WHICH TOKEN is used, never the ' +
					'token’s value — see docs/design-system.md section 7b.'
			).toBeGreaterThanOrEqual(4.5);
		});

		// Ink rendered ON a filled control, not on a page ground. This is the pair a
		// hardcoded literal breaks: white on the LIGHT --c-danger is 6.65, but the dark
		// palette lightens that red for legibility on a dark ground and white then
		// measures 2.66. Every filled control names an ink role for exactly this reason.
		it.each(ON_FILL_PAIRS)(`${theme}: text-%s on bg-%s meets WCAG AA 4.5:1`, (ink, surface) => {
			const ratio = ratioOf(ink, surface, theme);
			expect(
				ratio,
				`text-${ink} on bg-${surface} measures ${ratio.toFixed(2)}:1 in ${theme}, below the ` +
					'4.5:1 floor. A filled control must name an ink token per surface state — never a ' +
					'literal, and never `opacity`, which composites fill and ink together and defeats ' +
					'this check entirely.'
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

/* ── T-06's element base layer ───────────────────────────────────────────── */

describe('the element base layer', () => {
	// T-03's arbitrary-value scan covers .svelte files; base.css is a .css file, so
	// its no-literal rule is asserted here instead.
	it('base.css defines no colour of its own', () => {
		const base = readFileSync(BASE, 'utf8');
		const hex = /#[0-9a-fA-F]{6}\b/.exec(base)?.[0];
		expect(
			hex,
			`src/lib/styles/base.css contains the raw hex ${hex}. The base layer applies in BOTH ` +
				'themes, so a literal colour there freezes one theme’s value into both. Every colour ' +
				'and every font value in that file must be a var(--…) reference.'
		).toBeUndefined();
	});

	it('app.css imports base.css AFTER tokens.css', () => {
		// base.css references --c-bg, --c-ink, --c-ring, --c-accent-soft and the font
		// tokens. Imported first, those names are undefined and the declarations that
		// use them are dropped — silently, with no error anywhere.
		const app = readFileSync(APP_CSS, 'utf8');
		const tokensAt = app.indexOf('./lib/styles/tokens.css');
		const baseAt = app.indexOf('./lib/styles/base.css');
		expect(tokensAt, 'src/app.css does not import ./lib/styles/tokens.css').toBeGreaterThan(-1);
		expect(baseAt, 'src/app.css does not import ./lib/styles/base.css').toBeGreaterThan(-1);
		expect(
			baseAt,
			'src/app.css imports base.css BEFORE tokens.css. The tokens base.css references ' +
				'would be undefined at that point and its declarations silently dropped.'
		).toBeGreaterThan(tokensAt);
	});
});
