<script lang="ts">
	// ONE FIGURE ON THE OVERVIEW (docs/redesign Phase 6): an eyebrow label, a value,
	// a caption. A <dt>/<dd> pair, so the caller wraps the tiles in a <dl>. A
	// numeric value is mono at weight 500 (IBM Plex Mono ships 400 and 500 only).
	import type { Snippet } from 'svelte';

	let {
		label,
		caption = '',
		numeric = false,
		children
	}: { label: string; caption?: string; numeric?: boolean; children: Snippet } = $props();
</script>

<div class="rounded-card border-line bg-raise shadow-flat flex flex-col gap-1 border p-4">
	<dt class="text-eyebrow text-ink-3 uppercase">{label}</dt>
	<dd class="text-section {numeric ? 'font-mono font-medium tabular-nums' : ''}">
		{@render children()}
	</dd>
	{#if caption}<dd class="text-caption text-ink-2">{caption}</dd>{/if}
</div>
