// SOURCE-TEXT conditions on the till's service worker (T-27), asserted here in the
// unit project because they are properties of the source, not of a running
// browser — e2e/pos-service-worker.spec.ts asserts the browser half. The
// readFileSync-on-source idiom is tokens.test.ts's and components.test.ts's. Each
// assertion carries its reason, so nobody deletes one as trivia.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(SRC, '..');

function walk(dir: string, keep: (file: string) => boolean, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, keep, found);
		else if (keep(full)) found.push(full);
	}
	return found;
}

// The same brace-balancing extraction tokens.test.ts uses — copied rather than
// imported, because importing a test file would register its tests here.
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function blockAt(css: string, at: number): string {
	const open = css.indexOf('{', at);
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === '{') depth++;
		else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
	}
	throw new Error(`unbalanced braces after offset ${at}`);
}

function parseTokens(block: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const decl of block.split(';')) {
		const m = /^\s*(--c-[a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(decl);
		if (m) out.set(m[1], m[2].trim());
	}
	return out;
}

describe("the till's service worker, as written", () => {
	// A manifest is JSON: it cannot reference a custom property and cannot carry a
	// comment, so its colours are the one legitimately duplicated colour in the
	// repository — and this is what keeps the copy equal to the POS ground.
	it("gives the manifest the POS surface's own ground colour", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, 'static/pos.webmanifest'), 'utf8'));
		const css = stripComments(readFileSync(join(SRC, 'lib/styles/tokens.css'), 'utf8'));
		const at = css.indexOf('[data-surface="pos"]');
		expect(at, 'tokens.css has no [data-surface="pos"] block').toBeGreaterThanOrEqual(0);
		const ground = parseTokens(blockAt(css, at)).get('--c-bg');
		expect(ground, 'the POS block declares no --c-bg').toBeDefined();
		expect(manifest.background_color.toLowerCase()).toBe(ground!.toLowerCase());
		expect(manifest.theme_color.toLowerCase()).toBe(ground!.toLowerCase());
	});

	// Installability (Chromium's criteria, and what Android and iOS actually draw):
	// a 192 and a 512 PNG, one maskable, each a file that ships in static/ — a
	// manifest naming an icon that is not there installs with a blank tile. The
	// scope and start_url stay the one literal '/pos' (CLAUDE.md: a trailing slash
	// here is never a fix).
	it('names PNG icons at 192 and 512, one maskable, that all exist, and keeps the /pos scope', () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, 'static/pos.webmanifest'), 'utf8'));
		expect(manifest.scope).toBe('/pos');
		expect(manifest.start_url).toBe('/pos');
		expect(manifest.id).toBe('/pos');
		const icons: { src: string; sizes: string; type: string; purpose?: string }[] = manifest.icons;
		expect(icons.some((i) => i.sizes === '192x192' && i.type === 'image/png')).toBe(true);
		expect(icons.some((i) => i.sizes === '512x512' && i.type === 'image/png')).toBe(true);
		expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
		for (const icon of icons) {
			expect(icon.src.startsWith('/')).toBe(true);
			expect(
				existsSync(join(ROOT, 'static', icon.src)),
				`${icon.src} is missing from static/`
			).toBe(true);
		}
		// iOS reads none of the above: the shell links an apple-touch-icon instead.
		const shell = readFileSync(join(SRC, 'routes/(pos)/pos/+layout.svelte'), 'utf8');
		const apple = /rel="apple-touch-icon"\s+href="([^"]+)"/.exec(shell);
		expect(apple, 'the POS shell links no apple-touch-icon').not.toBeNull();
		expect(existsSync(join(ROOT, 'static', apple![1]))).toBe(true);
	});

	// One registration, from the POS layout, scoped to exactly '/pos': a second call
	// anywhere — or SvelteKit's automatic one — puts a worker in charge of pages that
	// are not the till's. Whitespace is dropped first, because the call is split
	// across lines in the source.
	it('is registered exactly once, from the POS layout, with scope /pos', () => {
		// Test files are skipped: a test contains the strings it searches for — this
		// one above all (components.test.ts documents the same trap).
		const callers = walk(
			SRC,
			(file) => /\.(ts|js|svelte)$/.test(file) && !file.endsWith('.test.ts')
		).filter((file) =>
			readFileSync(file, 'utf8').replace(/\s+/g, '').includes('navigator.serviceWorker.register(')
		);
		expect(callers.map((file) => relative(SRC, file).split(sep).join('/'))).toEqual([
			'routes/(pos)/pos/+layout.svelte'
		]);
		const layout = readFileSync(callers[0], 'utf8').replace(/\s+/g, '');
		expect(layout).toContain(".register('/service-worker.js',{scope:'/pos',");
	});

	// "Never cache a response that varies by session" is STRUCTURAL: the one cache
	// write is the install-time addAll, and there is no put at all.
	it('writes to Cache Storage only once, at install, and never with put', () => {
		const worker = readFileSync(join(SRC, 'service-worker.ts'), 'utf8');
		expect(worker).not.toContain('.put(');
		expect(worker.split('addAll(').length - 1).toBe(1);
	});
});

// THE STRUCTURAL GUARD. The worker's /pos scope is a string prefix over the whole
// URL, not a path-segment match, so any route OUTSIDE the (pos) group whose path
// merely starts with the characters "pos" — a /pos-device, a /poster — would be
// controlled by the till's worker and served from the till's cache after logout.
// That is why the dashboard page for the till is /device. There is deliberately no
// allow-list: the answer to a future offender is to rename it.
const ROUTE_FILES = new Set([
	'+page.svelte',
	'+page.ts',
	'+page.server.ts',
	'+layout.server.ts',
	'+server.ts'
]);
const ROUTES_DIR = join(SRC, 'routes');

/** src/routes/<dirs>/<file> -> the route id, (group) segments kept. */
function routeIdOf(file: string): string {
	return '/' + relative(ROUTES_DIR, file).split(sep).slice(0, -1).join('/');
}

/** The URL path a route id serves: (group) segments are not URL segments. */
function urlPathOf(routeId: string): string {
	return (
		'/' +
		routeId
			.split('/')
			.filter((s) => s && !/^\(.*\)$/.test(s))
			.join('/')
	);
}

function offenders(routeIds: string[]): string[] {
	return routeIds.filter((id) => !id.startsWith('/(pos)') && urlPathOf(id).startsWith('/pos'));
}

describe('no route outside the (pos) group has a URL beginning with "pos"', () => {
	const routeIds = [
		...new Set(walk(ROUTES_DIR, (f) => ROUTE_FILES.has(f.split(sep).pop()!)).map(routeIdOf))
	];

	it('finds the till and the dashboard routes to check', () => {
		expect(routeIds).toContain('/(pos)/pos');
		expect(routeIds).toContain('/(dashboard)/device');
	});

	it('finds no offender in the real route tree', () => {
		const found = offenders(routeIds);
		expect(
			found,
			`${found.join(', ')} would sit inside the till's /pos service-worker scope, which is a ` +
				'string prefix — rename the route; never widen this test.'
		).toEqual([]);
	});

	// The sanity check made permanent: a prefix test that passes on /pos-device is
	// asserting nothing, and /pos-device is the exact name this plan renamed away from.
	it('does catch /pos-device and /poster, and leaves /api/pos and /device alone', () => {
		expect(
			offenders(['/(dashboard)/pos-device', '/poster', '/api/pos/pin', '/(dashboard)/device'])
		).toEqual(['/(dashboard)/pos-device', '/poster']);
	});
});
