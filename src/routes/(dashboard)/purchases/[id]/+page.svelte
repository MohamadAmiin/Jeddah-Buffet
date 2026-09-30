<script lang="ts">
	// ONE DELIVERY. It renders what the server sends and computes nothing: every
	// amount is the formatter's string, every quantity formatQty's. Nothing here
	// edits a posted record — a payment or the delivery is REVERSED with a reason,
	// and the original stays on the page marked ↩ reversed (colour never alone).
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader, SelectField, Table } from '$lib/components/ui';

	let { data, form } = $props();

	const NO_CURRENCY = 'Set the currency in Settings before entering amounts.';
	const HAS_PAYMENTS = 'Reverse the payments on this delivery first.';

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	const ready = $derived(data.currency !== null);
	let submitting = $state(false);

	// One in-flight guard for every form on the page (settings/+page.svelte).
	const guard = () => {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
		};
	};

	const lineColumns = [
		{ key: 'ingredientName', label: 'Ingredient' },
		{ key: 'unitName', label: 'Unit' },
		{ key: 'quantity', label: 'Quantity', numeric: true },
		{ key: 'baseQuantity', label: 'Base quantity', numeric: true },
		{ key: 'total', label: 'Line total', numeric: true }
	];
	const paymentColumns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'amount', label: 'Amount', numeric: true },
		{ key: 'paidFrom', label: 'From' },
		{ key: 'status', label: 'Status' }
	];
</script>

<svelte:head>
	<title>Delivery · matcami</title>
</svelte:head>

<PageHeader eyebrow="Deliveries" title={data.purchase.supplierName}>
	{#snippet actions()}
		<Button href={resolve('/purchases')} variant="ghost">All deliveries</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	<Card>
		<dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
			<div>
				<dt class="text-ink-2 text-xs">Supplier</dt>
				<dd class="text-ink">{data.purchase.supplierName}</dd>
			</div>
			<div>
				<dt class="text-ink-2 text-xs">Business date</dt>
				<dd class="text-ink">{data.purchase.businessDate}</dd>
			</div>
			<div>
				<dt class="text-ink-2 text-xs">Paid by</dt>
				<dd class="text-ink">{data.purchase.paidBy}</dd>
			</div>
			<div>
				<dt class="text-ink-2 text-xs">Total</dt>
				<dd class="text-ink font-mono tabular-nums">{data.purchase.total ?? '—'}</dd>
			</div>
			{#if data.purchase.outstanding !== null}
				<div>
					<dt class="text-ink-2 text-xs">Outstanding</dt>
					<dd class="text-ink font-mono tabular-nums">{data.purchase.outstanding ?? '—'}</dd>
				</div>
			{/if}
			<div>
				<dt class="text-ink-2 text-xs">Status</dt>
				<dd class="text-ink">
					{#if data.purchase.reversed}
						↩ reversed — {data.purchase.reversalReason}
					{:else}
						● recorded
					{/if}
				</dd>
			</div>
			{#if data.purchase.note}
				<div class="sm:col-span-2 lg:col-span-3">
					<dt class="text-ink-2 text-xs">Note</dt>
					<dd class="text-ink">{data.purchase.note}</dd>
				</div>
			{/if}
		</dl>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Lines</h3>
			<Table caption="Delivery lines" columns={lineColumns} rows={data.lines}>
				{#snippet cell(row, key)}
					{#if key === 'ingredientName'}
						<span class="text-ink font-medium">{row.ingredientName}</span>
					{:else if key === 'unitName'}
						<span class="text-ink">{row.unitName}</span>
					{:else if key === 'quantity'}
						<span class="text-ink">{row.quantity}</span>
					{:else if key === 'baseQuantity'}
						<span class="text-ink">{row.baseQuantity}</span>
					{:else if key === 'total'}
						<span class="text-ink">{row.total ?? '—'}</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Payments</h3>
			<Table
				caption="Supplier payments"
				columns={paymentColumns}
				rows={data.payments}
				empty="No payments on this delivery."
			>
				{#snippet cell(row, key)}
					{#if key === 'businessDate'}
						<span class="text-ink">{row.businessDate}</span>
					{:else if key === 'amount'}
						<span class={row.reversed ? 'text-ink-2 line-through' : 'text-ink'}>
							{row.amount ?? '—'}
						</span>
					{:else if key === 'paidFrom'}
						<span class="text-ink">{row.paidFrom}</span>
					{:else if key === 'status'}
						{#if row.reversed}
							<span class="text-ink text-sm">↩ reversed — {row.reversalReason}</span>
						{:else}
							<form
								method="POST"
								action="?/reversePayment"
								class="flex flex-wrap items-end gap-2"
								use:enhance={guard}
							>
								<input type="hidden" name="paymentId" value={row.id} />
								<Field
									id={`reason-${row.id}`}
									name="reason"
									label="Reason for reversing"
									required
									minlength={3}
									maxlength={200}
								/>
								<Button type="submit" variant="secondary" disabled={submitting}>
									{submitting ? 'Saving…' : 'Reverse payment'}
								</Button>
							</form>
						{/if}
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>

	{#if data.purchase.canPay}
		<Card class="max-w-form">
			<form method="POST" action="?/pay" class="flex flex-col gap-4" use:enhance={guard}>
				<h3 class="text-ink font-semibold">Pay the supplier</h3>
				<Field
					id="pay-amount"
					name="amount"
					label="Amount"
					inputmode="decimal"
					required
					disabled={!ready}
					hint={ready
						? `In ${data.currency?.code}. Still owed: ${data.purchase.outstanding}.`
						: NO_CURRENCY}
				/>
				<SelectField
					id="pay-from"
					name="paidFrom"
					label="Paid from"
					required
					options={data.paidFromOptions}
					value="bank"
				/>
				<Field
					id="pay-date"
					name="businessDate"
					label="Business date"
					type="date"
					required
					value={data.today}
				/>
				<div>
					<Button
						type="submit"
						variant="primary"
						disabled={submitting || !ready}
						disabledReason={ready ? '' : NO_CURRENCY}
					>
						{submitting ? 'Saving…' : 'Record payment'}
					</Button>
				</div>
			</form>
		</Card>
	{/if}

	{#if !data.purchase.reversed}
		<Card class="max-w-form">
			<form method="POST" action="?/reverse" class="flex flex-col gap-4" use:enhance={guard}>
				<h3 class="text-ink font-semibold">Reverse this delivery</h3>
				<p class="text-ink-2 text-sm">
					The goods leave stock at this delivery's own costs and its entry is mirrored, both dated
					today ({data.today}). Nothing is deleted: this delivery stays visible, marked reversed.
				</p>
				<Field
					id="reverse-reason"
					name="reason"
					label="Reason"
					required
					minlength={3}
					maxlength={200}
				/>
				<div>
					<Button
						type="submit"
						variant="danger"
						disabled={submitting || data.purchase.openPayments}
						disabledReason={data.purchase.openPayments ? HAS_PAYMENTS : ''}
					>
						{submitting ? 'Saving…' : 'Reverse delivery'}
					</Button>
				</div>
			</form>
		</Card>
	{/if}
</div>
