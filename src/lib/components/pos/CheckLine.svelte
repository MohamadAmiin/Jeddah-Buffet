<script lang="ts" module>
	/** One line of the check, every figure already formatted by the page. */
	export type CheckLineView = {
		id: string;
		quantity: number;
		name: string;
		modifiers: { id: string; name: string; delta: string; negative: boolean }[];
		/** The unit price and tax rate STORED on the line (invariant 7). */
		unitPrice: string;
		taxRate: string;
		amount: string;
	};
</script>

<script lang="ts">
	// One line of the guest check (docs/redesign Phase 2, section 7.3). In `edit`
	// mode the row is a button: tapping selects it, tapping the selected line
	// collapses it, and ONLY the selected line shows its keys — that is what lets
	// a 4–6 line order fit above Pay. In `bill` mode it is a plain row.
	import Icon from '../ui/Icon.svelte';

	let {
		line,
		mode,
		selected = false,
		onselect,
		onfewer,
		onmore,
		onremove
	}: {
		line: CheckLineView;
		mode: 'edit' | 'bill';
		selected?: boolean;
		onselect?: (id: string) => void;
		onfewer?: (id: string) => void;
		onmore?: (id: string) => void;
		onremove?: (id: string) => void;
	} = $props();

	const KEY =
		'grid min-h-touch-min min-w-touch-min place-items-center rounded-control border border-control-line bg-raise';
</script>

{#snippet summary()}
	<span
		class="bg-st-new-bg text-caption text-st-new mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-semibold"
		><span aria-hidden="true" class="font-mono">◇</span>NEW</span
	>
	<span class="flex min-w-0 flex-1 flex-col">
		<span class="leading-snug font-semibold"
			><span class="font-mono font-medium">{line.quantity}×</span> {line.name}</span
		>
		{#each line.modifiers as m (m.id)}
			<span class="text-body text-ink-2"
				>+ {m.name}
				<span class="font-mono tabular-nums {m.negative ? 'text-danger' : ''}">{m.delta}</span
				></span
			>
		{/each}
		<span class="text-body text-ink-2"
			>@ <span class="font-mono tabular-nums">{line.unitPrice}</span> · tax {line.taxRate}</span
		>
	</span>
	<span class="font-mono font-medium tabular-nums">{line.amount}</span>
{/snippet}

<li
	data-line-id={line.id}
	class="relative border-l-4 {selected ? 'border-accent bg-accent-soft' : 'border-transparent'}"
>
	{#if mode === 'edit'}
		<button
			type="button"
			aria-expanded={selected}
			class="flex w-full items-start gap-3 py-3 pr-5 pl-4 text-left"
			onclick={() => onselect?.(line.id)}
		>
			{@render summary()}
		</button>
		{#if selected}
			<div
				role="group"
				aria-label="Change {line.name}"
				class="flex items-center gap-2 pr-5 pb-3 pl-4"
			>
				<button type="button" class={KEY} onclick={() => onfewer?.(line.id)}>
					<span class="sr-only">One fewer {line.name}</span>
					<Icon name="minus" class="size-6" />
				</button>
				<span class="text-title min-w-10 text-center font-mono font-medium tabular-nums"
					><span class="sr-only">Quantity </span>{line.quantity}</span
				>
				<button type="button" class={KEY} onclick={() => onmore?.(line.id)}>
					<span class="sr-only">One more {line.name}</span>
					<Icon name="plus" class="size-6" />
				</button>
				<button
					type="button"
					class="min-h-touch-min rounded-control border-control-line bg-raise ml-auto flex items-center gap-2 border px-4 font-semibold"
					onclick={() => onremove?.(line.id)}
				>
					<Icon name="trash" class="size-5" />
					Remove<span class="sr-only"> {line.name}</span>
				</button>
			</div>
		{/if}
	{:else}
		<div class="flex w-full items-start gap-3 py-3 pr-5 pl-4">
			{@render summary()}
		</div>
	{/if}
</li>
