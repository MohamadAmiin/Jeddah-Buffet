<script lang="ts">
	// The dashboard page band: an optional eyebrow, a REAL h1-h4, an optional
	// one-line description, an optional action area — on a raised strip that
	// separates the page's identity from its content.
	//
	// This is the "page skeleton" docs/design-system.md §7b describes, implemented
	// ONCE. Both dashboard routes composed this band by hand before, byte-for-byte
	// identical in each, which is exactly what a primitives layer exists to stop.
	//
	// The heading element must be genuine. e2e/auth.spec.ts asserts four headings by
	// role and name, and e2e/smoke.spec.ts asserts
	// getByRole('heading', { level: 1, name: 'matcami' }) — which is why `level` must
	// be able to render a real h1. A styled <div> carrying a heading ARIA role is not
	// acceptable — the element itself must be h1-h4.
	//
	// The title element contains exactly `title`. The eyebrow and the description get
	// their own elements: folding either into the heading would change its accessible
	// name and break those assertions.
	//
	// Type comes from the ROLES (text-display, text-body, text-eyebrow), each of which
	// carries its own size, line-height, tracking and weight. Tailwind's own text-xl
	// and font-bold resolve to node_modules rather than to tokens.css, which is a
	// second source of type truth that CLAUDE.md forbids.

	let {
		title,
		description = '',
		eyebrow = '',
		level = 2,
		actions = undefined
	}: {
		title: string;
		description?: string;
		eyebrow?: string;
		level?: 1 | 2 | 3 | 4;
		actions?: import('svelte').Snippet;
	} = $props();
</script>

<header class="bg-raise border-line border-b px-4 py-6 lg:px-7">
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div class="max-w-measure flex flex-col gap-2">
			{#if eyebrow}
				<p class="text-eyebrow text-ink-3 uppercase">{eyebrow}</p>
			{/if}
			<svelte:element this={`h${level}`} class="text-display">{title}</svelte:element>
			{#if description}
				<!-- text-ink-2, not text-ink-3: ink-2 is 5.91:1 at worst in light and 6.15:1
				     in dark across every surface, so this line is legal on the page ground as
				     well as inside a card. -->
				<p class="text-body text-ink-2">{description}</p>
			{/if}
		</div>
		{#if actions}
			<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
		{/if}
	</div>
</header>
