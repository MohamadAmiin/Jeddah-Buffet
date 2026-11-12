<script lang="ts">
	// THE CUSTOMERS LIST. It renders what the server sends and computes nothing:
	// every amount is the formatter's string. Colour never carries meaning alone —
	// an archived customer shows ◐ and the word.
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, PageBody, PageHeader, Table } from '$lib/components/ui';

	let { data } = $props();

	const columns = [
		{ key: 'name', label: 'Customer' },
		{ key: 'phone', label: 'Phone' },
		{ key: 'limit', label: 'Credit limit', numeric: true },
		{ key: 'balance', label: 'Owes', numeric: true },
		{ key: 'status', label: 'Status' }
	];
</script>

<svelte:head>
	<title>Customers · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Money"
	title="Customers"
	description="Customers who may eat now and pay later. A bill is charged to a customer on the till, and they pay it back on the till; this page is who they are, their limits and what each one owes."
>
	{#snippet actions()}
		<Button href={resolve('/customers/new')} variant="primary">Add a customer</Button>
	{/snippet}
</PageHeader>

<PageBody>
	{#if data.tripwire}
		<Alert tone="danger">
			The customers' balances add up to {data.tripwire.balances ?? '—'}, but account 1100 Accounts
			Receivable holds {data.tripwire.ledger ?? '—'}. They should be equal. Nothing has been changed
			— tell whoever supports this system.
		</Alert>
	{/if}

	<Card>
		<dl class="flex flex-wrap items-baseline gap-x-8 gap-y-2">
			<div>
				<dt class="text-ink-2 text-xs">Owed by customers in total</dt>
				<dd class="text-ink font-mono text-xl font-medium tabular-nums" data-testid="total-owed">
					{data.totalOwed ?? '—'}
					{#if data.currency}<span class="text-ink-2 text-sm">{data.currency.code}</span>{/if}
				</dd>
			</div>
		</dl>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h3 class="text-section text-ink">
					{data.showArchived ? 'All customers' : 'Customers'}
				</h3>
				{#if data.showArchived}
					<a href={resolve('/customers')} class="text-ink text-sm underline">Hide archived</a>
				{:else}
					<!-- A GET form, not a hand-built query string: resolve() takes route ids. -->
					<form method="GET" action={resolve('/customers')}>
						<input type="hidden" name="archived" value="1" />
						<button type="submit" class="text-ink text-sm underline">Show archived</button>
					</form>
				{/if}
			</div>
			<Table
				caption="Customers"
				{columns}
				rows={data.customers}
				empty="No customers yet. Add the first one."
			>
				{#snippet cell(row, key)}
					{#if key === 'name'}
						<a href={resolve(`/customers/${row.id}`)} class="text-ink font-medium underline">
							{row.name}
						</a>
					{:else if key === 'phone'}
						<span class="text-ink font-mono">{row.phone}</span>
					{:else if key === 'limit'}
						<span class="text-ink">{row.limit ?? 'No limit'}</span>
					{:else if key === 'balance'}
						<span class="text-ink">{row.balance ?? '—'}</span>
					{:else if key === 'status'}
						<span class="text-ink text-sm">
							{#if row.archived}
								<span aria-hidden="true" class="font-mono">◐</span> archived{row.owes
									? ' — still owes'
									: ''}
							{:else if row.owes}
								<span aria-hidden="true" class="font-mono">●</span> active — owes
							{:else}
								<span aria-hidden="true" class="font-mono">○</span> active
							{/if}
						</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>
</PageBody>
