<script lang="ts">
	// THE WASTE PAGE. It renders what the server sends and computes nothing: every
	// amount is the formatter's string, every quantity formatQty's.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader, SelectField, Table } from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	const ingredientOptions = $derived(
		data.ingredients.map((i) => ({ value: i.id, label: `${i.name} (${i.baseUnit})` }))
	);
	const reasonOptions = [
		{ value: 'spoilage', label: 'Spoilage' },
		{ value: 'preparation_error', label: 'Preparation error' },
		{ value: 'breakage', label: 'Breakage' },
		{ value: 'other', label: 'Other' }
	];

	const columns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'name', label: 'Ingredient' },
		{ key: 'qty', label: 'Quantity', numeric: true },
		{ key: 'reason', label: 'Reason' },
		{ key: 'cost', label: 'Cost', numeric: true }
	];
</script>

<svelte:head>
	<title>Waste · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Inventory"
	title="Waste"
	description="Goods thrown away leave the stock book at their average cost. A waste entry is never edited."
/>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<p class="text-ink-2 text-sm">
		<a class="text-ink underline" href={resolve('/inventory')}>Back to inventory</a>
	</p>

	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	<Card class="max-w-form">
		<form
			method="POST"
			action="?/record"
			class="flex flex-col gap-4"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<h3 class="text-ink font-semibold">Record waste</h3>
			<SelectField
				id="waste-ingredient"
				name="ingredientId"
				label="Ingredient"
				required
				placeholder="Choose an ingredient"
				options={ingredientOptions}
			/>
			<Field
				id="waste-qty"
				name="qty"
				label="Quantity"
				required
				inputmode="decimal"
				maxlength={20}
				hint="In the ingredient's base unit, up to three decimals."
			/>
			<SelectField
				id="waste-reason"
				name="reason"
				label="Reason"
				required
				value="spoilage"
				options={reasonOptions}
			/>
			<Field
				id="waste-note"
				name="note"
				label="Note"
				maxlength={200}
				hint="Required when the reason is Other: 3 to 200 characters."
			/>
			<Field
				id="waste-date"
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
					disabled={submitting || data.ingredients.length === 0}
					disabledReason={data.ingredients.length === 0 ? 'Add an ingredient first.' : ''}
				>
					{submitting ? 'Saving…' : 'Record waste'}
				</Button>
			</div>
		</form>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Recent waste</h3>
			<p class="text-ink-2 text-sm">The last 50 entries from the last 30 business days.</p>
			<Table
				caption="Recent waste"
				{columns}
				rows={data.entries}
				empty="No waste recorded in the last 30 business days."
			>
				{#snippet cell(row, key)}
					{#if key === 'businessDate'}
						<span class="text-ink">{row.businessDate}</span>
					{:else if key === 'name'}
						<span class="text-ink font-medium">{row.name}</span>
					{:else if key === 'qty'}
						<span class="text-ink">{row.qty}</span>
					{:else if key === 'reason'}
						<span class="text-ink">{row.reason}</span>
						{#if row.note}
							<span class="text-ink-2 block text-sm">{row.note}</span>
						{/if}
					{:else if key === 'cost'}
						<span class="text-ink">{row.cost ?? '—'}</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>
</div>
