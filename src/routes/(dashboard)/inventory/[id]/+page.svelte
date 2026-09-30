<script lang="ts">
	// ONE INGREDIENT. It renders what the server sends and computes nothing: every
	// amount is the formatter's string, every quantity formatQty's. Colour never
	// carries meaning alone — below-zero stock shows ◆ and the words, each movement
	// type its glyph and its name, a negative amount its leading − as well as the
	// danger ink.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Alert, Button, Card, Field, PageHeader, SelectField, Table } from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	// The in-flight guard of /settings, shared by every form on the page: one
	// submission at a time, the button disabled and saying so.
	const guard: SubmitFunction = () => {
		submitting = true;
		return async ({ update }) => {
			await update();
			submitting = false;
		};
	};

	const NO_CURRENCY = 'Set the currency in Settings before entering amounts.';
	const BASE_UNIT_LOCKED = 'The base unit cannot change once stock has moved.';
	const ready = $derived(data.currency !== null);
	const unitOptions = $derived(data.units.map((u) => ({ value: u.id, label: u.name })));

	const unitColumns = [
		{ key: 'name', label: 'Unit' },
		{ key: 'holds', label: 'Holds', numeric: true },
		{ key: 'actions', label: 'Actions' }
	];
	const movementColumns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'type', label: 'Movement' },
		{ key: 'qty', label: 'Quantity', numeric: true },
		{ key: 'cost', label: 'Cost', numeric: true },
		{ key: 'source', label: 'Source' }
	];
</script>

<svelte:head>
	<title>{data.ingredient.name} · Inventory · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Inventory"
	title={data.ingredient.name}
	description={`Base unit ${data.ingredient.baseUnit}. What moved, from the stock book; nothing is typed over.`}
