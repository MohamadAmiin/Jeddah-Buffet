/**
 * A small in-memory per-key token bucket. No dependency, no Redis — spec 28
 * removed Redis from the MVP.
 *
 * WHAT THIS IS AND IS NOT, stated plainly so nobody mistakes it for the real
 * defence:
 *   - it is PROCESS-LOCAL, so it resets on restart and would not be shared if a
 *     second Node instance were ever added;
 *   - it sees the PROXY's address unless ADDRESS_HEADER is configured for
 *     adapter-node (T-26 sets it), in which case every visitor looks like one
 *     client;
 *   - T-26's deploy notes make Nginx `limit_req` the PRIMARY throttle. This is
 *     the in-application backstop.
 *
 * It exists because /login is an unauthenticated password-hashing sink: each
 * attempt costs ~19 MiB and tens of milliseconds on Node's four-thread pool,
 * including the deliberate dummy verify for unknown emails.
 */

export const DEFAULT_CAPACITY = 10; // attempts...
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // ...per key per 10 minutes

type Bucket = {
	/** Tokens remaining, fractional because it refills continuously. */
	tokens: number;
	/** When `tokens` was last computed. */
	updatedAt: number;
};

const buckets = new Map<string, Bucket>();

/** Keep the map bounded by evicting entries that have fully refilled. */
function evictFull(now: number, capacity: number, windowMs: number): void {
	for (const [key, bucket] of buckets) {
		const refilled = bucket.tokens + ((now - bucket.updatedAt) * capacity) / windowMs;
		if (refilled >= capacity) buckets.delete(key);
	}
}

export type ThrottleResult = { ok: boolean; retryAfterMs: number };

/**
 * Consume one token for `key`. Returns ok:false and how long to wait when the
 * bucket is empty.
 */
export function consume(
	key: string,
	now: number = Date.now(),
	capacity: number = DEFAULT_CAPACITY,
	windowMs: number = DEFAULT_WINDOW_MS
): ThrottleResult {
	// Cheap opportunistic sweep; the map only ever holds recently-active keys.
	if (buckets.size > 1000) evictFull(now, capacity, windowMs);

	const existing = buckets.get(key);
	const tokens = existing
		? Math.min(capacity, existing.tokens + ((now - existing.updatedAt) * capacity) / windowMs)
		: capacity;

	if (tokens < 1) {
		buckets.set(key, { tokens, updatedAt: now });
		// Time until one whole token has refilled.
		const retryAfterMs = Math.ceil(((1 - tokens) * windowMs) / capacity);
		return { ok: false, retryAfterMs };
	}

	buckets.set(key, { tokens: tokens - 1, updatedAt: now });
	return { ok: true, retryAfterMs: 0 };
}

/** Test seam only — never called by application code. */
export function resetThrottle(): void {
	buckets.clear();
}
