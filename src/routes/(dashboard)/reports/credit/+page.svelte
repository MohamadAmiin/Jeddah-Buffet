<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button, Card, Field, Icon, PageBody, PageHeader } from '$lib/components/ui';

	let { data } = $props();

	// The /reports table classes: header row bg-raise-2, px-6 cells, money mono,
	// tabular and right-aligned. Every figure arrives formatted by the load.
	const th = 'text-ink-2 px-6 py-3 text-start text-xs font-medium';
	const thMoney = 'text-ink-2 px-6 py-3 text-end text-xs font-medium';
	const td = 'border-line-soft border-t px-6 py-2.5';
	const tdMoney = 'border-line-soft border-t px-6 py-2.5 text-end font-mono tabular-nums';
	const cardClass = 'rounded-card border-line bg-raise shadow-card flex flex-col border';
	const cardTitle = 'text-section px-6 pt-4 pb-3';
	const range = $derived(data.from === data.to ? data.from : `${data.from} to ${data.to}`);
	const empty = $derived(data.charges.length === 0 && data.payments.length === 0);
</script>

<svelte:head><title>Customer credit · {range} · matcami</title></svelte:head>

<PageHeader
	title="Customer credit"
	description="Every bill charged to a customer's credit and every payment a customer made, with a total per cashier. Grouped by business date."
>
	{#snippet actions()}
		<div class="flex flex-wrap items-end gap-2">
			<Button href={resolve('/reports')} variant="ghost">
				<Icon name="chevron-left" class="size-4" />Sales report
			</Button>
			<form method="GET" class="flex flex-wrap items-end gap-2">
				<Field id="from" name="from" type="date" label="From" value={data.from} />
				<Field id="to" name="to" type="date" label="To" value={data.to} />
				<Button type="submit" variant="secondary">Show</Button>
			</form>
		</div>
	{/snippet}
</PageHeader>

<PageBody>
	{#if empty}
		<Card>
			<p class="text-body text-ink-2">
				<span aria-hidden="true" class="font-mono">○</span> Nothing was charged to credit and no customer
				paid in this range.
			</p>
		</Card>
	{:else}
		<Card>
			<dl class="flex flex-wrap gap-x-10 gap-y-3">
				<div>
					<dt class="text-ink-2 text-xs">Charged to credit ({data.currency?.code})</dt>
					<dd class="text-ink font-mono text-xl font-medium tabular-nums">{data.charged}</dd>
				</div>
				<div>
					<dt class="text-ink-2 text-xs">Received from customers, net of reversals</dt>
					<dd class="text-ink font-mono text-xl font-medium tabular-nums">{data.receivedNet}</dd>
				</div>
			</dl>
		</Card>

		<section class={cardClass}>
			<h3 class={cardTitle}>By cashier</h3>
			<table class="w-full text-sm">
				<caption class="sr-only">Customer credit by cashier</caption>
				<thead class="bg-raise-2">
					<tr>
						<th scope="col" class={th}>Cashier</th>
						<th scope="col" class={thMoney}>Bills charged</th>
						<th scope="col" class={thMoney}>Charged ({data.currency?.code})</th>
						<th scope="col" class={thMoney}>Payments taken</th>
						<th scope="col" class={thMoney}>Received</th>
					</tr>
				</thead>
				<tbody>
					{#each data.byCashier as row (row.key)}
						<tr>
							<td class={td}>{row.cashier}</td>
							<td class={tdMoney}>{row.charges}</td>
							<td class={tdMoney}>{row.charged}</td>
							<td class={tdMoney}>{row.payments}</td>
							<td class={tdMoney}>{row.received}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section class={cardClass}>
			<h3 class={cardTitle}>Bills charged to credit</h3>
			{#if data.charges.length === 0}
				<p class="text-body text-ink-2 px-6 pb-4">None in this range.</p>
			{:else}
				<table class="w-full text-sm">
					<caption class="sr-only">Bills charged to credit</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Business date</th>
							<th scope="col" class={th}>Time</th>
							<th scope="col" class={th}>Invoice</th>
							<th scope="col" class={th}>Customer</th>
							<th scope="col" class={th}>Cashier</th>
							<th scope="col" class={th}>Till</th>
							<th scope="col" class={thMoney}>Amount ({data.currency?.code})</th>
						</tr>
					</thead>
					<tbody>
						{#each data.charges as row (row.orderId)}
							<tr>
								<td class={td}>{row.businessDate}</td>
								<td class={td}>{row.time}</td>
								<td class="{td} font-mono">{row.invoiceNumber}</td>
								<td class={td}>
									<a href={resolve(`/customers/${row.customerId}`)} class="underline"
										>{row.customerName}</a
									>
								</td>
								<td class={td}>{row.cashier}</td>
								<td class="{td} font-mono">{row.till}</td>
								<td class={tdMoney}>{row.amount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<section class={cardClass}>
			<h3 class={cardTitle}>Payments from customers</h3>
			{#if data.payments.length === 0}
				<p class="text-body text-ink-2 px-6 pb-4">None in this range.</p>
			{:else}
				<table class="w-full text-sm">
					<caption class="sr-only">Payments from customers</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Business date</th>
							<th scope="col" class={th}>Time</th>
							<th scope="col" class={th}>What</th>
							<th scope="col" class={th}>Customer</th>
							<th scope="col" class={th}>Method</th>
							<th scope="col" class={th}>By</th>
							<th scope="col" class={thMoney}>Amount ({data.currency?.code})</th>
						</tr>
					</thead>
					<tbody>
						{#each data.payments as row (row.key)}
							<tr>
								<td class={td}>{row.businessDate}</td>
								<td class={td}>{row.time}</td>
								<td class={td}>
									{#if row.kind === 'reversal'}
										<span aria-hidden="true" class="font-mono">↩</span> Reversal — {row.reason}
									{:else}
										<span aria-hidden="true" class="font-mono">●</span> Payment
									{/if}
								</td>
								<td class={td}>
									<a href={resolve(`/customers/${row.customerId}`)} class="underline"
										>{row.customerName}</a
									>
								</td>
								<td class={td}>{row.method}</td>
								<td class={td}>{row.cashier}</td>
								<td class={tdMoney}>{row.kind === 'reversal' ? `−${row.amount}` : row.amount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	{/if}
</PageBody>
