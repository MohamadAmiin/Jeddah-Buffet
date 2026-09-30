<script lang="ts">
	// THE DELIVERIES LIST. It renders what the server sends and computes nothing:
	// every amount is the formatter's string. Colour never carries meaning alone —
	// a reversed delivery shows ↩ and the word, one still owed ◐ and the words.
	import { resolve } from '$app/paths';
	import { Button, Card, PageBody, PageHeader, Table } from '$lib/components/ui';

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

<PageBody>
	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-section text-ink">Recent deliveries</h3>
			<Table
				caption="Deliveries"
				{columns}
				rows={data.purchases}
				empty="No deliveries yet. Record the first one."
			>
				{#snippet cell(row, key)}
					{#if key === 'supplierName'}
						<a href={resolve(`/purchases/${row.id}`)} class="text-ink font-medium underline">
							{row.supplierName}
						</a>
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
								<span aria-hidden="true" class="font-mono">↩</span> reversed
							{:else if row.status === 'owed'}
								<span aria-hidden="true" class="font-mono">◐</span> still owed
							{:else}
								<span aria-hidden="true" class="font-mono">●</span> settled
							{/if}
						</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>
</PageBody>
