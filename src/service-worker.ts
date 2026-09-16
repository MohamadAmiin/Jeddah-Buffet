/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// THE TILL'S SERVICE WORKER — scoped to /pos, registered by hand from
// src/routes/(pos)/pos/+layout.svelte, under the policy CLAUDE.md records in
// "Decisions already made" (confirmed by the user on 2026-09-15):
//
//   1. ONE CACHE WRITE in this whole file: the install-time addAll below. There
//      is no runtime cache write anywhere, so an authenticated response has no
//      path into Cache Storage even for a URL this worker controls. Keep it that
//      way — the next instinct will be a stale-while-revalidate, and that is the
//      exact defect this file exists to avoid.
//   2. It precaches the build's own assets and static files AND ONE APP-SHELL
//      DOCUMENT — the till's landing screen, /pos. That document carries no
//      per-employee and no per-session data: nothing under /pos has a server
//      load, and the employee list, names and PIN hashes are fetched at runtime.
//      So a shell served from the cache cannot outlive a revoked device or a
//      signed-out employee; everything session-shaped fails closed without the
//      network.
//   3. NAVIGATIONS go to the network first, passed through untouched, and the
//      shell answers ONLY when that fetch throws — a reload or a cold start with
//      the network down. A navigation the network answers, even with an error
//      status, is returned as it came.
//   4. Everything else is NETWORK-ONLY. /api/* above all: the menu version check
//      answered from a cache would freeze the menu forever, and a cached answer
//      from a device-guarded endpoint would outlive a revocation. __data.json and
//      anything unforeseen fall through to the network as well.
//
// This supersedes the network-only-navigations sentence of T-27 step 4 in
// tasks/pos-access-and-menu/05-pos-shell.md: with no cached navigation response,
// nothing answers a reload of /pos with the network down and the till cannot
// start offline, which spec 6 requires it to.
//
// `build` and `files` are EMPTY under `pnpm dev`, and the worker is bundled for
// production only, so offline behaviour is observable only against
// `pnpm build && pnpm preview` — which is why the e2e suite runs there.

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `matcami-pos-${version}`;
/** The one app-shell document, served for a navigation only when the network throws. */
const SHELL = '/pos';
const PRECACHE = [...build, ...files];
const PRECACHE_SET = new Set(PRECACHE);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll([...PRECACHE, SHELL]);
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// A new build brings a new version: every older cache goes.
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;

	// Anything that changes state goes to the network, always.
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	// Another origin is not this worker's business.
	if (url.origin !== location.origin) return;

	// The API is network-only — see point 4 above.
	if (url.pathname.startsWith('/api/')) return;

	if (request.mode === 'navigate') {
		// Network first and untouched; the precached shell ONLY when the fetch throws.
		event.respondWith(
			fetch(request).catch(async () => {
				const shell = await caches.match(SHELL, { cacheName: CACHE });
				return shell ?? Response.error();
			})
		);
		return;
	}

	// The build's own assets and the static files: from the precache — or, should
	// an entry somehow be missing, from the network, and still never written back.
	if (PRECACHE_SET.has(url.pathname)) {
		event.respondWith(
			(async () => (await caches.match(url.pathname, { cacheName: CACHE })) ?? fetch(request))()
		);
	}

	// Everything else — __data.json and anything unforeseen — is not answered here,
	// and so reaches the network untouched.
});
