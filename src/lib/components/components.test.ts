// The component boundary: a ui/ primitive takes its data as PROPS and imports
// nothing from $lib/server.
//
// Why this exists BESIDE eslint: eslint.config.js scopes its no-restricted-imports
// rule to ['src/lib/pos/**/*.{ts,svelte}', 'src/routes/(pos)/**/*.{ts,svelte}'] — by
// IMPORTING FILE. That rule is syntactic and per-file, so it would not catch a
// future POS route importing a shared component that itself imports $lib/server.
// This test is what closes that gap. src/lib/components/** sits outside every
// boundary guard in eslint.config.js today.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPONENTS = fileURLToPath(new URL('.', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** Discover components. NEVER a hard-coded list — a file added later is covered automatically. */
function findComponents(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			findComponents(full, found);
		} else if (
			(entry.endsWith('.svelte') || entry.endsWith('.ts')) &&
			// THIS FILE lives inside the directory it walks and necessarily contains every
			// forbidden string it looks for. Excluding it is mandatory, not tidiness:
			// included, the suite fails on its own source.
			full !== SELF
		) {
			found.push(full);
		}
	}
	return found;
}

/**
 * Strip comments before the text rules below. This plan repeatedly asks authors to
 * record their rationale in a comment — including Button's note that p-touch must
 * never be used and StatusMark's block about the statuses it deliberately does not
 * support — so a CORRECT component would otherwise fail its own guard on its own
 * prose. Rules (b) and (c) run on stripped text; rule (a) stays on the RAW text,
 * because a commented-out $lib/server import is still worth flagging.
 *
 * Do NOT "simplify" this stripping away and then weaken the patterns to make the
 * suite green again — that trades a precise guard for a vague one.
 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SERVER_IMPORTS = ['$lib/server', '../server/', 'lib/server'];

// The standing-thumb targets and the POS device chrome. The dashboard is seated and
// mouse-driven and uses Tailwind's default scale.
const POS_TOKENS = [
	'p-touch',
	'min-h-touch',
	'touch-min',
	'touch-lg',
	'touch-xl',
	'bg-screen',
	'bg-key',
	'text-key-ink'
];

const components = findComponents(COMPONENTS);

describe('the ui/ component boundary', () => {
	it('finds component files to check at all', () => {
		// A walk that silently found nothing would pass every assertion below it —
		// precisely how a "green" suite proves nothing.
		expect(components.length).toBeGreaterThan(0);
	});

	it.each(components.map((f) => [relative(COMPONENTS, f), f]))(
		'%s imports nothing from $lib/server',
		(label, file) => {
			// RAW text: this catches static import, `export … from` and dynamic import()
			// in one rule, and flags a commented-out server import too.
			const raw = readFileSync(file, 'utf8');
			for (const needle of SERVER_IMPORTS) {
				expect(
					raw.includes(needle),
					`${label} references "${needle}". A ui/ primitive takes its data as PROPS. ` +
						'Importing $lib/server here would drag the database client into the client ' +
						'bundle and make a shared component a back door around the route guards.'
				).toBe(false);
			}
		}
	);

	it.each(components.map((f) => [relative(COMPONENTS, f), f]))(
		'%s uses tokens only, and no POS-only token',
		(label, file) => {
			const code = stripComments(readFileSync(file, 'utf8'));

			expect(
				/\[#[0-9a-fA-F]{3,8}\]/.exec(code)?.[0],
				`${label} contains an arbitrary colour value. Add a token to ` +
					'src/lib/styles/tokens.css instead — it is the ONLY place a colour is defined.'
			).toBeUndefined();

			expect(
				/\[\d+(?:\.\d+)?px\]/.exec(code)?.[0],
				`${label} contains an arbitrary size value. Add a token to ` +
					'src/lib/styles/tokens.css instead.'
			).toBeUndefined();

			expect(
				/#[0-9a-fA-F]{6}\b/.exec(code)?.[0],
				`${label} contains a raw hex. src/lib/styles/tokens.css is the ONLY place a ` +
					'colour is defined.'
			).toBeUndefined();

			for (const token of POS_TOKENS) {
				expect(
					code.includes(token),
					`${label} uses the POS token "${token}". Those are 56-96px targets for a ` +
						'standing thumb, and the POS device chrome. The dashboard is seated and ' +
						"mouse-driven — use Tailwind's default scale."
				).toBe(false);
			}
		}
	);
});
