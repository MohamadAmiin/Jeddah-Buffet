import { describe, it, expect } from 'vitest';
import { safeNext, loginFailPayload, GENERIC_LOGIN_ERROR } from './helpers';

const ORIGIN = 'https://pos.example.com';

describe('safeNext', () => {
	it.each(['/dashboard', '/settings?tab=a', '/dashboard/reports', '/settings#anchor'])(
		'accepts the same-origin path %s',
		(next) => {
			expect(safeNext(next, ORIGIN)).toBe(next);
		}
	);

	// The four hostile forms the task names.
	it.each([
		['an absolute URL', 'https://evil.example'],
		['a protocol-relative URL', '//evil.example'],
		['a backslash-smuggled host', '/\\evil.example'],
		['a javascript: URL', 'javascript:alert(1)']
	])('refuses %s and falls back to /dashboard', (_label, next) => {
		expect(safeNext(next, ORIGIN)).toBe('/dashboard');
	});

	it.each([
		['null', null],
		['undefined', undefined],
		['the empty string', ''],
		['a bare path with no leading slash', 'dashboard'],
		['another protocol-relative form', '//'],
		['a data URL', 'data:text/html,<script>alert(1)</script>']
	])('falls back to /dashboard for %s', (_label, next) => {
		expect(safeNext(next, ORIGIN)).toBe('/dashboard');
	});

	it('never returns a value that resolves to a different origin', () => {
		const hostile = [
			'https://evil.example',
			'//evil.example',
			'/\\evil.example',
			'\\\\evil.example',
			'https://pos.example.com.evil.example/'
		];
		for (const next of hostile) {
			const result = safeNext(next, ORIGIN);
			expect(new URL(result, ORIGIN).origin).toBe(ORIGIN);
		}
	});
});

describe('loginFailPayload', () => {
	it('carries no password key and no submitted password value', () => {
		const payload = loginFailPayload('owner@cafe.com');

		// Exactly two keys, neither of them the password.
		expect(Object.keys(payload)).toEqual(['email', 'message']);
		expect(payload).not.toHaveProperty('password');

		// The helper takes no password at all — which IS the guarantee. Assert that
		// property directly rather than searching the output for a value the
		// function was never given, which would pass no matter what it returned.
		expect(loginFailPayload.length).toBeLessThanOrEqual(2);
		// And the payload's keys are fixed, whatever is passed alongside.
		expect(Object.keys(loginFailPayload('a@b.c', { retryAfterMs: 5 })).sort()).toEqual([
			'email',
			'message',
			'retryAfterMs'
		]);
	});

	it('uses one generic message, so a locked account is indistinguishable', () => {
		expect(loginFailPayload('a@b.c').message).toBe(GENERIC_LOGIN_ERROR);
		expect(loginFailPayload('a@b.c').message).toBe(loginFailPayload('x@y.z').message);
	});

	it('includes retryAfterMs only when the throttle refused the request', () => {
		expect(loginFailPayload('a@b.c')).not.toHaveProperty('retryAfterMs');
		expect(loginFailPayload('a@b.c', { retryAfterMs: 1234 }).retryAfterMs).toBe(1234);
	});
});
