<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		Alert,
		Button,
		Callout,
		Card,
		Field,
		Icon,
		PageBody,
		PageHeader,
		Table
	} from '$lib/components/ui';

	let { data } = $props();

	// tasks/sales-report-export T-11: a RANGE of business dates, four new cards,
	// the downloads and a print layout. Links carry their query precomputed,
	// beside resolve() (svelte/no-navigation-without-resolve).
	function reportsHref(query: string): string {
		return resolve('/reports') + '?' + query;
	}
	function exportHref(query: string): string {
		return resolve('/reports/export') + '?' + query;
	}
	const PRESET =
		'flex items-center border-b-2 border-transparent pb-3 text-sm font-medium text-ink-2 hover:text-ink data-current:border-accent data-current:text-ink';

	const dayColumns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'orderCount', label: 'Orders', numeric: true },
		{ key: 'netSales', label: 'Net sales', numeric: true },
		{ key: 'tax', label: 'Tax', numeric: true },
		{ key: 'takings', label: 'Takings', numeric: true },
		{ key: 'costOfSales', label: 'Cost of sales', numeric: true },
		{ key: 'grossProfit', label: 'Gross profit', numeric: true }
	];
	const orderColumns = [
		{ key: 'invoiceNumber', label: 'Invoice' },
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'paidAt', label: 'Paid' },
		{ key: 'orderType', label: 'Type' },
		{ key: 'tableLabel', label: 'Table' },
		{ key: 'employeeName', label: 'Employee' },
		{ key: 'payment', label: 'Payment' },
		{ key: 'total', label: 'Total', numeric: true },
		{ key: 'flag', label: 'Flag' }
	];
	// The gross-profit tiles sit on bg-raise with an edge, not bg-raise-2: a
	// negative figure is text-danger, which is illegal on bg-raise-2 (CLAUDE.md).
	const profitTile = 'rounded-control border-line bg-raise flex flex-col gap-2 border px-4 py-3';
	const profitLabel = 'text-eyebrow text-ink-3 uppercase';

	// The breakdown tables are drawn with the Table primitive's classes (header row
	// bg-raise-2, px-6 cells, numeric columns mono and right-aligned) rather than
	// with <Table> itself: the primitive's stacked-phone layout puts each column's
	// label inside every cell, and e2e reads a row's text end to end
	// (/2\s*16\.00/ in pos-sale.spec.ts, /Delivery\s*1\s*8\.80/ in
	// menu-delivery.spec.ts), which those hidden labels would split.
	const th = 'text-ink-2 px-6 py-3 text-start text-xs font-medium';
	const thMoney = 'text-ink-2 px-6 py-3 text-end text-xs font-medium';
	const td = 'border-line-soft border-t px-6 py-2.5';
	const tdMoney = 'border-line-soft border-t px-6 py-2.5 text-end font-mono tabular-nums';
	const cardClass = 'rounded-card border-line bg-raise shadow-card flex flex-col border';
	const cardTitle = 'text-section px-6 pt-4 pb-3';
	const tile = 'rounded-control bg-raise-2 flex flex-col gap-2 px-4 py-3';
	// text-ink-2, not text-ink-3: these tiles sit on bg-raise-2, where ink-3 is illegal.
	const tileLabel = 'text-eyebrow text-ink-2 uppercase';
	const tileValue = 'text-section text-end font-mono font-medium tabular-nums';
</script>

<svelte:head><title>{data.title} · matcami</title></svelte:head>

<PageHeader
	title={data.title}
	description="Grouped by business date — the shift a sale was rung up in, so a 01:30 sale belongs to the evening before."
