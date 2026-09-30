<script lang="ts">
	// AN ATTENTION BANNER WITH AN ACTION (docs/redesign Phase 6) — the flagged-sales
	// notice, the stock tripwire. It owns the glyph (◆ offline tone, ✕ danger);
	// callers pass words only, so the glyph is never doubled. A STANDING notice is
	// role="status", never role="alert" (at most one alert per page, and this is not
	// news).
	import type { Snippet } from 'svelte';

	let {
		tone = 'offline',
		title,
		children,
		action = undefined
	}: {
		tone?: 'offline' | 'danger';
		title: string;
		children?: Snippet;
		action?: Snippet;
	} = $props();

	const TONE = {
		offline: { glyph: '◆', cls: 'border-st-offline bg-st-offline-bg text-st-offline' },
		danger: { glyph: '✕', cls: 'border-danger bg-danger-bg text-danger' }
	} as const;
</script>

<div
	role="status"
	class="rounded-card flex flex-wrap items-center gap-x-4 gap-y-3 border px-5 py-4 {TONE[tone].cls}"
>
	<span aria-hidden="true" class="text-title font-mono font-medium">{TONE[tone].glyph}</span>
	<div class="flex min-w-0 flex-1 basis-72 flex-col gap-0.5">
		<h3 class="text-section font-sans">{title}</h3>
		{#if children}<div class="text-body">{@render children()}</div>{/if}
	</div>
	{#if action}{@render action()}{/if}
</div>
