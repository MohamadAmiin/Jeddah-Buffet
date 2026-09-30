<script lang="ts">
	// THE GUEST CHECK (docs/redesign Phase 2, section 7.3) — one component for the
	// order screen (`edit`) and the pay screen (`bill`), so the bill never drops
	// what the check shows: modifiers, the unit price and tax rate STORED on each
	// line (invariant 7). It takes strings only: every figure is formatted by the
	// page through the money module; this file does no money arithmetic.
	//
	// The line list takes whatever height is left and scrolls INSIDE itself; the
	// totals and the closer row are pinned to the bottom, so the closer never
	// leaves the screen.
	import type { Snippet } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import CheckLine, { type CheckLineView } from './CheckLine.svelte';

	let {
		mode,
		pill,
		caption,
		note = null,
		lines,
		totals,
		totalLabel = 'Total',
		selectedId = null,
		onselect,
		onfewer,
		onmore,
		onremove,
		display = 'flex',
		sheet = false,
		empty,
		closer
	}: {
		mode: 'edit' | 'bill';
		pill: { glyph: '○' | '◐' | '●' | '◆' | '✕'; word: string };
		caption: string;
		note?: string | null;
		lines: CheckLineView[];
		totals: {
			subtotal: string;
			discount?: string | null;
			tax: string;
			taxMode: 'exclusive' | 'inclusive';
			total: string;
		};
		totalLabel?: string;
		selectedId?: string | null;
		onselect?: (id: string) => void;
		onfewer?: (id: string) => void;
		onmore?: (id: string) => void;
		onremove?: (id: string) => void;
		/** Classes that decide where the check shows, e.g. `hidden md:flex`. */
		display?: string;
		/** Full width and height, inside the phone check sheet. */
		sheet?: boolean;
		/** Shown in place of the lines when there are none. */
		empty?: Snippet;
		/** The closer row. Called with this check's id prefix, so ids stay unique. */
		closer: Snippet<[string]>;
	} = $props();

	// The order page renders the check twice (the column and the phone sheet), so
	// every id is built from this instance's own id.
	const uid = $props.id();

	let list = $state<HTMLOListElement>();
	// Keep the selected line — keys and all — in view. The page selects the newest
	// line after every add, so this also brings an added line into view. It runs
	// after the DOM update, when the selected line's keys are already rendered.
	$effect(() => {
		const id = selectedId;
		void lines.length;
		if (!list || id === null) return;
		const row = [...list.children].find((li) => (li as HTMLElement).dataset.lineId === id);
		row?.scrollIntoView({ block: 'nearest' });
	});
</script>

<section
	aria-labelledby="{uid}-h"
	class="{display} {sheet
		? 'h-full w-full'
		: 'w-96 xl:w-md'} rounded-card border-line bg-raise shadow-raised shrink-0 flex-col overflow-hidden border"
>
	<header class="bg-accent text-accent-ink flex shrink-0 items-center gap-3 px-5 py-3">
		<Icon name="clipboard" class="size-7" />
		<div class="flex min-w-0 flex-1 flex-col">
			<h2 id="{uid}-h" class="text-title">Current Order</h2>
			<p class="text-body truncate">{caption}</p>
			{#if note}
				<p class="text-body truncate">Note: {note}</p>
			{/if}
		</div>
		<span
			class="border-accent-ink text-caption shrink-0 rounded-full border px-3 py-1 font-semibold"
			><span aria-hidden="true" class="font-mono">{pill.glyph}</span> {pill.word}</span
		>
	</header>

	{#if lines.length === 0 && empty}
		<div class="relative flex min-h-0 flex-1 flex-col overflow-y-auto">{@render empty()}</div>
	{:else}
		<ol
			bind:this={list}
			aria-label="Lines on the check"
			class="divide-line-soft relative min-h-0 flex-1 divide-y overflow-y-auto"
		>
			{#each lines as line (line.id)}
				<CheckLine
					{line}
					{mode}
					selected={line.id === selectedId}
					{onselect}
					{onfewer}
					{onmore}
					{onremove}
				/>
			{/each}
		</ol>
	{/if}

	<footer class="border-line shrink-0 border-t px-5 pt-3 pb-5">
		<dl class="flex flex-col gap-0.5">
			<div class="text-ink-2 flex items-baseline justify-between gap-4">
				<dt>Subtotal</dt>
				<dd class="text-right font-mono tabular-nums">{totals.subtotal}</dd>
			</div>
			{#if totals.discount}
				<div class="flex items-baseline justify-between gap-4">
					<dt class="text-ink-2">Discount</dt>
					<dd class="text-danger text-right font-mono tabular-nums">−{totals.discount}</dd>
				</div>
			{/if}
			<div class="text-ink-2 flex items-baseline justify-between gap-4">
				<dt>Tax <span class="text-body">({totals.taxMode})</span></dt>
				<dd class="text-right font-mono tabular-nums">{totals.tax}</dd>
			</div>
			<div
				class="border-line mt-1 flex flex-wrap items-baseline justify-between gap-x-4 border-t pt-2"
			>
				<dt class="font-display text-title">{totalLabel}</dt>
				<dd class="text-total text-accent text-right font-mono tabular-nums">{totals.total}</dd>
			</div>
		</dl>
		<div class="mt-4 flex gap-3">{@render closer(uid)}</div>
	</footer>
</section>
