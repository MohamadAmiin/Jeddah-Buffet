<script lang="ts">
	// A till CLOSER — the 96px key that ends a screen (Pay, Pay · Cash, Open
	// session …). Written once (docs/redesign Phase 2, section 7.3) so every
	// closer follows the same rules:
	//   · a link when it navigates, a button when it acts;
	//   · disabled keeps its NAME (it is never renamed to the reason), turns to the
	//     disabled pair — never opacity — and says why in a line beside it, tied
	//     with aria-describedby;
	//   · every pressable till surface keeps a border-control-line edge.
	import type { Snippet } from 'svelte';

	let {
		href,
		disabled = false,
		reason,
		reasonId,
		tone = 'accent',
		type = 'button',
		form,
		onclick,
		class: className = '',
		children
	}: {
		/** Given and not disabled → the closer is a link. */
		href?: string;
		disabled?: boolean;
		/** Why it is disabled. Rendered above the key and wired with aria-describedby. */
		reason?: string;
		/** The id for the reason line; required when `reason` is given, so ids stay unique. */
		reasonId?: string;
		tone?: 'accent' | 'raise';
		type?: 'button' | 'submit';
		form?: string;
		onclick?: (event: MouseEvent) => void;
		class?: string;
		children: Snippet;
	} = $props();

	const face = $derived(
		disabled
			? 'bg-disabled-bg text-disabled-ink'
			: tone === 'accent'
				? 'bg-accent text-accent-ink'
				: 'bg-raise text-ink'
	);
	const KEY =
		'min-h-touch-xl rounded-card border-control-line text-title flex items-center justify-center gap-3 border px-4 font-semibold';
	const describedBy = $derived(disabled && reason && reasonId ? reasonId : undefined);
</script>

<div class="flex min-w-0 flex-1 flex-col gap-2 {className}">
	{#if disabled && reason && reasonId}
		<p id={reasonId} class="text-body text-ink-2 text-center">{reason}</p>
	{/if}
	{#if href && !disabled}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the caller passes a resolve()d href -->
		<a {href} class="{KEY} {face}">{@render children()}</a>
	{:else}
		<button {type} {form} {disabled} aria-describedby={describedBy} class="{KEY} {face}" {onclick}
			>{@render children()}</button
		>
	{/if}
</div>
