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
		PageHeader
	} from '$lib/components/ui';

	let { data } = $props();

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

<svelte:head><title>Sales · {data.businessDate} · matcami</title></svelte:head>

<PageHeader
	title={'Sales · ' + data.businessDate}
	description="Grouped by business date — the shift a sale was rung up in, so a 01:30 sale belongs to the evening before."
>
	{#snippet actions()}
		<div class="flex flex-wrap items-end gap-2">
			<form method="GET" action={resolve('/reports')}>
				<input type="hidden" name="date" value={data.prevDate} />
				<Button type="submit" variant="ghost">
					<Icon name="chevron-left" class="size-4" />Previous day
				</Button>
			</form>
			<form method="GET" action={resolve('/reports')} class="flex items-end gap-2">
				<Field id="date" name="date" type="date" label="Business date" value={data.businessDate} />
				<Button type="submit" variant="secondary">Show</Button>
			</form>
			<form method="GET" action={resolve('/reports')}>
				<input type="hidden" name="date" value={data.nextDate} />
				<Button type="submit" variant="ghost">
					Next day<Icon name="chevron-right" class="size-4" />
				</Button>
			</form>
		</div>
	{/snippet}
</PageHeader>

<PageBody>
	{#if data.currency === null}
		<Alert tone="info">Set the currency in Settings before reading reports.</Alert>
	{:else if data.flagged.count > 0}
		<!-- A STANDING notice: role="status" (Callout owns the glyph), never an alert. -->
		<Callout title={`${data.flagged.count} sales on this date await your review`}>
			{#snippet action()}
				<Button variant="primary" href={resolve('/reports/flagged')}>
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
						{#each data.byItem as row (row.menuItemId + row.itemName)}
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
						{#each data.byCategory as row, i (row.categoryId ?? 'none-' + i)}
							<tr>
								<td class={td}>{row.name}</td>
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
		</div>

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
</PageBody>
