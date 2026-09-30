<script lang="ts">
	// THE INVENTORY REPORTS. Read only; every amount is the formatter's string and
	// every quantity formatQty's. A negative amount carries its leading − AND
	// text-danger; stock below zero shows ◆ and the words.
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader, Table } from '$lib/components/ui';

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
</script>

<svelte:head>
	<title>Inventory reports · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Inventory"
	title="Inventory reports"
	description={`Business days ${data.from} to ${data.to}. Figures come from the stock book and the posted journal.`}
/>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<p class="text-ink-2 text-sm">
		<a class="text-ink underline" href={resolve('/inventory')}>Back to inventory</a>
	</p>

	<Card class="max-w-form">
		<form method="GET" class="flex flex-col gap-4">
			<h3 class="text-ink font-semibold">Business days</h3>
			<Field id="report-from" name="from" label="From" type="date" required value={data.from} />
			<Field id="report-to" name="to" label="To" type="date" required value={data.to} />
			<div>
				<Button type="submit" variant="secondary">Show</Button>
			</div>
		</form>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Stock value and the books</h3>
			{#if data.reconciliation.differs}
				<Alert tone="danger">
					✕ The stock value differs from the books by {data.reconciliation.difference ?? '—'} ({data
						.reconciliation.driftCount}
					{data.reconciliation.driftCount === 1 ? 'ingredient differs' : 'ingredients differ'} from the
					stock book).
				</Alert>
			{/if}
			<dl class="grid max-w-form grid-cols-2 gap-2 text-sm">
				<dt class="text-ink-2">Stock value</dt>
				<dd class="text-ink text-end font-mono tabular-nums">
					{data.reconciliation.stockValue ?? '—'}
				</dd>
				<dt class="text-ink-2">Inventory account (1200)</dt>
				<dd class="text-ink text-end font-mono tabular-nums">
					{data.reconciliation.ledger1200 ?? '—'}
				</dd>
				<dt class="text-ink-2">Difference</dt>
				<dd
					class={`text-end font-mono tabular-nums ${
						data.reconciliation.differenceNegative ? 'text-danger' : 'text-ink'
					}`}
				>
					{data.reconciliation.difference ?? '—'}
				</dd>
			</dl>
		</div>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Ingredients used per business day</h3>
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
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Waste</h3>
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
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Cost of goods sold per business day</h3>
			<p class="text-ink-2 text-sm">
				Sales is the cost of what was sold. Revaluations correct stock that was sold before its
				delivery was entered.
			</p>
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
						<span class={`font-semibold ${row.totalNegative ? 'text-danger' : 'text-ink'}`}>
							{row.total ?? '—'}
						</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Stock below zero</h3>
			<p class="text-ink-2 text-sm">
				Sales are never blocked by stock. An ingredient below zero was used before its delivery was
				entered, or needs a count.
			</p>
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
						<span class="text-danger">◆ below zero</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>
</div>
