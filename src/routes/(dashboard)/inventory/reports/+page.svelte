<script lang="ts">
	// THE INVENTORY REPORTS. Read only; every amount is the formatter's string and
	// every quantity formatQty's. A negative amount carries its leading − AND
	// text-danger; stock below zero shows ◆ and the words.
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		Button,
		Callout,
		Field,
		PageBody,
		PageHeader,
		StatTile,
		Table
	} from '$lib/components/ui';

	let { data } = $props();

	const consumptionColumns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'name', label: 'Ingredient' },
		{ key: 'qty', label: 'Used', numeric: true },
		{ key: 'cost', label: 'Cost', numeric: true }
	];
	const wasteColumns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'name', label: 'Ingredient' },
		{ key: 'qty', label: 'Quantity', numeric: true },
		{ key: 'reason', label: 'Reason' },
		{ key: 'cost', label: 'Cost', numeric: true }
	];
	const cogsColumns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'sales', label: 'Sales', numeric: true },
		{ key: 'revaluation', label: 'Revaluations', numeric: true },
		{ key: 'total', label: 'Total', numeric: true }
	];
	const negativeColumns = [
		{ key: 'name', label: 'Ingredient' },
		{ key: 'onHand', label: 'On hand', numeric: true },
		{ key: 'status', label: 'Status' }
	];

	// The inventory section row — the same on every inventory page (copied from
	// /inventory).
	const SECTION =
		'flex items-center border-b-2 border-transparent pb-3 text-sm font-medium text-ink-2 hover:text-ink data-current:border-accent data-current:text-ink';
	const sections = [
		{ label: 'Recipes', href: resolve('/inventory/recipes') },
		{ label: 'Deliveries', href: resolve('/purchases') },
		{ label: 'Waste', href: resolve('/inventory/waste') },
		{ label: 'Counts', href: resolve('/inventory/counts') },
		{ label: 'Reports', href: resolve('/inventory/reports') }
	];

	// A report card: the heading, its note and its table are DIRECT children of
	// the <section> — e2e finds a card as the innermost section/div holding its
	// heading (/Cost of goods sold/) and reads the figures inside it.
	const CARD = 'rounded-card border-line bg-raise shadow-card flex flex-col overflow-hidden border';
	const CARD_TITLE = 'text-section px-6 pt-4 pb-3';
	const CARD_NOTE = 'text-caption text-ink-2 px-6 pb-3';
</script>

<svelte:head>
	<title>Inventory reports · matcami</title>
</svelte:head>

<PageHeader
	crumbs={[{ label: 'Inventory', href: resolve('/inventory') }]}
	title="Inventory reports"
	description={`Business days ${data.from} to ${data.to}. Figures come from the stock book and the posted journal.`}
