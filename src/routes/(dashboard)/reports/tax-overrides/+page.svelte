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
</script>

<svelte:head><title>Tax-exempt bills · {range} · matcami</title></svelte:head>

<PageHeader
	title="Tax-exempt bills"
	description="Every bill a cashier made tax-exempt, with the reason they typed and the tax the customer did not pay. Grouped by business date."
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
	{#if data.rows.length === 0}
		<Card>
			<p class="text-body text-ink-2">
				<span aria-hidden="true" class="font-mono">○</span> No tax-exempt bills in this range.
			</p>
		</Card>
	{:else}
		<section class={cardClass}>
			<h3 class={cardTitle}>By cashier</h3>
			<table class="w-full text-sm">
				<caption class="sr-only">Tax-exempt bills by cashier</caption>
				<thead class="bg-raise-2">
					<tr>
						<th scope="col" class={th}>Cashier</th>
						<th scope="col" class={thMoney}>Bills</th>
						<th scope="col" class={thMoney}>Tax removed ({data.currency?.code})</th>
					</tr>
				</thead>
				<tbody>
					{#each data.byCashier as row (row.userId)}
						<tr>
							<td class={td}>{row.cashier}</td>
							<td class={tdMoney}>{row.count}</td>
							<td class={tdMoney}>{row.taxRemoved}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section class={cardClass}>
			<h3 class={cardTitle}>Bills · {range}</h3>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<caption class="sr-only">Tax-exempt bills</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Invoice</th>
							<th scope="col" class={th}>Business date</th>
							<th scope="col" class={th}>Time</th>
							<th scope="col" class={th}>Cashier</th>
							<th scope="col" class={th}>Rate</th>
							<th scope="col" class={th}>Who is exempt and why</th>
							<th scope="col" class={thMoney}>Total ({data.currency?.code})</th>
							<th scope="col" class={thMoney}>Tax removed</th>
						</tr>
					</thead>
					<tbody>
						{#each data.rows as row (row.orderId)}
							<tr>
								<td class="{td} font-mono">{row.invoiceNumber}</td>
								<td class={td}>{row.businessDate}</td>
								<td class={td}>{row.time}</td>
								<td class={td}>{row.cashier}</td>
								<td class={td}>{row.rateName}</td>
								<td class={td}>{row.reason}</td>
								<td class={tdMoney}>{row.total}</td>
								<td class={tdMoney}>{row.taxRemoved}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</PageBody>
