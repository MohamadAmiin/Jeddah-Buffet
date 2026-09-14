<script lang="ts">
	// A page or section heading: a REAL h1-h4 element, an optional one-line
	// description, an optional action area.
	//
	// The heading element must be genuine. e2e/auth.spec.ts asserts four headings by
	// role and name, and e2e/smoke.spec.ts asserts
	// getByRole('heading', { level: 1, name: 'matcami' }) — which is why `level` must
	// be able to render a real h1. A styled <div> carrying a heading ARIA role is not
	// acceptable — the element itself must be h1-h4.
	//
	// The title element contains exactly `title`. The description goes in its own <p>:
	// folding it into the heading would change the accessible name.

	let {
		title,
		description = '',
		level = 2,
		actions = undefined
	}: {
		title: string;
		description?: string;
		level?: 1 | 2 | 3 | 4;
		actions?: import('svelte').Snippet;
	} = $props();
</script>

<div class="flex flex-wrap items-start justify-between gap-4">
	<div>
		<svelte:element this={`h${level}`} class="font-display text-xl font-bold"
			>{title}</svelte:element
		>
		{#if description}
			<!-- text-ink-2, not text-ink-3: ink-2 is 5.91:1 at worst in light and 6.15:1
			     in dark across every surface, so this line is legal on the page ground as
			     well as inside a card. ink-3 would be 4.35:1 on bg-bg. -->
			<p class="text-ink-2 mt-1 text-sm">{description}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
	{/if}
</div>