>
	{#snippet actions()}
		<Button href={resolve('/inventory')} variant="secondary">All ingredients</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	<Card class="max-w-form">
		<dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
			<dt class="text-ink-2">Status</dt>
			<dd class="text-ink">{data.ingredient.archived ? '✕ Archived' : '○ In use'}</dd>
			<dt class="text-ink-2">On hand</dt>
			<dd class="text-right font-mono tabular-nums">
				<span class={data.negative ? 'text-danger' : 'text-ink'}>{data.onHand}</span>
				{#if data.negative}
					<span class="text-danger font-sans">◆ below zero</span>
				{/if}
			</dd>
			<dt class="text-ink-2">Value</dt>
			<dd
				class={`text-right font-mono tabular-nums ${data.valueNegative ? 'text-danger' : 'text-ink'}`}
			>
				{data.value ?? '—'}
			</dd>
			{#if data.average}
				<dt class="text-ink-2">Average cost</dt>
				<dd class="text-ink text-right font-mono tabular-nums">
					{data.average.amount ?? '—'} / {data.average.unitName}
				</dd>
			{/if}
		</dl>
	</Card>

	{#if !data.ingredient.archived}
		<Card class="max-w-form">
			<form method="POST" action="?/update" class="flex flex-col gap-4" use:enhance={guard}>
				<h3 class="text-ink font-semibold">Details</h3>
				<Field
					id="ingredient-name"
					name="name"
					label="Name"
					required
					maxlength={80}
					value={data.ingredient.name}
				/>
				<Field
					id="ingredient-unit"
					name="baseUnit"
					label="Base unit"
					required
					maxlength={16}
					value={data.ingredient.baseUnit}
					disabled={data.hasMovements}
					hint={data.hasMovements
						? BASE_UNIT_LOCKED
						: 'The unit recipes use, for example g, ml or pcs.'}
				/>
				<div>
					<Button type="submit" variant="primary" disabled={submitting}>
						{submitting ? 'Saving…' : 'Save details'}
					</Button>
				</div>
			</form>
		</Card>
	{/if}

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Purchase units</h3>
			<p class="text-ink-2 text-sm">
				The units deliveries arrive in, each converted to {data.ingredient.baseUnit}.
			</p>
			<Table
				caption="Purchase units"
				columns={unitColumns}
				rows={data.units}
				empty="No purchase units yet."
			>
				{#snippet cell(row, key)}
					{#if key === 'name'}
						<span class="text-ink font-medium">{row.name}</span>
					{:else if key === 'holds'}
						<span class="text-ink">{row.holds}</span>
					{:else if key === 'actions'}
						<form method="POST" action="?/archiveUnit" use:enhance={guard}>
							<input type="hidden" name="unitId" value={row.id} />
							<Button type="submit" variant="ghost" disabled={submitting}>
								{submitting ? 'Saving…' : 'Archive unit'}
							</Button>
						</form>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>

	{#if !data.ingredient.archived}
		<Card class="max-w-form">
			<form method="POST" action="?/addUnit" class="flex flex-col gap-4" use:enhance={guard}>
				<h3 class="text-ink font-semibold">Add purchase unit</h3>
				<Field
					id="unit-name"
					name="name"
					label="Unit name"
					required
					maxlength={24}
					hint="For example bag, case or bottle."
				/>
				<Field
					id="unit-holds"
					name="baseQtyPerUnit"
					label={`${data.ingredient.baseUnit} per unit`}
					required
					inputmode="decimal"
					hint={`How many ${data.ingredient.baseUnit} one unit holds, for example 25000 for a 25 kg bag in g.`}
				/>
				<div>
					<Button type="submit" variant="secondary" disabled={submitting}>
						{submitting ? 'Saving…' : 'Add unit'}
					</Button>
				</div>
			</form>
		</Card>
	{/if}

	{#if data.openingAllowed}
		<Card class="max-w-form">
			<form method="POST" action="?/openingStock" class="flex flex-col gap-4" use:enhance={guard}>
				<h3 class="text-ink font-semibold">Opening stock</h3>
				<p class="text-ink-2 text-sm">
					Stock already on the shelf. Recorded as money the owner put into the business.
				</p>
				<SelectField
					id="opening-unit"
					name="purchaseUnitId"
					label="Purchase unit"
					required
					placeholder="Choose a unit"
					options={unitOptions}
					disabled={unitOptions.length === 0}
					disabledReason="Add a purchase unit first."
				/>
				<Field id="opening-qty" name="qty" label="Quantity" required inputmode="decimal" />
				<Field
					id="opening-cost"
					name="cost"
					label="Cost per unit"
					required
					inputmode="decimal"
					disabled={!ready}
					hint={ready ? `In ${data.currency?.code}, for example 12.50.` : NO_CURRENCY}
				/>
				<Field
					id="opening-date"
					name="businessDate"
					label="Business date"
					type="date"
					required
					value={data.today}
				/>
				<div>
					<Button
						type="submit"
						variant="secondary"
						disabled={submitting || !ready || unitOptions.length === 0}
						disabledReason={ready ? 'Add a purchase unit first.' : NO_CURRENCY}
					>
						{submitting ? 'Saving…' : 'Record opening stock'}
					</Button>
				</div>
			</form>
		</Card>
	{/if}

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Movements</h3>
			<Table
				caption="Stock movements, newest first"
				columns={movementColumns}
				rows={data.movements}
				empty="Nothing has moved yet."
			>
				{#snippet cell(row, key)}
					{#if key === 'businessDate'}
						<span class="text-ink">{row.businessDate}</span>
					{:else if key === 'type'}
						<span class="text-ink"><span aria-hidden="true">{row.glyph}</span> {row.type}</span>
					{:else if key === 'qty'}
						<span class={row.qtyNegative ? 'text-danger' : 'text-ink'}>{row.qty}</span>
					{:else if key === 'cost'}
						<span class={row.costNegative ? 'text-danger' : 'text-ink'}>{row.cost ?? '—'}</span>
					{:else if key === 'source'}
						{#if row.sourceType === 'purchase'}
							<a class="text-ink underline" href={resolve(`/purchases/${row.sourceId}`)}>
								{row.source}
							</a>
						{:else}
							<span class="text-ink-2">{row.source}</span>
						{/if}
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>

	{#if !data.ingredient.archived}
		<Card class="max-w-form">
			<form method="POST" action="?/archive" class="flex flex-col gap-4" use:enhance={guard}>
				<h3 class="text-ink font-semibold">Archive</h3>
				<p class="text-ink-2 text-sm">
					An archived ingredient leaves the lists; its movements stay in the stock book. It cannot
					be archived while a recipe uses it.
				</p>
				<div>
					<Button type="submit" variant="danger" disabled={submitting}>
						{submitting ? 'Saving…' : 'Archive ingredient'}
					</Button>
				</div>
			</form>
		</Card>
	{/if}
</div>
