// PHOTO WARM-UP — best-effort offline photos (menu-and-printing R2, T-15).
//
// WHY THIS IS NOT A SERVICE-WORKER CACHE. CLAUDE.md's service-worker policy
// (part 6) is that the worker never writes to Cache Storage at runtime: the
// shell precache is its only write, so an authenticated response has no path
// into a cache. Photos take a different route entirely — the browser's own HTTP
// cache. /api/menu/images/[id] answers `Cache-Control: private,
// max-age=31536000, immutable` under a URL that never changes for a given id
// (a new photo is a new id), so once the browser has fetched a photo it can
// serve it offline for as long as it keeps it. This module simply FETCHES every
// photo in the menu after a sync and reads each body to the end, so the cache
// entry is complete. It is best effort: a photo missing offline shows the
// name/initials tile, and selling never depends on a photo.
//
// Bounded concurrency (4 by default) so a 200-item menu does not open 200
// connections at once on a small till PC. A rejection or a non-OK status counts
// as `failed` and never throws — the caller fires and forgets.
import { tillImageUrl } from '../menu-images';

export async function warmMenuPhotos(
	items: { imageId: string | null }[],
	fetchFn: typeof fetch = fetch,
	concurrency = 4
): Promise<{ warmed: number; failed: number }> {
	const ids = [
		...new Set(items.map((item) => item.imageId).filter((id): id is string => id !== null))
	];
	let warmed = 0;
	let failed = 0;
	let next = 0;

	async function worker(): Promise<void> {
		while (next < ids.length) {
			const id = ids[next];
			next += 1;
			if (id === undefined) return;
			try {
				const response = await fetchFn(tillImageUrl(id), { credentials: 'same-origin' });
				if (!response.ok) {
					failed += 1;
					continue;
				}
				// Read to the end: the HTTP cache entry completes only when the body does.
				await response.arrayBuffer();
				warmed += 1;
			} catch {
				failed += 1;
			}
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, ids.length) }, () => worker());
	await Promise.all(workers);
	return { warmed, failed };
}
