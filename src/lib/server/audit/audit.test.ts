import { describe, it, expect } from 'vitest';
import { assertNoSecrets } from './index';

describe('assertNoSecrets', () => {
	it.each([
		['a top-level password', { password: 'x' }],
		['a nested pin hash', { user: { pinHash: 'x' } }],
		['a session token', { sessionToken: 'x' }],
		['a bare token', { token: 'x' }],
		['a secret', { mySecret: 'x' }],
		['a cookie', { cookie: 'a=b' }],
		['an authorization header', { authorization: 'Bearer x' }],
		['a password_hash in snake case', { password_hash: 'x' }],
		['one inside an array', { items: [{ ok: 1 }, { apiToken: 'x' }] }],
		['one three levels down', { a: { b: { c: { passphrase: 'x' } } } }]
	])('throws for %s', (_label, details) => {
		expect(() => assertNoSecrets(details)).toThrow(/looks like a secret/);
	});

	it('names the path to the offending key, never its value', () => {
		expect(() => assertNoSecrets({ user: { pinHash: 'super-secret-value' } })).toThrow(
			/details\.user\.pinHash/
		);
		try {
			assertNoSecrets({ user: { pinHash: 'super-secret-value' } });
		} catch (error) {
			expect((error as Error).message).not.toContain('super-secret-value');
		}
	});

	it.each([
		['an email', { email: 'a@b.c' }],
		['a settings diff', { changes: { name: { old: 'A', new: 'B' } } }],
		['a role and display name', { role: 'owner', displayName: 'Owner' }],
		['an empty object', {}],
		['a failed count', { email: 'a@b.c', failedCount: 5 }]
	])('passes for %s', (_label, details) => {
		expect(() => assertNoSecrets(details)).not.toThrow();
	});

	it('does not trip on non-object values', () => {
		expect(() => assertNoSecrets(null)).not.toThrow();
		expect(() => assertNoSecrets('a string')).not.toThrow();
		expect(() => assertNoSecrets(42)).not.toThrow();
	});
});
