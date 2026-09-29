<script lang="ts">
	// THE DELIVERIES LIST. It renders what the server sends and computes nothing:
	// every amount is the formatter's string. Colour never carries meaning alone —
	// a reversed delivery shows ↩ and the word, one still owed ◐ and the words.
	import { resolve } from '$app/paths';
	import { Button, Card, PageHeader, Table } from '$lib/components/ui';

	let { data } = $props();

	const columns = [
		{ key: 'supplierName', label: 'Supplier' },
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'paidBy', label: 'Paid by' },
		{ key: 'total', label: 'Total', numeric: true },
		{ key: 'outstanding', label: 'Outstanding', numeric: true },
		{ key: 'status', label: 'Status' }
	];
</script>

<svelte:head>
	<title>Deliveries · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Inventory"
	title="Deliveries"
	description="Every delivery brings stock in at its cost, paid now or on credit. A wrong one is reversed, never edited — both stay on the books."
>
	{#snippet actions()}
		<Button href={resolve('/purchases/new')} variant="primary">Record a delivery</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Recent deliveries</h3>
			<Table
				caption="Deliveries"
				{columns}
				rows={data.purchases}
				empty="No deliveries yet. Record the first one."
			>
				{#snippet cell(row, key)}
					{#if key === 'supplierName'}
						<span class="text-ink font-medium">{row.supplierName}</span>
					{:else if key === 'businessDate'}
						<span class="text-ink">{row.businessDate}</span>
					{:else if key === 'paidBy'}
						<span class="text-ink">{row.paidBy}</span>
					{:else if key === 'total'}
						<span class={row.status === 'reversed' ? 'text-ink-2 line-through' : 'text-ink'}>
							{row.total ?? '—'}
						</span>
					{:else if key === 'outstanding'}
						<span class="text-ink">{row.outstanding ?? '—'}</span>
					{:else if key === 'status'}
						<span class="text-ink text-sm">
							{#if row.status === 'reversed'}
								↩ reversed
							{:else if row.status === 'owed'}
								◐ still owed
							{:else}
								● settled
							{/if}
						</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>
</div>
