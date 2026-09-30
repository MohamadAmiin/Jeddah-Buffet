<script lang="ts">
	// THE PHONE BAR (docs/redesign Phase 5) — below lg, a 56px rail-coloured bar in
	// place of the tall block the rail used to become: the menu button that opens
	// the navigation drawer, the brand tile, the restaurant name (the page's h1 below
	// lg; the rail's h1 is display:none there) and the owner's initials. Props only.
	import Icon from './Icon.svelte';

	let {
		restaurantName,
		displayName,
		navOpen = $bindable(false)
	}: { restaurantName: string | null; displayName: string; navOpen?: boolean } = $props();

	const initials = $derived(
		displayName
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => [...word][0]?.toUpperCase() ?? '')
			.join('')
	);
</script>

<header
	data-rail
	class="bg-rail text-rail-ink sticky top-0 z-30 flex h-14 items-center gap-3 px-4 lg:hidden"
>
	<button
		type="button"
		aria-label="Open navigation"
		aria-expanded={navOpen}
		aria-controls="nav-drawer"
		class="rounded-control border-rail-line grid size-10 flex-none place-items-center border"
		onclick={() => (navOpen = true)}
	>
		<Icon name="menu" class="size-5" stroke={1.6} />
	</button>
	<span
		aria-hidden="true"
		class="bg-rail-ink text-rail font-display rounded-control text-section grid size-8 flex-none place-items-center"
		>m</span
	>
	<h1 class="text-section text-rail-ink min-w-0 flex-1 truncate">
		{restaurantName ?? 'matcami'}
	</h1>
	<span
		aria-hidden="true"
		class="bg-rail-active text-rail-ink text-caption grid size-9 flex-none place-items-center rounded-full font-mono font-medium"
		>{initials}</span
	>
</header>