>
	{#snippet actions()}
		<form method="GET" class="flex flex-wrap items-end gap-2" aria-label="Business days">
			<Field id="report-from" name="from" label="From" type="date" required value={data.from} />
			<Field id="report-to" name="to" label="To" type="date" required value={data.to} />
			<Button type="submit" variant="secondary">Show</Button>
		</form>
	{/snippet}
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
	{#if data.reconciliation.differs}
		<!-- The tripwire: a STANDING notice, so a Callout (role="status", it owns the
		     glyph — words only here). -->
		<Callout tone="danger" title="The stock book and the books disagree">
			The stock value differs from the books by {data.reconciliation.difference ?? '—'} ({data
				.reconciliation.driftCount}
			{data.reconciliation.driftCount === 1 ? 'ingredient differs' : 'ingredients differ'} from the stock
			book).
		</Callout>
	{/if}

	<!-- The totals row. -->
	<section aria-labelledby="books-h" class="flex flex-col gap-3">
		<h3 id="books-h" class="text-section">Stock value and the books</h3>
		<dl class="grid gap-3 sm:grid-cols-3">
			<StatTile label="Stock value" numeric>
				<span class="block text-end">{data.reconciliation.stockValue ?? '—'}</span>
			</StatTile>
			<StatTile label="Inventory account (1200)" numeric>
				<span class="block text-end">{data.reconciliation.ledger1200 ?? '—'}</span>
			</StatTile>
			<StatTile label="Difference" numeric>
				<span
					class={`block text-end ${data.reconciliation.differenceNegative ? 'text-danger' : 'text-ink'}`}
				>
					{data.reconciliation.difference ?? '—'}
				</span>
			</StatTile>
		</dl>
	</section>

	<div class="grid items-start gap-6 xl:grid-cols-2">
		<section class={CARD}>
			<h3 class={CARD_TITLE}>Cost of goods sold per business day</h3>
			<p class={CARD_NOTE}>
				Sales is the cost of what was sold. Revaluations correct stock that was sold before its
				delivery was entered.
			</p>
			<div class="px-6 md:px-0">
				<Table
					caption="Cost of goods sold per business day"
					columns={cogsColumns}
					rows={data.cogs}
					empty="No cost of goods sold in these business days."
				>
					{#snippet cell(row, key)}
						{#if key === 'businessDate'}
							<span class="text-ink">{row.businessDate}</span>
						{:else if key === 'sales'}
							<span class={row.salesNegative ? 'text-danger' : 'text-ink'}>{row.sales ?? '—'}</span>
						{:else if key === 'revaluation'}
							<span class={row.revaluationNegative ? 'text-danger' : 'text-ink'}>
								{row.revaluation ?? '—'}
							</span>
						{:else if key === 'total'}
							<span class={`font-medium ${row.totalNegative ? 'text-danger' : 'text-ink'}`}>
								{row.total ?? '—'}
							</span>
						{/if}
					{/snippet}
				</Table>
			</div>
		</section>

		<section class={CARD}>
			<h3 class={CARD_TITLE}>Ingredients used per business day</h3>
			<div class="px-6 md:px-0">
				<Table
					caption="Ingredients used per business day"
					columns={consumptionColumns}
					rows={data.consumption}
					empty="No sales used any ingredient in these business days."
				>
					{#snippet cell(row, key)}
						{#if key === 'businessDate'}
							<span class="text-ink">{row.businessDate}</span>
						{:else if key === 'name'}
							<span class="text-ink font-medium">{row.name}</span>
						{:else if key === 'qty'}
							<span class="text-ink">{row.qty}</span>
						{:else if key === 'cost'}
							<span class={row.costNegative ? 'text-danger' : 'text-ink'}>{row.cost ?? '—'}</span>
						{/if}
					{/snippet}
				</Table>
			</div>
		</section>

		<section class={CARD}>
			<h3 class={CARD_TITLE}>Waste</h3>
			<div class="px-6 md:px-0">
				<Table
					caption="Waste"
					columns={wasteColumns}
					rows={data.waste}
					empty="No waste in these business days."
				>
					{#snippet cell(row, key)}
						{#if key === 'businessDate'}
							<span class="text-ink">{row.businessDate}</span>
						{:else if key === 'name'}
							<span class="text-ink font-medium">{row.name}</span>
						{:else if key === 'qty'}
							<span class="text-ink">{row.qty}</span>
						{:else if key === 'reason'}
							<span class="text-ink">{row.reason}</span>
							{#if row.note}
								<span class="text-ink-2 block text-sm">{row.note}</span>
							{/if}
						{:else if key === 'cost'}
							<span class={row.costNegative ? 'text-danger' : 'text-ink'}>{row.cost ?? '—'}</span>
						{/if}
					{/snippet}
				</Table>
			</div>
		</section>

		<section class={CARD}>
			<h3 class={CARD_TITLE}>Stock below zero</h3>
			<p class={CARD_NOTE}>
				Sales are never blocked by stock. An ingredient below zero was used before its delivery was
				entered, or needs a count.
			</p>
			<div class="px-6 md:px-0">
				<Table
					caption="Stock below zero"
					columns={negativeColumns}
					rows={data.negative}
					empty="No ingredient is below zero."
				>
					{#snippet cell(row, key)}
						{#if key === 'name'}
							<span class="text-ink font-medium">{row.name}</span>
						{:else if key === 'onHand'}
							<span class="text-danger">{row.onHand}</span>
						{:else if key === 'status'}
							<span class="text-danger"
								><span aria-hidden="true" class="font-mono">◆</span> below zero</span
							>
						{/if}
					{/snippet}
				</Table>
			</div>
		</section>
	</div>
</PageBody>
