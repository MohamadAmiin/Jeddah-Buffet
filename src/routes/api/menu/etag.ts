// THE MENU'S HTTP VALIDATOR — one string, shared by GET /api/menu/version (T-40)
// and GET /api/menu (T-41), so the two endpoints cannot disagree about it and a
// device cannot revalidate one while re-downloading the other.
//
// THE RESTAURANT IS IN THE ETAG, not only the version. menu_version is a
// per-restaurant counter that starts at 1 everywhere, so two restaurants at the
// same version would otherwise share a validator: a tablet moved from restaurant
// A to restaurant B would send A's ETag, get a 304, and keep showing A's prices
// and tax rates on B's till. `Vary: Cookie` tells the browser's own HTTP cache the
// same thing — the response depends on which device cookie asked.
//
// `Cache-Control: private, no-cache` is what makes the ETag work: `no-cache` means
// "store it, but revalidate every time" (spec 5: the ETag makes the check nearly
// free); `no-store` would leave nothing for a 304 to validate; any `max-age` would
// let a till keep selling at yesterday's prices for the length of the window; and
// `private` keeps it out of every shared proxy.

export function menuEtag(restaurantId: string, version: number): string {
	return `W/"menu-${restaurantId}-${version}"`;
}

export const MENU_CACHE_HEADERS = {
	'Cache-Control': 'private, no-cache',
	Vary: 'Cookie'
} as const;

/**
 * Does If-None-Match name this ETag? The header may be a LIST, and each entry may
 * carry the weak prefix `W/`, so a naive `===` against the whole header silently
 * never matches — a working till and a bandwidth bill, not an error.
 */
export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
	if (!header) return false;
	const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
	const wanted = opaque(etag);
	return header
		.split(',')
		.some((candidate) => candidate.trim() === '*' || opaque(candidate) === wanted);
}
