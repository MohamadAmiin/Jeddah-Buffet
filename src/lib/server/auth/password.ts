import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Node's BUILT-IN argon2 — no dependency, no native build step, no prebuilt
// binary. Stable since Node 24.19.0; the @types/node JSDoc still carries an
// @experimental tag, which is a stale annotation rather than the runtime
// contract. env.ts asserts the function exists at boot so a wrong runtime fails
// loudly instead of at the owner's first login.
const argon2Async = promisify(argon2) as (
	algorithm: 'argon2id',
	params: {
		message: Buffer;
		nonce: Buffer;
		parallelism: number;
		tagLength: number;
		memory: number;
		passes: number;
	}
) => Promise<Buffer>;

// OWASP's baseline for argon2id: at least 19 MiB of memory, two iterations, one
// degree of parallelism. `memory` is counted in 1 KiB blocks, so 19456 = 19 MiB.
export const ARGON2_MEMORY = 19456;
export const ARGON2_PASSES = 2;
export const ARGON2_PARALLELISM = 1;
const TAG_LENGTH = 32;
const SALT_LENGTH = 16;

// Argon2 has no short input limit the way bcrypt does, but an UNBOUNDED input is
// an unbounded amount of hashing work triggered by an anonymous request.
export const MAX_PASSWORD_BYTES = 1024;

/** Standard base64 WITHOUT padding, as the PHC specification requires. */
function b64(buffer: Buffer): string {
	return buffer.toString('base64').replace(/=+$/, '');
}

function unb64(value: string): Buffer {
	return Buffer.from(value, 'base64');
}

/**
 * Hash a password into a PHC string:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>
 *
 * The parameters travel WITH the hash, which is what lets needsRehash raise the
 * cost factor later without invalidating anything already stored.
 */
export async function hashPassword(password: string): Promise<string> {
	const message = Buffer.from(password, 'utf8');
	if (message.byteLength > MAX_PASSWORD_BYTES) {
		// Deliberately does not quote the input.
		throw new Error(`Password exceeds ${MAX_PASSWORD_BYTES} bytes`);
	}

	const nonce = randomBytes(SALT_LENGTH);
	const tag = await argon2Async('argon2id', {
		message,
		nonce,
		parallelism: ARGON2_PARALLELISM,
		tagLength: TAG_LENGTH,
		memory: ARGON2_MEMORY,
		passes: ARGON2_PASSES
	});

	return `$argon2id$v=19$m=${ARGON2_MEMORY},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${b64(nonce)}$${b64(tag)}`;
}

type ParsedPhc = {
	memory: number;
	passes: number;
	parallelism: number;
	salt: Buffer;
	tag: Buffer;
};

/**
 * Parse a PHC string. Returns null for anything malformed — never throws a
 * message that quotes the input (invariant 12: a hash is never logged or echoed).
 */
function parsePhc(phc: string): ParsedPhc | null {
	const match =
		/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
	if (!match) return null;

	const memory = Number(match[1]);
	const passes = Number(match[2]);
	const parallelism = Number(match[3]);
	if (!memory || !passes || !parallelism) return null;

	const salt = unb64(match[4]);
	const tag = unb64(match[5]);
	// nonce must be at least 8 bytes; a zero-length tag would make comparison
	// meaningless.
	if (salt.byteLength < 8 || tag.byteLength === 0) return null;

	return { memory, passes, parallelism, salt, tag };
}

/**
 * Verify a password against a stored PHC string.
 *
 * Re-derives with the parameters READ FROM THE STRING, not with the current
 * constants, so a hash produced under older parameters still verifies.
 */
export async function verifyPassword(phc: string, password: string): Promise<boolean> {
	const parsed = parsePhc(phc);
	if (!parsed) return false;

	const message = Buffer.from(password, 'utf8');
	if (message.byteLength > MAX_PASSWORD_BYTES) return false;

	let candidate: Buffer;
	try {
		candidate = await argon2Async('argon2id', {
			message,
			nonce: parsed.salt,
			parallelism: parsed.parallelism,
			tagLength: parsed.tag.byteLength,
			memory: parsed.memory,
			passes: parsed.passes
		});
	} catch {
		return false;
	}

	// timingSafeEqual throws on a length mismatch, so check lengths first.
	if (candidate.byteLength !== parsed.tag.byteLength) return false;
	return timingSafeEqual(candidate, parsed.tag);
}

/**
 * True when the stored parameters are weaker than the current constants. T-13
 * calls this after a successful verify and re-hashes in the same transaction,
 * which is what makes raising the cost factor a no-downtime change.
 */
export function needsRehash(phc: string): boolean {
	const parsed = parsePhc(phc);
	if (!parsed) return true;
	return (
		parsed.memory < ARGON2_MEMORY ||
		parsed.passes < ARGON2_PASSES ||
		parsed.parallelism < ARGON2_PARALLELISM
	);
}