>
	{#snippet actions()}
		<div class="flex flex-wrap items-end gap-2 print:hidden">
			{#if data.singleDay}
				<form method="GET" action={resolve('/reports')}>
					<input type="hidden" name="date" value={data.prevDate} />
					<Button type="submit" variant="ghost">
						<Icon name="chevron-left" class="size-4" />Previous day
					</Button>
				</form>
			{/if}
			<form method="GET" action={resolve('/reports')} class="flex flex-wrap items-end gap-2">
				<Field id="from" name="from" type="date" label="From" value={data.from} />
				<Field id="to" name="to" type="date" label="To" value={data.to} />
				<Button type="submit" variant="secondary">Show</Button>
			</form>
			{#if data.singleDay}
				<form method="GET" action={resolve('/reports')}>
					<input type="hidden" name="date" value={data.nextDate} />
					<Button type="submit" variant="ghost">
						Next day<Icon name="chevron-right" class="size-4" />
					</Button>
				</form>
			{/if}
		</div>
	{/snippet}
	{#snippet below()}
		<nav aria-label="Date range" class="flex flex-wrap gap-6 print:hidden">
			<!-- eslint-disable svelte/no-navigation-without-resolve -- reportsHref returns a resolve() result; the rule cannot follow it into a snippet -->
			{#each data.presets as p (p.label)}
				<a
					href={reportsHref(p.query)}
					class={PRESET}
					data-current={p.current ? '' : undefined}
					aria-current={p.current ? 'page' : undefined}>{p.label}</a
				>
			{/each}
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</nav>
	{/snippet}
</PageHeader>

<PageBody>
	{#if data.currency === null}
		<Alert tone="info">Set the currency in Settings before reading reports.</Alert>
	{:else if data.flagged.count > 0}
		<!-- A STANDING notice: role="status" (Callout owns the glyph), never an alert. -->
		<Callout
			title={`${data.flagged.count} sales ${data.singleDay ? 'on this date' : 'in this range'} await your review`}
		>
			{#snippet action()}
				<Button variant="primary" href={resolve('/reports/flagged')} class="print:hidden">
					<Icon name="arrow-right" class="size-4" />Review them
				</Button>
			{/snippet}
		</Callout>
	{/if}

	{#if data.isEmpty}
		<Card>
			<p class="text-body text-ink-2">
				<span aria-hidden="true" class="font-mono">○</span> No sales or shifts on this business date.
			</p>
		</Card>
	{:else}
		<section
			aria-labelledby="totals-h"
			class="rounded-card border-line bg-raise shadow-card border p-6"
		>
			<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h3 id="totals-h" class="text-section">Totals</h3>
				<p class="text-caption text-ink-2">
					Net sales = gross sales − discounts. Takings = net sales + tax: what customers paid.
				</p>
			</div>
			{#if data.openShifts > 0}
				<p class="text-body text-ink-2 mt-2">
					<span aria-hidden="true" class="font-mono">○</span>
					{data.openShifts === 1 ? '1 shift is' : `${data.openShifts} shifts are`} still open: these figures
					can change until {data.openShifts === 1 ? 'it closes' : 'they close'}.
				</p>
			{/if}
			<dl class="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
				<div class={tile}>
					<dt class={tileLabel}>Gross sales</dt>
					<dd class={tileValue}>{data.totals.grossSales}</dd>
				</div>
				<div class={tile}>
					<dt class={tileLabel}>Discounts</dt>
					<dd class={tileValue}>{data.totals.discounts}</dd>
				</div>
				<div class={tile}>
					<dt class={tileLabel}>Net sales</dt>
					<dd class={tileValue}>{data.totals.netSales}</dd>
				</div>
				<div class={tile}>
					<dt class={tileLabel}>Tax</dt>
					<dd class={tileValue}>{data.totals.tax}</dd>
				</div>
				<div class={tile}>
					<dt class={tileLabel}>Takings</dt>
					<dd class={tileValue}>{data.totals.takings}</dd>
				</div>
				<div class={tile}>
					<dt class={tileLabel}>Orders</dt>
					<dd class={tileValue}>{data.totals.orderCount}</dd>
				</div>
			</dl>
		</section>

		<section
			aria-labelledby="profit-h"
			class="rounded-card border-line bg-raise shadow-card border p-6"
		>
			<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h3 id="profit-h" class="text-section">Gross profit</h3>
				<p class="text-caption text-ink-2">
					Gross profit = net sales − cost of sales (accounts 5000, 5100 and 5200).
				</p>
			</div>
			<!-- No tile here may repeat a Totals label: e2e reads those by exact dt text. -->
			<dl class="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
				{#each [['Cost of goods sold', data.profit.cogs], ['Waste & adjustments', data.profit.waste], ['Comps & staff meals', data.profit.comps], ['Cost of sales', data.profit.costOfSales], ['Gross profit', data.profit.grossProfit]] as const as [label, figure] (label)}
					<div class={profitTile}>
						<dt class={profitLabel}>{label}</dt>
						<dd
							class="text-section text-end font-mono font-medium tabular-nums {figure.negative
								? 'text-danger'
								: ''}"
						>
							{figure.text}
						</dd>
					</div>
				{/each}
			</dl>
		</section>

		{#if !data.singleDay}
			<section class={cardClass}>
				<h3 class={cardTitle}>By business date</h3>
				<Table caption="By business date" columns={dayColumns} rows={data.days}>
					{#snippet cell(row, key)}
						{#if key === 'costOfSales' || key === 'grossProfit'}
							{@const figure = key === 'costOfSales' ? row.costOfSales : row.grossProfit}
							<span class={figure.negative ? 'text-danger' : ''}>{figure.text}</span>
						{:else}
							{row[key as 'businessDate' | 'orderCount' | 'netSales' | 'tax' | 'takings']}
						{/if}
					{/snippet}
				</Table>
			</section>
		{/if}

		<!-- Each card's heading and its table share ONE parent (the section): e2e
		     finds a card as the innermost section/div holding its heading, then reads
		     the table's rows inside it. Do not wrap a heading in its own div. -->
		<div class="grid items-start gap-6 xl:grid-cols-2">
			<section class={cardClass}>
				<h3 class={cardTitle}>By tender</h3>
				<table class="w-full text-sm">
					<caption class="sr-only">By tender</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Method</th>
							<th scope="col" class={thMoney}>Payments</th>
							<th scope="col" class={thMoney}>Amount ({data.currency?.code})</th>
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
			</section>

			<section class={cardClass}>
				<h3 class={cardTitle}>By payment method</h3>
				<table class="w-full text-sm">
					<caption class="sr-only">By payment method</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Method</th>
							<th scope="col" class={th}>Type</th>
							<th scope="col" class={thMoney}>Payments</th>
							<th scope="col" class={thMoney}>Amount ({data.currency?.code})</th>
						</tr>
					</thead>
					<tbody>
						{#each data.byPaymentMethod as row (row.key)}
							<tr>
								<td class={td}>{row.label}</td>
								<td class={td}>{row.kind}</td>
								<td class={tdMoney}>{row.count}</td>
								<td class={tdMoney}>{row.amount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>

			<section class={cardClass}>
				<h3 class={cardTitle}>By order type</h3>
				<table class="w-full text-sm">
					<caption class="sr-only">By order type</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Type</th>
							<th scope="col" class={thMoney}>Orders</th>
							<th scope="col" class={thMoney}>Amount ({data.currency?.code})</th>
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
			</section>

			<section class={cardClass}>
				<h3 class={cardTitle}>By item</h3>
				<table class="w-full text-sm">
					<caption class="sr-only">By item</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Item</th>
							<th scope="col" class={thMoney}>Qty</th>
							<th scope="col" class={thMoney}>{data.itemAmountLabel} ({data.currency?.code})</th>
						</tr>
					</thead>
					<tbody>
						{#each data.byItem as row (row.key)}
							<tr>
								<td class={td}>{row.itemName}</td>
								<td class={tdMoney}>{row.quantity}</td>
								<td class={tdMoney}>{row.amount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="text-caption text-ink-2 border-line-soft border-t px-6 py-3">
					Per-row rounding may differ from the total by cents.
				</p>
			</section>

			<section class={cardClass}>
				<h3 class={cardTitle}>By category</h3>
				<table class="w-full text-sm">
					<caption class="sr-only">By category</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Category</th>
							<th scope="col" class={thMoney}>Qty</th>
							<th scope="col" class={thMoney}>{data.itemAmountLabel} ({data.currency?.code})</th>
						</tr>
					</thead>
					<tbody>
						{#each data.byCategory as row (row.key)}
							<tr>
								<td class={td}>{row.name}</td>
								<td class={tdMoney}>{row.quantity}</td>
								<td class={tdMoney}>{row.amount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="text-caption text-ink-2 border-line-soft border-t px-6 py-3">
					Grouped by each item's current category. Per-row rounding may differ from the total by
					cents.
				</p>
			</section>

			<section class={cardClass}>
				<h3 class={cardTitle}>By employee</h3>
				<table class="w-full text-sm">
					<caption class="sr-only">By employee</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Employee</th>
							<th scope="col" class={thMoney}>Orders</th>
							<th scope="col" class={thMoney}>Amount ({data.currency?.code})</th>
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
			</section>

			<section class={cardClass}>
				<h3 class={cardTitle}>By tax rate</h3>
				<table class="w-full text-sm">
					<caption class="sr-only">By tax rate</caption>
					<thead class="bg-raise-2">
						<tr>
							<th scope="col" class={th}>Tax rate</th>
							<th scope="col" class={thMoney}>Rate</th>
							<th scope="col" class={th}>Basis</th>
							<th scope="col" class={thMoney}>Qty</th>
							<th scope="col" class={thMoney}>Amount ({data.currency?.code})</th>
						</tr>
					</thead>
					<tbody>
						{#each data.taxRates as row (row.key)}
							<tr>
								<td class={td}>{row.name}</td>
								<td class={tdMoney}>{row.rate}</td>
								<td class={td}>{row.basis}</td>
								<td class={tdMoney}>{row.quantity}</td>
								<td class={tdMoney}>{row.amount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="text-caption text-ink-2 border-line-soft border-t px-6 py-3">
					Tax is stored per sale, not per rate: the Tax total above is the figure to report.
				</p>
			</section>
		</div>

		<section class={cardClass}>
			<h3 class={cardTitle}>Orders</h3>
			<Table caption="Orders" columns={orderColumns} rows={data.orders} empty="No orders">
				{#snippet cell(row, key)}
					{#if key === 'flag'}
						{#if row.flag}<span aria-hidden="true" class="font-mono">▲</span>
							{row.flag}{:else}—{/if}
					{:else}
						{row[
							key as
								| 'invoiceNumber'
								| 'businessDate'
								| 'paidAt'
								| 'orderType'
								| 'tableLabel'
								| 'employeeName'
								| 'payment'
								| 'total'
						]}
					{/if}
				{/snippet}
			</Table>
			<p class="text-caption text-ink-2 border-line-soft border-t px-6 py-3">
				Showing {data.shownOrders} of {data.orderCount} orders, newest first.{data.shownOrders <
				data.orderCount
					? ' Download Orders for all of them.'
					: ''}
			</p>
		</section>

		<!-- Sessions last. A Card (a <div>) with the heading as a direct child: e2e
		     finds this card as the innermost <div> holding the "Shifts" heading and
		     counts its list items. -->
		<Card>
			<h3 class="text-section">Shifts</h3>
			{#if data.sessions.length === 0}
				<p class="text-body text-ink-2 mt-3">No shifts opened on this business date.</p>
			{:else}
				<ul class="divide-line-soft mt-3 divide-y">
					{#each data.sessions as s (s.id)}
						{@const open = s.status === 'open'}
						<li class="flex flex-col gap-3 py-4 last:pb-0">
							<p class="text-sm">
								<span aria-hidden="true" class="font-mono {open ? 'text-ink-2' : 'text-ok'}"
									>{open ? '○' : '●'}</span
								>
								<span class="font-mono">{s.deviceCode}</span>
								<span>{open ? 'Open' : 'Closed'}</span>
								{#if !data.singleDay}· {s.businessDate}{/if}
								· opened {s.opened}{s.closed ? ' · closed ' + s.closed : ''}
							</p>
							<dl class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
								<div class={tile}>
									<dt class={tileLabel}>Opening</dt>
									<dd class="text-end font-mono tabular-nums">{s.openingCash}</dd>
								</div>
								<div class={tile}>
									<dt class={tileLabel}>Expected</dt>
									<dd class="text-end font-mono tabular-nums">{s.expectedCash ?? '—'}</dd>
								</div>
								<div class={tile}>
									<dt class={tileLabel}>Counted</dt>
									<dd class="text-end font-mono tabular-nums">{s.countedCash ?? '—'}</dd>
								</div>
								<!-- Difference sits on bg-raise with an edge, not bg-raise-2:
								     text-danger is illegal on bg-raise-2 (4.18:1). -->
								<div
									class="rounded-control border-line bg-raise flex flex-col gap-2 border px-4 py-3"
								>
									<dt class="text-eyebrow text-ink-3 uppercase">Difference</dt>
									<dd
										class="text-end font-mono tabular-nums {s.difference?.negative
											? 'text-danger'
											: ''}"
									>
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

	{#if data.currency !== null}
		<Card class="print:hidden">
			<h3 class="text-section">Download</h3>
			<p class="text-body text-ink-2 mt-2">
				CSV files for {data.singleDay ? data.from : `${data.from} to ${data.to}`}. They open in
				Excel, Numbers and Google Sheets; to keep table labels exactly as typed, open a file with
				the spreadsheet's import from text. To save this page as a PDF, use Print.
			</p>
			<div class="mt-4 flex flex-wrap gap-2">
				{#each data.exports as e (e.section)}
					<Button href={exportHref(e.query)} download>{e.label}</Button>
				{/each}
				<Button variant="ghost" onclick={() => window.print()}>Print or save as PDF</Button>
			</div>
		</Card>
	{/if}
</PageBody>
