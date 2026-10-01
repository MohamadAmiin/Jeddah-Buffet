<script lang="ts">
	// The dashboard page band: an eyebrow OR a breadcrumb, a REAL h1-h4, an optional
	// description, an optional action area, and an optional row below (sub-navigation
	// such as tabs) — on a raised strip that separates the page's identity from its
	// content. docs/redesign Phase 6: NOT sticky; the inner row is the same centred
	// max-w-page container as PageBody; the title is text-title (was text-display —
	// about 40px less band on every page); `basis-80` on the title column makes the
	// actions wrap UNDER the title on a phone instead of squeezing it.
	//
	// The heading element must be genuine: e2e asserts headings by role and name, so
	// `level` renders a real h1-h4, never a styled <div>. The title element contains
	// exactly `title` — folding the eyebrow or description into it would change its
	// accessible name.

	type Crumb = { label: string; href: string };
	const CRUMB = 'text-caption text-accent font-medium underline underline-offset-2';

	let {
		title,
		description = '',
		eyebrow = '',
		crumbs = [],
		level = 2,
		actions = undefined,
		below = undefined
	}: {
		title: string;
		description?: string;
		eyebrow?: string;
		/** A breadcrumb, in place of the eyebrow. Hrefs arrive already resolve()d. */
		crumbs?: Crumb[];
		level?: 1 | 2 | 3 | 4;
		actions?: import('svelte').Snippet;
		/** Sub-navigation (tabs, section links) rendered inside the band. */
		below?: import('svelte').Snippet;
	} = $props();
</script>

<header class="bg-raise border-line border-b">
	<div
		class="max-w-page mx-auto flex w-full flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 lg:px-8 lg:py-5"
	>
		<div class="flex min-w-0 flex-1 basis-80 flex-col gap-1">
			{#if crumbs.length > 0}
				<nav aria-label="Breadcrumb">
					<ol class="text-caption text-ink-2 flex flex-wrap items-center gap-1">
						{#each crumbs as crumb (crumb.href)}
							<li class="flex items-center gap-1">
								<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the caller passes a resolve()d href -->
								<a href={crumb.href} class={CRUMB}>{crumb.label}</a>
								<span aria-hidden="true">›</span>
							</li>
						{/each}
					</ol>
				</nav>
			{:else if eyebrow}
				<p class="text-eyebrow text-ink-3 uppercase">{eyebrow}</p>
			{/if}
			<svelte:element this={`h${level}`} class="text-title">{title}</svelte:element>
			{#if description}
				<!-- text-ink-2, not text-ink-3: ink-2 is legal on every surface. -->
				<p class="max-w-measure text-body text-ink-2">{description}</p>
			{/if}
		</div>
		{#if actions}
			<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
		{/if}
		{#if below}
			<div class="basis-full">{@render below()}</div>
		{/if}
	</div>
</header>
