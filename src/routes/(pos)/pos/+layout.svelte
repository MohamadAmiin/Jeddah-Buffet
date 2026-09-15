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

	let { children } = $props();

	// THE CONNECTION INDICATOR — permanent chrome on every POS screen, which is why
	// it lives in this layout and not in a page, and never a toast (spec 6). Both
	// the glyph and the word, always: colour never carries meaning alone.
	//
	// Initialised to `true` so server-rendered HTML does not claim "Offline" before
	// any listener exists; navigator does not exist during SSR, so it is read only
	// in onMount.
	//
	// THERE IS NO UNSYNCED COUNT YET. Spec 6 requires the number of unsynced
	// operations to be on screen at all times, and that number arrives with the
	// sales plan that creates the queue. A hardcoded 0 would be a lie the moment a
	// queue exists.
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
</script>

<div data-surface="pos" class="text-pos bg-bg text-ink min-h-screen">
	<div
		role="status"
		class={`flex items-center gap-2 px-4 py-2 ${online ? 'bg-ok-bg text-ok' : 'bg-st-offline-bg text-st-offline'}`}
	>
		<span aria-hidden="true" class="font-mono">{online ? '●' : '◆'}</span>
		<span>{online ? 'Online' : 'Offline'}</span>
	</div>
	{@render children()}
</div>
