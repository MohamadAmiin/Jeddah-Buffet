// The theme preference module, and the two halves that must agree with it.
//
// The failure mode worth pinning is not a crash: it is a placeholder nobody
// substitutes. Both halves compile, both suites stay green, and every page ships
// the literal text %matcami.theme% inside its <html> tag.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEME_COOKIE, THEME_MAX_AGE_SECONDS, parseTheme, themeAttribute } from './theme';

describe('parseTheme narrows an untrusted cookie value', () => {
	it('accepts exactly the two real themes', () => {
		expect(parseTheme('light')).toBe('light');
		expect(parseTheme('dark')).toBe('dark');
	});

	it.each([undefined, '', 'system', 'DARK', 'Light', 'dark ', '"dark"', 'dark" onload="x'])(
		'rejects %o',
		(value) => {
			// A cookie value is attacker-supplied and is interpolated into the opening
			// tag of every page. Anything that is not exactly one of the two literals
			// must collapse to null so themeAttribute can only emit a fixed string.
			expect(parseTheme(value as string | undefined)).toBeNull();
		}
	);
});

describe('themeAttribute', () => {
	it('emits nothing at all for the system state', () => {
		// The EMPTY STRING is the system state: no attribute on <html>, so the
		// @media (prefers-color-scheme: dark) block in tokens.css governs. There is
		// deliberately no third Theme value for "system".
		expect(themeAttribute(null)).toBe('');
	});

	it('emits the stamp for an explicit choice', () => {
		expect(themeAttribute('dark')).toBe('data-theme="dark"');
		expect(themeAttribute('light')).toBe('data-theme="light"');
	});
});

describe('the cookie contract', () => {
	it('is named matcami_theme and is NOT the session cookie', () => {
		// Invariant 12 governs matcami_dashboard_session. This one holds no secret and
		// is never read for authorisation; confusing the two is the mistake this
		// assertion exists to catch.
		expect(THEME_COOKIE).toBe('matcami_theme');
		expect(THEME_COOKIE).not.toBe('matcami_dashboard_session');
	});

	it('lives for one year', () => {
		expect(THEME_MAX_AGE_SECONDS).toBe(31536000);
	});
});

describe('the SSR stamp is wired end to end', () => {
	it('src/app.html carries the placeholder exactly once', () => {
		const template = readFileSync(fileURLToPath(new URL('../app.html', import.meta.url)), 'utf8');
		// Exactly one: handleTheme uses String.replace with a string argument, which
		// replaces only the first occurrence.
		expect(template.match(/%matcami\.theme%/g)).toHaveLength(1);
		expect(template).toContain('<html lang="en" %matcami.theme%>');
	});

	it('handleTheme is registered FIRST in the hook sequence', () => {
		const source = readFileSync(
			fileURLToPath(new URL('../hooks.server.ts', import.meta.url)),
			'utf8'
		);
		// Slice from the CALL, not the import: the import line reads `sequence }`.
		const call = source.slice(source.indexOf('sequence('));
		expect(call).toContain('handleTheme');
		expect(call.indexOf('handleTheme')).toBeLessThan(call.indexOf('handleSession'));
	});

	it('handleTheme never reads locals — a theme is not a privilege', () => {
		const source = readFileSync(
			fileURLToPath(new URL('../hooks.server.ts', import.meta.url)),
			'utf8'
		);
		const start = source.indexOf('export const handleTheme');
		const end = source.indexOf('export const handleSession');
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, end);
		expect(
			body.includes('locals'),
			'handleTheme must not read event.locals: it runs before the session is resolved.'
		).toBe(false);
	});
});
