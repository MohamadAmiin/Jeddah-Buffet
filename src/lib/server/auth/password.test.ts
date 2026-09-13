import { describe, it, expect } from 'vitest';
import {
	hashPassword,
	verifyPassword,
	needsRehash,
	MAX_PASSWORD_BYTES,
	ARGON2_MEMORY
} from './password';

describe('password hashing (argon2id, PHC format)', () => {
	it('round-trips: hash then verify', async () => {
		const phc = await hashPassword('a strong enough password');
		expect(await verifyPassword(phc, 'a strong enough password')).toBe(true);
	});

	it('rejects a wrong password', async () => {
		const phc = await hashPassword('a strong enough password');
		expect(await verifyPassword(phc, 'a strong enough passworD')).toBe(false);
	});

	it('produces a different hash each time (the salt is random)', async () => {
		const a = await hashPassword('same password');
		const b = await hashPassword('same password');
		expect(a).not.toBe(b);
		// ...and both still verify.
		expect(await verifyPassword(a, 'same password')).toBe(true);
		expect(await verifyPassword(b, 'same password')).toBe(true);
	});

	it('emits a PHC string with unpadded base64', async () => {
		const phc = await hashPassword('whatever');
		expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
		// Padding on the SALT or TAG segments would make other argon2
		// implementations reject the string, which defeats the point of choosing a
		// self-describing format. (`=` legitimately appears in the m=/t=/p= segment,
		// so check the base64 fields specifically.)
		const [, , , , salt, tag] = phc.split('$');
		expect(salt).not.toContain('=');
		expect(tag).not.toContain('=');
	});

	it.each([
		['empty string', ''],
		['not a PHC string at all', 'hunter2'],
		['wrong algorithm', '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$dGFn'],
		['missing the tag', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0'],
		['non-numeric parameters', '$argon2id$v=19$m=x,t=2,p=1$c2FsdHNhbHRzYWx0$dGFn'],
		['salt too short', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$dGFn']
	])('returns false for a malformed PHC string (%s) without throwing', async (_label, bad) => {
		await expect(verifyPassword(bad, 'anything')).resolves.toBe(false);
	});

	it('still verifies a hash made with weaker parameters, and flags it for rehash', async () => {
		// Produced with m=8192 (below the current 19456). Re-derivation must use the
		// parameters FROM THE STRING, or an existing owner could never log in again
		// after the cost factor is raised.
		const weak = '$argon2id$v=19$m=8192,t=2,p=1$c2FsdHNhbHRzYWx0MTI$' + '';
		// Build it for real rather than hand-rolling a tag:
		const { argon2Sync, randomBytes } = await import('node:crypto');
		const nonce = randomBytes(16);
		const tag = argon2Sync('argon2id', {
			message: Buffer.from('legacy password', 'utf8'),
			nonce,
			parallelism: 1,
			tagLength: 32,
			memory: 8192,
			passes: 2
		});
		const legacy =
			'$argon2id$v=19$m=8192,t=2,p=1$' +
			nonce.toString('base64').replace(/=+$/, '') +
			'$' +
			tag.toString('base64').replace(/=+$/, '');

		expect(weak).toBeTruthy(); // keeps the explanatory literal above meaningful
		expect(await verifyPassword(legacy, 'legacy password')).toBe(true);
		expect(needsRehash(legacy)).toBe(true);
	});

	it('does not flag a current-parameter hash for rehash', async () => {
		const phc = await hashPassword('current');
		expect(needsRehash(phc)).toBe(false);
	});

	it('treats an unparseable hash as needing a rehash', () => {
		expect(needsRehash('not a phc string')).toBe(true);
	});

	it('refuses a password longer than the maximum', async () => {
		const tooLong = 'x'.repeat(MAX_PASSWORD_BYTES + 1);
		await expect(hashPassword(tooLong)).rejects.toThrow(/exceeds/);
	});

	it('does not echo the password or the hash in the too-long error', async () => {
		const tooLong = 'sekrit'.repeat(300);
		await expect(hashPassword(tooLong)).rejects.toThrow(
			expect.not.stringContaining('sekrit') as unknown as string
		);
	});

	// THE FIXED VECTOR. Generated once with the current parameters and pasted here
	// as a literal. Any future backend swap — @node-rs/argon2, hash-wasm, anything —
	// must still verify this string, or it would silently reject every owner
	// already in the database. Do not regenerate it to make a change pass.
	it('verifies a checked-in PHC vector (interoperability guard)', async () => {
		const VECTOR =
			'$argon2id$v=19$m=19456,t=2,p=1$EktaimJf4olJxEDQTptLgQ$DxmERz8ffb5S7nxCFAYUH1qs9ULV6Wpl1vaYJeFB/hI';
		expect(await verifyPassword(VECTOR, 'correct horse battery staple')).toBe(true);
		expect(await verifyPassword(VECTOR, 'wrong horse battery staple')).toBe(false);
		expect(needsRehash(VECTOR)).toBe(false);
		expect(VECTOR).toContain(`m=${ARGON2_MEMORY}`);
	});
});
