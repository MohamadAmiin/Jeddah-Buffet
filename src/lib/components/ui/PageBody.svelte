<script lang="ts">
	// THE PAGE BODY (docs/redesign Phase 6): one centred container and one gutter
	// rule on every dashboard page — max-w-page (72rem), centred, px-4 / lg:px-8.
	// Replaces the hand-typed `flex flex-col gap-N px-4 pt-8 pb-16 lg:px-7` wrappers.
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="max-w-page mx-auto flex w-full flex-col gap-6 px-4 py-6 lg:px-8">
	{@render children()}
</div>
