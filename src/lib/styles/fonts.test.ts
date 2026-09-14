// The typefaces are actually delivered — asserted against the INSTALLED packages.
//
// A test that merely grepped for the presence of an import line would PASS in the
// exact broken state this file exists to catch: packages installed, imports present,
// family names mismatched, every page still rendering in system-ui, with pnpm check,
// pnpm lint, pnpm test and both e2e specs green. A browser matches @font-face by the
// DECLARED family string, so the only assertion worth making compares the name each
// package declares against the name the token stack asks for.
//
// The declared names are EXTRACTED from node_modules, never hardcoded here, so a
// future package release that renames a family fails this test instead of passing it.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/lib/styles/ is three levels below the repository root.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const FONT_PACKAGES = [
	'@fontsource-variable/archivo',
	'@fontsource-variable/ibm-plex-sans',
	'@fontsource/ibm-plex-mono'
] as const;

// Each package's CSS entry point, and the token stack whose first name must match
// the family that entry point declares.
const DELIVERY = [
	{ entry: '@fontsource-variable/archivo/wght.css', token: '--font-display' },
	{ entry: '@fontsource-variable/ibm-plex-sans/wght.css', token: '--font-sans' },
	{ entry: '@fontsource/ibm-plex-mono/400.css', token: '--font-mono' }
] as const;

// Every entry point the root layout must import. wght.css is the WEIGHT axis only;
// the variable packages also ship a width axis the design system never asks for.
const LAYOUT_IMPORTS = [
	'@fontsource-variable/archivo/wght.css',
	'@fontsource-variable/ibm-plex-sans/wght.css',
	'@fontsource/ibm-plex-mono/400.css',
	'@fontsource/ibm-plex-mono/500.css'
] as const;

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const tokens = readFileSync(join(ROOT, 'src/lib/styles/tokens.css'), 'utf8');
const layout = readFileSync(join(ROOT, 'src/routes/+layout.svelte'), 'utf8');

/** Read a package file out of node_modules, failing with a clear message, never an opaque ENOENT. */
function readInstalled(relative: string): string {
	const full = join(ROOT, 'node_modules', relative);
	if (!existsSync(full)) {
		throw new Error(
			`${relative} is not installed. Run \`pnpm install\` (with \`nvm use\` first — Node is ` +
				'pinned to 24.21.0 in .nvmrc and engine-strict refuses anything else).'
		);
	}
	return readFileSync(full, 'utf8');
}

/** Every distinct family name declared by the @font-face blocks in a stylesheet. */
function declaredFamilies(css: string): string[] {
	const out = new Set<string>();
	for (const m of css.matchAll(/font-family:\s*(['"])(.+?)\1/g)) out.add(m[2]);
	return [...out];
}

/** One --font-* declaration, up to its `;`. */
function stack(name: string): string {
	const m = new RegExp(`${name}\\s*:([^;]+);`).exec(tokens);
	expect(m, `${name} is not declared in src/lib/styles/tokens.css`).not.toBeNull();
	return (m as RegExpExecArray)[1].trim();
}

/** Compare ignoring quote style — the package writes 'X' and the token writes "X". */
function stackNames(name: string): string[] {
	return stack(name)
		.split(',')
		.map((part) => part.trim().replace(/^['"]|['"]$/g, ''));
}

describe('the font packages are installed and pinned', () => {
	it.each(FONT_PACKAGES)('%s is a devDependency', (name) => {
		expect(
			pkg.devDependencies?.[name],
			`${name} is missing from devDependencies. Vite bundles these at build time and ` +
				'nothing imports them on the server, so devDependencies is where they belong.'
		).toBeDefined();
	});

	it.each(FONT_PACKAGES)('%s is pinned exactly, with no ^ or ~', (name) => {
		const version = pkg.devDependencies?.[name];
		expect(
			version,
			`${name} is pinned as "${version}". Every dependency in this repository is pinned ` +
				'exactly — no ^, no ~ — so a font release cannot change the rendered face silently.'
		).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe('the root layout imports every entry point', () => {
	it.each(LAYOUT_IMPORTS)('src/routes/+layout.svelte imports %s', (entry) => {
		expect(
			layout.includes(entry),
			`src/routes/+layout.svelte does not import '${entry}'. Without it that face is ` +
				'never requested and the text renders in the next stack entry instead.'
		).toBe(true);
	});
});

describe('each token stack names the family its package actually declares', () => {
	// THE ASSERTION THAT CATCHES THE SILENT FAILURE. @fontsource-variable/archivo
	// declares 'Archivo Variable', not 'Archivo'; @fontsource-variable/ibm-plex-sans
	// declares 'IBM Plex Sans Variable', not 'IBM Plex Sans'. A stack naming only the
	// plain name matches no @font-face and the page renders in system-ui.
	it.each(DELIVERY)('$entry -> $token', ({ entry, token }) => {
		const families = declaredFamilies(readInstalled(entry));
		expect(
			families.length,
			`${entry} declares no @font-face family at all — the package layout has changed.`
		).toBeGreaterThan(0);

		const names = stackNames(token);
		for (const family of families) {
			expect(
				names.includes(family),
				`${entry} declares font-family '${family}', but ${token} is "${stack(token)}" and ` +
					`does not name it. A browser matches @font-face by the DECLARED family string, so ` +
					`the face would go unused and the text would render in the next stack entry — ` +
					`silently, with every check, lint, test and e2e spec still green. Add '${family}' ` +
					`to ${token} in src/lib/styles/tokens.css.`
			).toBe(true);
		}
	});
});

describe('every stack degrades to a readable generic', () => {
	// A failed download must land on something readable, not on the browser default
	// for an unknown family.
	it.each([
		['--font-display', 'sans-serif'],
		['--font-sans', 'sans-serif'],
		['--font-mono', 'monospace']
	])('%s ends in %s', (token, generic) => {
		const names = stackNames(token);
		expect(
			names[names.length - 1],
			`${token} is "${stack(token)}" and does not end in ${generic}. If the webfont fails ` +
				'to download there must still be a sensible face to fall back to.'
		).toBe(generic);
	});
});
