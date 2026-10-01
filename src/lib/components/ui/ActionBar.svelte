<script lang="ts">
	// THE STICKY ACTION BAR (docs/redesign Phase 6) — Save for a long form, always
	// in view at the bottom of the viewport, with the form's result beside it. Put
	// it AFTER PageBody inside <main>: <main> is a flex column, so `mt-auto` keeps
	// the bar at the bottom of a short page at every width. The submit button inside
	// uses the `form="…"` attribute to submit the form above it. The page's outcome
	// Alert goes into `message` unchanged — a page that shows no success alert today
	// still shows none.
	import type { Snippet } from 'svelte';

	let {
		caption = '',
		message = undefined,
		children
	}: { caption?: string; message?: Snippet; children: Snippet } = $props();
</script>

<div class="border-line bg-raise shadow-floating sticky bottom-0 z-20 mt-auto border-t">
	<div
		class="max-w-page mx-auto flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 lg:px-8"
	>
		{#if message}
			<div class="min-w-0 flex-1">{@render message()}</div>
		{:else}
			<p class="text-caption text-ink-2">{caption}</p>
		{/if}
		<div class="flex flex-wrap items-center gap-2">{@render children()}</div>
	</div>
</div>
