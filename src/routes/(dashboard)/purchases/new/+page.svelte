<script lang="ts">
	// RECORD A DELIVERY. It renders what the server sends and computes nothing
	// about money: a total is typed as text (inputmode="decimal", never
	// type="number", whose value the browser localises) and read by the server.
	// A refused form comes back with every value the owner typed.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader, SelectField } from '$lib/components/ui';

	let { data, form } = $props();

	const NO_CURRENCY = 'Set the currency in Settings before entering amounts.';

	let submitting = $state(false);
	let added = $state(0);

	const ready = $derived(data.currency !== null);
	const kept = $derived(form?.values ?? null);
	const keptLines = $derived(kept?.lines ?? []);
	const rowCount = $derived(
		Math.min(data.maxLines, Math.max(data.initialRows, keptLines.length) + added)
	);
	const rows = $derived(Array.from({ length: rowCount }, (_, index) => index));

	const unitOptions = $derived([{ value: '', label: 'No item on this line' }, ...data.unitOptions]);
</script>

<svelte:head>
	<title>Record a delivery · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Deliveries"
	title="Record a delivery"
	description="Enter what arrived in the units you bought it in. Stock comes in at the delivery's cost, and the average cost of each ingredient is recalculated."
>
	{#snippet actions()}
		<Button href={resolve('/purchases')} variant="ghost">All deliveries</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	{#if form?.message}
		<div class="max-w-form">
			<Alert tone="danger">{form.message}</Alert>
		</div>
	{/if}

	{#if !ready}
		<Card class="max-w-form">
			<p class="text-ink-2">
				{NO_CURRENCY}
				<a href={resolve('/settings')} class="text-ink underline">Open settings</a>
			</p>
		</Card>
	{/if}

	<Card>
		<form
			method="POST"
			action="?/create"
			class="flex flex-col gap-4"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: false });
					submitting = false;
				};
			}}
		>
			<div class="flex max-w-form flex-col gap-4">
				<Field
					id="supplier"
					name="supplierName"
					label="Supplier"
					required
					maxlength={120}
					value={kept?.supplierName ?? ''}
				/>
				<Field
					id="business-date"
					name="businessDate"
					label="Business date"
					type="date"
					required
					value={kept?.businessDate || data.today}
				/>
				<SelectField
					id="paid-by"
					name="paidBy"
					label="Paid by"
					required
					options={data.paidByOptions}
					value={kept?.paidBy || 'bank'}
					hint={data.paidByHint}
				/>
				<Field id="note" name="note" label="Note" maxlength={200} value={kept?.note ?? ''} />
			</div>

			<h3 class="text-ink font-semibold">Lines</h3>
			{#if data.unitOptions.length === 0}
				<p class="text-ink-2 text-sm">
					No ingredient has a purchase unit yet. Add one on the ingredient's page in Inventory.
				</p>
			{/if}
			{#if data.withoutUnits.length > 0}
				<p class="text-ink-2 text-sm">
					Not listed, because they have no purchase unit: {data.withoutUnits.join(', ')}.
				</p>
			{/if}
			<p class="text-ink-2 text-sm">
				A line left completely blank is ignored. Quantity is in the unit chosen, with at most three
				decimals.
			</p>

			<ol class="flex flex-col">
				{#each rows as index (index)}
					<li
						class="border-line grid gap-3 border-t py-3 first:border-t-0 md:grid-cols-3 md:items-start"
					>
						<SelectField
							id={`line-unit-${index}`}
							name="unit"
							label={`Line ${index + 1}: ingredient and unit`}
							options={unitOptions}
							value={keptLines[index]?.unit ?? ''}
						/>
						<Field
							id={`line-quantity-${index}`}
							name="quantity"
							label={`Line ${index + 1}: quantity`}
							inputmode="decimal"
							value={keptLines[index]?.quantity ?? ''}
						/>
						<Field
							id={`line-total-${index}`}
							name="total"
							label={`Line ${index + 1}: line total`}
							inputmode="decimal"
							disabled={!ready}
							hint={ready ? `In ${data.currency?.code}, for example 12.50.` : NO_CURRENCY}
							value={keptLines[index]?.total ?? ''}
						/>
					</li>
				{/each}
			</ol>

			<div class="flex flex-wrap gap-3">
				<Button
					variant="secondary"
					disabled={rowCount >= data.maxLines}
					disabledReason={`A delivery has at most ${data.maxLines} lines.`}
					onclick={() => (added += 1)}
				>
					Add a line
				</Button>
				<Button
					type="submit"
					variant="primary"
					disabled={submitting || !ready}
					disabledReason={ready ? '' : NO_CURRENCY}
				>
					{submitting ? 'Saving…' : 'Record delivery'}
				</Button>
			</div>
		</form>
	</Card>
</div>
