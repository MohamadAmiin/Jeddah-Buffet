<script lang="ts">
	// ONE POSTED COUNT, read only. Every amount is the formatter's string and every
	// quantity formatQty's; a negative carries its leading − AND text-danger, and a
	// shortfall says so in words.
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Card, PageBody, PageHeader, Table } from '$lib/components/ui';

	let { data } = $props();

	const columns = [
		{ key: 'name', label: 'Ingredient' },
		{ key: 'system', label: 'In the stock book', numeric: true },
		{ key: 'counted', label: 'Counted', numeric: true },
		{ key: 'difference', label: 'Difference', numeric: true },
		{ key: 'value', label: 'Value', numeric: true }
	];

	// The inventory section row — the same on every inventory page.
	const SECTION =
		'flex items-center border-b-2 border-transparent pb-3 text-sm font-medium text-ink-2 hover:text-ink data-current:border-accent data-current:text-ink';
	const sections = [
		{ label: 'Recipes', href: resolve('/inventory/recipes') },
		{ label: 'Deliveries', href: resolve('/purchases') },
		{ label: 'Waste', href: resolve('/inventory/waste') },
		{ label: 'Counts', href: resolve('/inventory/counts') },
		{ label: 'Reports', href: resolve('/inventory/reports') }
	];
</script>

<svelte:head>
	<title>Count of {data.count.businessDate} · matcami</title>
</svelte:head>

<PageHeader
	crumbs={[
		{ label: 'Inventory', href: resolve('/inventory') },
		{ label: 'Stock counts', href: resolve('/inventory/counts') }
	]}
	title={`Count of ${data.count.businessDate}`}
	description="What the shelf held against the stock book when the count was posted. A posted count is never edited."
>
	{#snippet below()}
		<nav aria-label="Inventory sections" class="-mb-4 flex flex-wrap gap-x-6 gap-y-1 lg:-mb-5">
			{#each sections as link (link.href)}
				{@const here = page.url.pathname === link.href}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- every href above is a resolve() result -->
				<a
					href={link.href}
					class={SECTION}
					aria-current={here ? 'page' : undefined}
					data-current={here || page.url.pathname.startsWith(`${link.href}/`) ? '' : undefined}
					>{link.label}</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}
		</nav>
	{/snippet}
</PageHeader>

<PageBody>
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

	<section
		aria-labelledby="differences-h"
		class="rounded-card border-line bg-raise shadow-card overflow-hidden border"
	>
		<div class="px-6 py-4">
			<h3 id="differences-h" class="text-section">Differences</h3>
		</div>
		<div class="px-6 md:px-0">
			<Table caption="Count differences" {columns} rows={data.lines} empty="No lines.">
				{#snippet cell(row, key)}
					{#if key === 'name'}
						<span class="text-ink font-medium">{row.name}</span>
					{:else if key === 'system'}
						<span class={row.systemNegative ? 'text-danger' : 'text-ink'}>{row.system}</span>
						{#if row.systemNegative}
							<span class="text-danger block font-sans text-sm"
								><span aria-hidden="true" class="font-mono">◆</span> below zero</span
							>
						{/if}
					{:else if key === 'counted'}
						<span class="text-ink">{row.counted}</span>
					{:else if key === 'difference'}
						<span class={row.differenceNegative ? 'text-danger' : 'text-ink'}>
							{row.difference}
						</span>
						{#if row.differenceNegative}
							<span class="text-danger block font-sans text-sm">short</span>
						{/if}
					{:else if key === 'value'}
						<span class={row.valueNegative ? 'text-danger' : 'text-ink'}>{row.value ?? '—'}</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</section>
</PageBody>
