<script lang="ts">
	// (dashboard) — the owner/admin surface: menu, purchases, expenses, reports.
	//
	// ONLINE ONLY. Server `load` functions and form actions are fine here, and
	// so is importing from $lib/server.
	//
	// Permissions are still enforced SERVER-side on every route, reads included
	// (invariant 8). Hiding a button in this layout is not security.
	//
	// The shell is a rail plus one content column, and the rail is a real surface
	// rather than a strip of links on the page ground. Everything it renders is
	// passed to it as props — Sidebar reads no store of its own, so `pathname`
	// comes from here.
	import { page } from '$app/state';
	import { Sidebar } from '$lib/components/ui';

	let { data, children } = $props();
</script>

<!-- No bg-bg/text-ink: the element base layer sets the page ground and ink on
     `body` (src/lib/styles/base.css).

     `lg:items-start` is load-bearing, not tidiness. A flex row stretches its items
     to the container's height by default, which leaves the rail nothing to stick
     WITHIN — position:sticky then behaves like static and the rail scrolls away
     with the page. Aligning to the start lets the rail size itself, and its own
     lg:h-screen + lg:sticky do the rest. -->
<div class="min-h-screen lg:flex lg:items-start">
	<Sidebar
		restaurantName={data.restaurantName}
		displayName={data.displayName}
		role={data.role}
		pathname={page.url.pathname}
	/>

	<!-- min-w-0 so a wide child — a table, a long unbroken string — shrinks instead
	     of pushing the whole page sideways. -->
	<main class="min-w-0 flex-1">
		{@render children()}
	</main>
</div>
