<script lang="ts">
	// THE POS SHELL — the till's device surface, at the REAL /pos URL prefix.
	//
	// It lives on this INNER pos/ layout, not on the (pos) group layout, and both
	// reasons matter:
	//   - A route GROUP is not a URL segment. The group layout wraps whatever sits in
	//     the group regardless of URL, so stamping the surface there would also stamp
	//     a page someone later adds at src/routes/(pos)/anything/+page.svelte — which
	//     serves at /anything, outside the service worker's scope, outside the
	//     manifest's scope and outside the /pos opening in the route guard. That page
	//     would LOOK right while being unreachable offline and guarded differently.
	//     Here the prefix is structural: to get the POS shell you must be under /pos.
	//   - The group layout is the written record of the group's two hard constraints
	//     (never import $lib/server; no server load). It stays where it is.
	//
	// THE POS SURFACE IS LIGHT AND PINNED IN BOTH THEMES. [data-surface="pos"] in
	// tokens.css pins the COMPLETE palette — grounds, inks, accent, status, the
	// aliases, the rail family and the shadow rungs. A surface pinned one way whose
	// inks still theme is the defect that has shipped twice (1.08:1, then 1.21:1).
	// `bg-bg text-ink` are NOT redundant: <body> sits outside this scope and paints
	// the viewer's themed ground, so this element must resolve the PINNED values
	// itself; `min-h-screen` stops the themed body showing under a short page.
	//
	// EVERY PRESSABLE POS SURFACE TAKES A `border border-control-line` EDGE. A white
	// key (--c-raise) on the POS ground (--c-bg) measures 1.22:1, so elevation alone
	// cannot carry a control's boundary, and WCAG 1.4.11 asks 3:1 of one.
	// --c-control-line resolves to --c-ink-3, 4.73:1 on that ground. `border-line`
	// is decorative only and never a control edge.
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { countUnsynced, onUnsyncedChange } from '$lib/pos/store';

	let { children } = $props();

	// THE CONNECTION INDICATOR — permanent chrome on every POS screen, which is why
	// it lives in this layout and not in a page, and never a toast (spec 6). Both
	// the glyph and the word, always: colour never carries meaning alone.
	//
	// Initialised to `true` so server-rendered HTML does not claim "Offline" before
	// any listener exists; navigator does not exist during SSR, so it is read only
	// in onMount.
	let online = $state(true);

	onMount(() => {
		online = navigator.onLine;
		const up = () => (online = true);
		const down = () => (online = false);
		addEventListener('online', up);
		addEventListener('offline', down);
		return () => {
			removeEventListener('online', up);
			removeEventListener('offline', down);
		};
	});

	// THE UNSYNCED COUNT sits beside it, for the same reason: spec 6 and invariant 5
	// want the number of unsynced operations on screen at all times, and an offline
	// sign-in is unsynced work from the moment it is recorded (offline_logins,
	// synced: false). It is read from IndexedDB after mount and again on every
	// change the store signals, and only the NEWEST read may land, so a slow read
	// cannot put an older number back. Nothing is shown before the first read, and a
	// store that cannot be read is named as such: never a 0 that may be false.
	let unsynced = $state<number | null>(null);
	let unsyncedUnreadable = $state(false);

	onMount(() => {
		let latest = 0;
		const recount = () => {
			const mine = ++latest;
			countUnsynced().then(
				(count) => {
					if (mine !== latest) return;
					unsynced = count;
					unsyncedUnreadable = false;
				},
				() => {
					if (mine !== latest) return;
					unsynced = null;
					unsyncedUnreadable = true;
				}
			);
		};
		recount();
		const stop = onUnsyncedChange(recount);
		return () => {
			// Bumping `latest` discards any read still in flight.
			latest++;
			stop();
		};
	});

	// THE SERVICE WORKER — registered BY HAND, from this layout and from nowhere
	// else. svelte.config.js turns SvelteKit's automatic registration off: its
	// default scope is '/', which would put the till's worker in charge of
	// /dashboard and leave authenticated HTML in Cache Storage that /logout does not
	// clear.
	//
	// THE SCOPE IS '/pos', NOT '/pos/', and that is the trap in the whole decision.
	// Scope matching is a plain STRING prefix on the client URL (the ServiceWorker
	// specification's "Match Service Worker Registration"; MDN's prose implies a
	// path-segment match and is wrong on this point). '/pos/' would not match the
	// till's own landing screen at /pos, which would then fail to load offline.
	// The same string-prefix rule is why NO route outside the (pos) group may have
	// a path beginning with the characters "pos" — this worker would control it.
	// A script at /service-worker.js may NARROW its scope to /pos with no
	// Service-Worker-Allowed header; only widening would need one.
	//
	// `type: 'module'` in dev, where the worker is served unbundled; the production
	// build is classic. onMount often runs after `load` has already fired, when a
	// bare load listener would never run — hence the readyState check.
	onMount(() => {
		if (!('serviceWorker' in navigator)) return;
		const register = () => {
			navigator.serviceWorker
				.register('/service-worker.js', { scope: '/pos', type: dev ? 'module' : 'classic' })
				.catch(() => {
					// No worker (an insecure origin, a blocked registration): the till
					// still works online; it just cannot start offline.
				});
		};
		if (document.readyState === 'complete') register();
		else addEventListener('load', register, { once: true });
	});
</script>

<svelte:head>
	<!-- Linked from the POS shell ONLY, so no dashboard page advertises the till as
	     installable. KNOWN GAP, cosmetic and on one platform: Chromium accepts the
	     SVG manifest icon, iOS Safari does not — it wants an apple-touch-icon PNG,
	     which is not generated here, so an iPad home-screen install shows a page
	     thumbnail instead of an icon. -->
	<link rel="manifest" href="/pos.webmanifest" />
</svelte:head>

<div data-surface="pos" class="text-pos bg-bg text-ink min-h-screen">
	<div
		role="status"
		class={`flex items-center gap-2 px-4 py-2 ${online ? 'bg-ok-bg text-ok' : 'bg-st-offline-bg text-st-offline'}`}
	>
		<span aria-hidden="true" class="font-mono">{online ? '●' : '◆'}</span>
		<span>{online ? 'Online' : 'Offline'}</span>
		{#if unsynced !== null}
			<span aria-hidden="true">·</span>
			<span>{unsynced} unsynced</span>
		{:else if unsyncedUnreadable}
			<span aria-hidden="true">·</span>
			<span>unsynced count unavailable</span>
		{/if}
	</div>
	{@render children()}
</div>
