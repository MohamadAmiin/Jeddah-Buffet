<script lang="ts">
	// A CREATE PANEL (docs/redesign Phase 6) — the "Add …" form that sits BESIDE the
	// list it adds to at xl, and opens at the top below that; never at the bottom of
	// the page. A header row (title + icon) and a body. The page's outcome Alert for
	// this form renders inside the body, above the fields, never at the top of the
	// page. Pair it with PageColumns `collapsible`.
	import type { Snippet } from 'svelte';
	import Icon, { type IconName } from './Icon.svelte';

	let {
		id,
		title,
		icon = 'plus-circle',
		children
	}: {
		/** The panel's id: the page's "Add …" link targets `?add=1#{id}`. */
		id: string;
		title: string;
		icon?: IconName;
		children: Snippet;
	} = $props();
</script>

<section {id} aria-labelledby="{id}-h" class="rounded-card border-line bg-raise shadow-card border">
	<div class="border-line-soft flex items-center gap-3 border-b px-6 py-4">
		<Icon name={icon} class="text-accent size-5" />
		<h3 id="{id}-h" class="text-section">{title}</h3>
	</div>
	<div class="flex flex-col gap-4 p-6">{@render children()}</div>
</section>
