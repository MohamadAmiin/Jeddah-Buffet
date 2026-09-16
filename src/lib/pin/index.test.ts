import { describe, it, expect } from 'vitest';
import { PIN_ITERATIONS, derivePinBits, hashPin, isValidPin, verifyPin } from './index';

const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
const unb64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

// Sixteen bytes, so a hand-built PHC string passes the 8-byte salt floor.
const SALT = new TextEncoder().encode('sixteen byte slt');
const SALT_B64 = 'c2l4dGVlbiBieXRlIHNsdA';
const ZERO_TAG = 'A'.repeat(43); // 32 zero bytes, unpadded

/** A PHC string at a LOW iteration count, for tests about format rather than cost. */
async function cheapPhc(secret: string, iterations = 1000): Promise<string> {
	return `$pbkdf2-sha256$i=${iterations}$${b64(SALT)}$${b64(await derivePinBits(secret, SALT, iterations, 32))}`;
}

describe('derivePinBits — published PBKDF2-HMAC-SHA256 vectors', () => {
	// The one case that proves the offline till and the server derive the SAME
	// bytes: the parameters are the intended ones, not merely self-consistent.
	it.each([
		[1, '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'],
		[2, 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43'],
		[4096, 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a']
	])("'password' / 'salt' at %i iteration(s)", async (iterations, expected) => {
		const bits = await derivePinBits('password', new TextEncoder().encode('salt'), iterations, 32);
		expect(hex(bits)).toBe(expected);
	});
});

describe('hashPin and verifyPin', () => {
	it('verifies the right PIN and refuses a wrong or too-short one', async () => {
		const phc = await hashPin('1234');
		expect(await verifyPin('1234', phc)).toBe(true);
		expect(await verifyPin('1235', phc)).toBe(false);
		expect(await verifyPin('123', phc)).toBe(false);
	});

	it.each(['123', '1234567'])('refuses to hash %s, and the error never quotes it', async (pin) => {
		const thrown = await hashPin(pin).then(
			() => null,
			(error: unknown) => error as Error
		);
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown!.message).toBe('A PIN must be 4 to 6 digits');
		expect(thrown!.message).not.toContain(pin);
	});

	// Each is rejected even against a hash of that EXACT string, so the refusal is
	// the digit check's doing and not a mismatched hash.
	it.each(['12a4', '12 4', '+123', '1234\n', '١٢٣٤'])(
		'rejects the non-PIN %j in isValidPin and in verifyPin',
		async (pin) => {
			expect(isValidPin(pin)).toBe(false);
			expect(await verifyPin(pin, await cheapPhc(pin))).toBe(false);
		}
	);

	it('rejects the empty string', async () => {
		expect(isValidPin('')).toBe(false);
		expect(await verifyPin('', await cheapPhc('1234'))).toBe(false);
	});

	it('two hashes of one PIN differ (random salts) and both verify', async () => {
		const a = await hashPin('4321');
		const b = await hashPin('4321');
		expect(a).not.toBe(b);
		expect(await verifyPin('4321', a)).toBe(true);
		expect(await verifyPin('4321', b)).toBe(true);
	});

	it('writes a PHC string that parses back: 600,000 iterations, 16-byte salt, 32-byte tag', async () => {
		const phc = await hashPin('2580');
		expect(phc).toMatch(/^\$pbkdf2-sha256\$i=600000\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
		const [, , , salt, tag] = phc.split('$');
		expect(salt).not.toContain('=');
		expect(tag).not.toContain('=');
		expect(unb64(salt)).toHaveLength(16);
		expect(unb64(tag)).toHaveLength(32);
		expect(PIN_ITERATIONS).toBe(600_000);
	});

	it('reads the iteration count from the stored string, so an older hash still verifies', async () => {
		const older = await cheapPhc('9999', 1000);
		expect(await verifyPin('9999', older)).toBe(true);
		expect(await verifyPin('9998', older)).toBe(false);
	});

	it.each([
		['not a PHC string', 'not a phc string'],
		['zero iterations', `$pbkdf2-sha256$i=0$${SALT_B64}$${ZERO_TAG}`],
		['an absurd iteration count', `$pbkdf2-sha256$i=99999999999$${SALT_B64}$${ZERO_TAG}`],
		['a one-character salt', `$pbkdf2-sha256$i=1000$A$${ZERO_TAG}`],
		['a salt under 8 bytes', `$pbkdf2-sha256$i=1000$c2FsdA$${ZERO_TAG}`],
		['a different algorithm', `$argon2id$v=19$m=19456,t=2,p=1$${SALT_B64}$${ZERO_TAG}`]
	])('returns false and never throws for %s', async (_label, stored) => {
		await expect(verifyPin('1234', stored)).resolves.toBe(false);
	});
});
