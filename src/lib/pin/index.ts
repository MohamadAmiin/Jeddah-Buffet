// THE PIN HASH — one implementation, used by the server AND by the offline till.
//
// Spec 6 requires a registered device to verify an employee's PIN OFFLINE, from
// a hash cached on the device, so this module lives in src/lib/ and not in
// src/lib/server/: a module under lib/server could never run in the browser
// (SvelteKit build-blocks it, and eslint.config.js forbids importing it from
// src/lib/pos/** and src/routes/(pos)/**). It is ISOMORPHIC and must stay so: no
// import of Node's crypto module (it has no browser build) and no Node-only
// binary global. Everything here is globalThis.crypto.subtle and
// getRandomValues, which exist in Node 24 and in every target browser, plus the
// btoa/atob pair.
//
// The algorithm is decided (CLAUDE.md, "Decisions already made", 2026-09-15):
// PBKDF2-HMAC-SHA256 at 600,000 iterations (OWASP's figure), a 16-byte random
// salt and a 32-byte derived key, stored as a PHC-style string
//
//   $pbkdf2-sha256$i=600000$<salt>$<tag>
//
// in standard base64 with the '=' padding stripped — the convention
// src/lib/server/auth/password.ts uses for its argon2id string. The parameters
// travel WITH the hash, so the iteration count can be raised later without
// invalidating anything already stored. PINs are 4–6 digits (spec 7).
//
// A 600,000-iteration derivation is deliberately slow. Never log, console.log,
// throw or return a PIN (invariant 12).

export const PIN_ALGORITHM = 'pbkdf2-sha256';
export const PIN_ITERATIONS = 600_000;
export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 6;

const SALT_BYTES = 16;
const DERIVED_BYTES = 32;

// Built from the two constants rather than typed out, so a change to the digit
// bound cannot leave the pattern or the error message behind. `\d` without the
// `u` flag is ASCII 0-9 only — which is what rejects Arabic-Indic digits — and
// `$` without the `m` flag does not match before a trailing newline.
const PIN_PATTERN = new RegExp(`^\\d{${PIN_MIN_DIGITS},${PIN_MAX_DIGITS}}$`);

const PHC_PATTERN = /^\$pbkdf2-sha256\$i=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

// A tampered stored string must not be able to pin a CPU, and a salt this short
// is not a salt.
const MAX_ITERATIONS = 10_000_000;
const MIN_SALT_BYTES = 8;

export function isValidPin(pin: string): boolean {
	return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

/** Standard base64 with the '=' padding stripped, as the PHC format requires. */
function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/=+$/, '');
}

/** The inverse, or null for anything atob cannot decode. */
function fromBase64(value: string): Uint8Array | null {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * The raw PBKDF2-HMAC-SHA256 derivation, with NO digit validation.
 *
 * Its only callers are hashPin/verifyPin below and the known-answer test, which
 * feeds it the published 'password'/'salt' vectors to prove the server and the
 * offline till derive the same bytes rather than merely agreeing with
 * themselves. Nothing else may call it: it accepts any secret at all.
 */
export async function derivePinBits(
	secret: string,
	salt: Uint8Array,
	iterations: number,
	bytes: number
): Promise<Uint8Array> {
	const key = await globalThis.crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		'PBKDF2',
		false,
		['deriveBits']
	);
	// A fresh copy of the salt: WebCrypto's typings refuse a view that might sit
	// over shared memory, and copying a few bytes satisfies them at no cost.
	const bits = await globalThis.crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: new Uint8Array(salt), iterations, hash: 'SHA-256' },
		key,
		bytes * 8
	);
	return new Uint8Array(bits);
}

/** Hash a 4–6 digit PIN into the PHC string stored in users.pin_hash. */
export async function hashPin(pin: string): Promise<string> {
	if (!isValidPin(pin)) {
		// Built from the constants, and never quoting the input — exactly as
		// password.ts refuses to quote a password.
		throw new Error(`A PIN must be ${PIN_MIN_DIGITS} to ${PIN_MAX_DIGITS} digits`);
	}
	const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const derived = await derivePinBits(pin, salt, PIN_ITERATIONS, DERIVED_BYTES);
	return `$${PIN_ALGORITHM}$i=${PIN_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

/**
 * Verify a PIN against a stored PHC string. PIN FIRST, stored hash second —
 * the opposite order to verifyPassword(phc, password).
 *
 * Never throws: anything malformed, an invalid PIN, an absurd iteration count, a
 * salt under 8 bytes or an empty tag is simply `false`. Re-derives with the
 * iteration count READ FROM THE STRING, not PIN_ITERATIONS, so an older hash
 * still verifies after the cost is raised.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
	if (!isValidPin(pin) || typeof stored !== 'string') return false;

	const match = PHC_PATTERN.exec(stored);
	if (!match) return false;

	const iterations = Number(match[1]);
	if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
		return false;
	}

	const salt = fromBase64(match[2]);
	const tag = fromBase64(match[3]);
	if (!salt || !tag || salt.length < MIN_SALT_BYTES || tag.length === 0) return false;

	let candidate: Uint8Array;
	try {
		candidate = await derivePinBits(pin, salt, iterations, tag.length);
	} catch {
		return false;
	}
	return constantTimeEqual(candidate, tag);
}

/**
 * The server's timingSafeEqual is not available in a browser: compare lengths
 * first, then fold every byte into one accumulator so the time taken does not
 * depend on where the first difference is.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}
