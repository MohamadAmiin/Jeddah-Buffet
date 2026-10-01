<script lang="ts">
	// RECORD A DELIVERY. It renders what the server sends and computes nothing
	// about money: a total is typed as text (inputmode="decimal", never
	// type="number", whose value the browser localises) and read by the server.
	// A refused form comes back with every value the owner typed.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import {
		ActionBar,
		Alert,
		Button,
		Card,
		Field,
		PageBody,
		PageHeader,
		SelectField
	} from '$lib/components/ui';

	let { data, form } = $props();

	const FORM_ID = 'delivery-form';
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
	crumbs={[{ label: 'Deliveries', href: resolve('/purchases') }]}
	title="Record a delivery"
	description="Enter what arrived in the units you bought it in. Stock comes in at the delivery's cost, and the average cost of each ingredient is recalculated."
/>

<PageBody>
	{#if !ready}
		<Card class="max-w-form">
			<p class="text-ink-2">
				{NO_CURRENCY}
				<a href={resolve('/settings')} class="text-ink underline">Open settings</a>
			</p>
		</Card>
	{/if}

	<form
		id={FORM_ID}
		method="POST"
		action="?/create"
		class="flex flex-col gap-6"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		}}
	>
		<Card>
			<div class="flex flex-col gap-4">
				<h3 class="text-section text-ink">Delivery</h3>
				<div class="grid gap-4 md:grid-cols-2 md:items-start">
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
			</div>
		</Card>

		<Card>
			<div class="flex flex-col gap-4">
				<h3 class="text-section text-ink">Lines</h3>
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
					A line left completely blank is ignored. Quantity is in the unit chosen, with at most
					three decimals.
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
								numeric
								value={keptLines[index]?.quantity ?? ''}
							/>
							<Field
								id={`line-total-${index}`}
								name="total"
								label={`Line ${index + 1}: line total`}
								inputmode="decimal"
								numeric
								disabled={!ready}
								hint={ready ? `In ${data.currency?.code}, for example 12.50.` : NO_CURRENCY}
								value={keptLines[index]?.total ?? ''}
							/>
						</li>
					{/each}
				</ol>
			</div>
		</Card>
	</form>
</PageBody>

{#snippet outcome()}
	<Alert tone="danger">{form?.message}</Alert>
{/snippet}

<ActionBar
	caption={`${rowCount} ${rowCount === 1 ? 'line' : 'lines'} · blank lines are ignored`}
	message={form?.message ? outcome : undefined}
>
	<Button
		disabled={rowCount >= data.maxLines}
		disabledReason={`A delivery has at most ${data.maxLines} lines.`}
		onclick={() => (added += 1)}
	>
		Add a line
	</Button>
	<Button
		type="submit"
		form={FORM_ID}
		variant="primary"
		disabled={submitting || !ready}
		disabledReason={ready ? '' : NO_CURRENCY}
	>
		{submitting ? 'Saving…' : 'Record delivery'}
	</Button>
</ActionBar>
