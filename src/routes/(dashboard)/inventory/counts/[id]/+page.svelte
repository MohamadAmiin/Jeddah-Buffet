<script lang="ts">
	// ONE POSTED COUNT, read only. Every amount is the formatter's string and every
	// quantity formatQty's; a negative carries its leading − AND text-danger, and a
	// shortfall says so in words.
	import { resolve } from '$app/paths';
	import { Card, PageHeader, Table } from '$lib/components/ui';

	let { data } = $props();

	const columns = [
		{ key: 'name', label: 'Ingredient' },
		{ key: 'system', label: 'In the stock book', numeric: true },
		{ key: 'counted', label: 'Counted', numeric: true },
		{ key: 'difference', label: 'Difference', numeric: true },
		{ key: 'value', label: 'Value', numeric: true }
	];
</script>

<svelte:head>
	<title>Count of {data.count.businessDate} · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Stock counts"
	title={`Count of ${data.count.businessDate}`}
	description="What the shelf held against the stock book when the count was posted. A posted count is never edited."
/>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<p class="text-ink-2 text-sm">
		<a class="text-ink underline" href={resolve('/inventory/counts')}>Back to stock counts</a>
	</p>

	<Card class="max-w-form">
		<dl class="grid grid-cols-2 gap-2 text-sm">
			<dt class="text-ink-2">Ingredients counted</dt>
			<dd class="text-ink text-end font-mono tabular-nums">{data.count.lineCount}</dd>
			<dt class="text-ink-2">Shortfall (value lost)</dt>
			<dd class="text-ink text-end font-mono tabular-nums">{data.count.shortfall ?? '—'}</dd>
			<dt class="text-ink-2">Surplus (value found)</dt>
			<dd class="text-ink text-end font-mono tabular-nums">{data.count.surplus ?? '—'}</dd>
			{#if data.count.note}
				<dt class="text-ink-2">Note</dt>
				<dd class="text-ink">{data.count.note}</dd>
			{/if}
		</dl>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Differences</h3>
			<Table caption="Count differences" {columns} rows={data.lines} empty="No lines.">
				{#snippet cell(row, key)}
					{#if key === 'name'}
						<span class="text-ink font-medium">{row.name}</span>
					{:else if key === 'system'}
						<span class={row.systemNegative ? 'text-danger' : 'text-ink'}>{row.system}</span>
						{#if row.systemNegative}
							<span class="text-danger block text-sm">◆ below zero</span>
						{/if}
					{:else if key === 'counted'}
						<span class="text-ink">{row.counted}</span>
					{:else if key === 'difference'}
						<span class={row.differenceNegative ? 'text-danger' : 'text-ink'}>
							{row.difference}
						</span>
						{#if row.differenceNegative}
							<span class="text-danger block text-sm">short</span>
						{/if}
					{:else if key === 'value'}
						<span class={row.valueNegative ? 'text-danger' : 'text-ink'}>{row.value ?? '—'}</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>
</div>
