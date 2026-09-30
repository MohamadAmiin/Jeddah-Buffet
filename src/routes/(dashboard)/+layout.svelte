<script lang="ts">
	// (dashboard) — the owner/admin surface: menu, purchases, expenses, reports.
	//
	// ONLINE ONLY. Server `load` functions and form actions are fine here, and
	// so is importing from $lib/server.
	//
	// Permissions are still enforced SERVER-side on every route, reads included
	// (invariant 8). Hiding a button in this layout is not security.
	//
	// THE SHELL (docs/redesign Phase 5): from lg a full-height, sticky rail beside
	// one content column; below lg a 56px phone bar whose menu button opens the same
	// navigation in a drawer. Everything the rail renders is passed to it as props —
	// Sidebar reads no store of its own, so `pathname` comes from here.
	import { page } from '$app/state';
	import { MobileBar, NavDrawer, Sidebar } from '$lib/components/ui';

	let { data, children } = $props();
	let navOpen = $state(false);
</script>

<a
	href="#content"
	class="focus:rounded-control focus:bg-raise sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2"
	>Skip to content</a
>

<!-- flex-col below lg and flex-row from lg, so <main> always stretches to the full
     height and a sticky action bar's mt-auto works at every width. The rail has its
     own h-dvh and stays sticky without the old lg:items-start. -->
<div class="bg-bg flex min-h-dvh flex-col lg:flex-row">
	<Sidebar
		variant="rail"
		restaurantName={data.restaurantName}
		displayName={data.displayName}
		role={data.role}
		pathname={page.url.pathname}
		collapsed={data.railCollapsed}
	/>
	<MobileBar bind:navOpen restaurantName={data.restaurantName} displayName={data.displayName} />
	<!-- min-w-0 so a wide child shrinks instead of pushing the page sideways. -->
	<main id="content" class="flex min-w-0 flex-1 flex-col">
		{@render children()}
	</main>
</div>

<NavDrawer bind:open={navOpen}>
	<Sidebar
		variant="drawer"
		restaurantName={data.restaurantName}
		displayName={data.displayName}
		role={data.role}
		pathname={page.url.pathname}
		onclose={() => (navOpen = false)}
	/>
</NavDrawer>
