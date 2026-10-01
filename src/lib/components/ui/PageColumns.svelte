<script lang="ts">
	// MAIN CONTENT PLUS A SIDE COLUMN (docs/redesign Phase 6). Three kinds of side
	// column, chosen with props:
	//   · default — status cards, "Pay the supplier", the auto-lock form: always
	//     visible; the right-hand column at xl, after the main content below it.
	//   · collapsible — CREATE PANELS ONLY: at xl the right-hand column, always
	//     visible and sticky; below xl hidden until opened, then shown ABOVE the list
	//     (order-first). The main content stays first in the DOM, so at xl the
	//     keyboard reaches the list before the panel.
	//   · asideFirst — master–detail (/inventory/recipes): the picker comes first in
	//     the DOM and on screen.
	import type { Snippet } from 'svelte';

	let {
		aside,
		children,
		collapsible = false,
		asideOpen = false,
		asideFirst = false,
		showAside = true
	}: {
		aside: Snippet;
		children: Snippet;
		collapsible?: boolean;
		/** Read only when collapsible. */
		asideOpen?: boolean;
		asideFirst?: boolean;
		/** False when the aside has nothing to show: the main content then takes the
		 * full width instead of leaving an empty column. */
		showAside?: boolean;
	} = $props();

	const shown = $derived(!collapsible || asideOpen);
</script>

{#snippet side()}
	<div
		class="{shown ? 'flex' : 'hidden'} min-w-0 flex-col gap-6 xl:col-span-4 xl:flex {collapsible
			? 'order-first xl:sticky xl:top-6 xl:order-none'
			: ''}"
	>
		{@render aside()}
	</div>
{/snippet}

{#if showAside}
	<div class="grid items-start gap-6 xl:grid-cols-12">
		{#if asideFirst}{@render side()}{/if}
		<div class="flex min-w-0 flex-col gap-6 xl:col-span-8">{@render children()}</div>
		{#if !asideFirst}{@render side()}{/if}
	</div>
{:else}
	<div class="flex min-w-0 flex-col gap-6">{@render children()}</div>
{/if}
