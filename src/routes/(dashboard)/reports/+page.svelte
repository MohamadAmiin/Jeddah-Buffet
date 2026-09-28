<script lang="ts">
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';

	let { data } = $props();

	const th = 'text-eyebrow text-ink-3 py-2 text-left uppercase';
	const thMoney = 'text-eyebrow text-ink-3 py-2 text-right uppercase';
	const td = 'border-line border-t py-2';
	const tdMoney = 'border-line border-t py-2 text-right font-mono tabular-nums';
</script>

<svelte:head><title>Sales · {data.businessDate} · matcami</title></svelte:head>

<PageHeader
	title={'Sales · ' + data.businessDate}
	description="Grouped by business date — the shift a sale was rung up in, so a 01:30 sale belongs to the evening before."
>
	{#snippet actions()}
		<form method="GET" action={resolve('/reports')}>
			<input type="hidden" name="date" value={data.prevDate} />
			<Button type="submit" variant="ghost">Previous day</Button>
		</form>
		<form method="GET" action={resolve('/reports')} class="flex items-end gap-2">
			<Field id="date" name="date" type="date" label="Business date" value={data.businessDate} />
			<Button type="submit" variant="secondary">Show</Button>
		</form>
		<form method="GET" action={resolve('/reports')}>
			<input type="hidden" name="date" value={data.nextDate} />
			<Button type="submit" variant="ghost">Next day</Button>
		</form>
	{/snippet}
</PageHeader>

<div class="flex max-w-6xl flex-col gap-8 px-4 pt-8 pb-16 lg:px-7">
	{#if data.currency === null}
		<Alert tone="info">Set the currency in Settings before reading reports.</Alert>
	{:else if data.flagged.count > 0}
		<Alert tone="info">
			<span aria-hidden="true" class="text-st-offline font-mono">◆</span>
			{data.flagged.count} sales on this date await your review —
			<a href={resolve('/reports/flagged')} class="text-accent underline underline-offset-2"
				>Review them</a
			>
		</Alert>
	{/if}

	{#if data.isEmpty}
		<Card>
			<p class="text-body text-ink-2">
				<span aria-hidden="true" class="font-mono">○</span> No sales or sessions on this business date.
			</p>
		</Card>
	{:else}
		<Card>
			<h3 class="text-title">Totals</h3>
			<dl class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				<div>
					<dt class="text-eyebrow text-ink-3 uppercase">Gross sales</dt>
					<dd class="text-section font-mono tabular-nums">{data.totals.grossSales}</dd>
				</div>
				<div>
					<dt class="text-eyebrow text-ink-3 uppercase">Discounts</dt>
					<dd class="text-section font-mono tabular-nums">{data.totals.discounts}</dd>
				</div>
				<div>
					<dt class="text-eyebrow text-ink-3 uppercase">Net sales</dt>
					<dd class="text-section font-mono tabular-nums">{data.totals.netSales}</dd>
				</div>
				<div>
					<dt class="text-eyebrow text-ink-3 uppercase">Tax</dt>
					<dd class="text-section font-mono tabular-nums">{data.totals.tax}</dd>
				</div>
				<div>
					<dt class="text-eyebrow text-ink-3 uppercase">Takings</dt>
					<dd class="text-section font-mono tabular-nums">{data.totals.takings}</dd>
				</div>
				<div>
					<dt class="text-eyebrow text-ink-3 uppercase">Orders</dt>
					<dd class="text-section font-mono tabular-nums">{data.totals.orderCount}</dd>
				</div>
			</dl>
			<p class="text-caption text-ink-2 mt-3">
				Net sales = gross sales − discounts. Takings = net sales + tax: what customers paid.
			</p>
		</Card>

		<Card>
			<h3 class="text-title">By tender</h3>
			<table class="mt-4 w-full text-sm">
				<thead>
					<tr>
						<th class={th}>Method</th>
						<th class={thMoney}>Payments</th>
						<th class={thMoney}>Amount ({data.currency?.code})</th>
					</tr>
				</thead>
				<tbody>
					{#each data.byTender as row (row.method)}
						<tr>
							<td class={td}>{row.label}</td>
							<td class={tdMoney}>{row.count}</td>
							<td class={tdMoney}>{row.amount}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</Card>

		<Card>
			<h3 class="text-title">By order type</h3>
			<table class="mt-4 w-full text-sm">
				<thead>
					<tr>
						<th class={th}>Type</th>
						<th class={thMoney}>Orders</th>
						<th class={thMoney}>Amount ({data.currency?.code})</th>
					</tr>
				</thead>
				<tbody>
					{#each data.byOrderType as row (row.orderType)}
						<tr>
							<td class={td}>{row.label}</td>
							<td class={tdMoney}>{row.count}</td>
							<td class={tdMoney}>{row.amount}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</Card>

		<Card>
			<h3 class="text-title">By employee</h3>
			<table class="mt-4 w-full text-sm">
				<thead>
					<tr>
						<th class={th}>Employee</th>
						<th class={thMoney}>Orders</th>
						<th class={thMoney}>Amount ({data.currency?.code})</th>
					</tr>
				</thead>
				<tbody>
					{#each data.byEmployee as row, i (row.userId ?? 'unknown-' + i)}
						<tr>
							<td class={td}>{row.displayName}</td>
							<td class={tdMoney}>{row.count}</td>
							<td class={tdMoney}>{row.amount}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</Card>

		<Card>
			<h3 class="text-title">By item</h3>
			<table class="mt-4 w-full text-sm">
				<thead>
					<tr>
						<th class={th}>Item</th>
						<th class={thMoney}>Qty</th>
						<th class={thMoney}>{data.itemAmountLabel} ({data.currency?.code})</th>
					</tr>
				</thead>
				<tbody>
					{#each data.byItem as row (row.menuItemId + row.itemName)}
						<tr>
							<td class={td}>{row.itemName}</td>
							<td class={tdMoney}>{row.quantity}</td>
							<td class={tdMoney}>{row.amount}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="text-caption text-ink-2 mt-3">
				Per-row rounding may differ from the total by cents.
			</p>
		</Card>

		<Card>
			<h3 class="text-title">By category</h3>
			<table class="mt-4 w-full text-sm">
				<thead>
					<tr>
						<th class={th}>Category</th>
						<th class={thMoney}>Qty</th>
						<th class={thMoney}>{data.itemAmountLabel} ({data.currency?.code})</th>
					</tr>
				</thead>
				<tbody>
					{#each data.byCategory as row, i (row.categoryId ?? 'none-' + i)}
						<tr>
							<td class={td}>{row.name}</td>
							<td class={tdMoney}>{row.quantity}</td>
							<td class={tdMoney}>{row.amount}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="text-caption text-ink-2 mt-3">
				Per-row rounding may differ from the total by cents.
			</p>
		</Card>

		<Card>
			<h3 class="text-title">Sessions</h3>
			{#if data.sessions.length === 0}
				<p class="text-body text-ink-2 mt-4">No sessions opened on this business date.</p>
			{:else}
				<ul class="divide-line-soft mt-4 divide-y">
					{#each data.sessions as s (s.id)}
						{@const open = s.status === 'open'}
						<li class="py-4 first:pt-0 last:pb-0">
							<p class="text-sm">
								<span aria-hidden="true" class="font-mono {open ? 'text-ink-2' : 'text-ok'}"
									>{open ? '○' : '●'}</span
								>
								<span class="font-mono">{s.deviceCode}</span>
								<span>{open ? 'Open' : 'Closed'}</span>
								· opened {s.opened}{s.closed ? ' · closed ' + s.closed : ''}
							</p>
							<dl class="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
								<div>
									<dt class="text-eyebrow text-ink-3 uppercase">Opening</dt>
									<dd class="font-mono tabular-nums">{s.openingCash}</dd>
								</div>
								<div>
									<dt class="text-eyebrow text-ink-3 uppercase">Expected</dt>
									<dd class="font-mono tabular-nums">{s.expectedCash ?? '—'}</dd>
								</div>
								<div>
									<dt class="text-eyebrow text-ink-3 uppercase">Counted</dt>
									<dd class="font-mono tabular-nums">{s.countedCash ?? '—'}</dd>
								</div>
								<div>
									<dt class="text-eyebrow text-ink-3 uppercase">Difference</dt>
									<dd class="font-mono tabular-nums {s.difference?.negative ? 'text-danger' : ''}">
										{s.difference?.text ?? '—'}
									</dd>
								</div>
							</dl>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>
	{/if}
</div>
