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
	import {
		Alert,
		Button,
		Card,
		Field,
		PageBody,
		PageColumns,
		PageHeader,
		SelectField,
		Table
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	// Which card's form was submitted last, so its result shows in THAT card, above
	// its fields. Without JavaScript nothing records it: the result then shows in
	// the Details card (the Purchase units card once the ingredient is archived).
	type FormKey = 'details' | 'units' | 'opening' | 'archive';
	let lastForm = $state<FormKey | null>(null);
	const outcomeAt = $derived<FormKey | null>(
		form?.message ? (lastForm ?? (data.ingredient.archived ? 'units' : 'details')) : null
	);

	// The in-flight guard of /settings, shared by every form on the page: one
	// submission at a time, the button disabled and saying so.
	const guard =
		(key: FormKey): SubmitFunction =>
		() => {
			lastForm = key;
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

	const TABLE_CARD = 'rounded-card border-line bg-raise shadow-card overflow-hidden border';

	// The inventory section row — the same on every inventory page.
	const SECTION =
		'flex items-center border-b-2 border-transparent pb-3 text-sm font-medium text-ink-2 hover:text-ink data-current:border-accent data-current:text-ink';
	const sections = [
		{ label: 'Recipes', href: resolve('/inventory/recipes') },
		{ label: 'Deliveries', href: resolve('/purchases') },
		{ label: 'Waste', href: resolve('/inventory/waste') },
		{ label: 'Counts', href: resolve('/inventory/counts') },
		{ label: 'Reports', href: resolve('/inventory/reports') }
	];
</script>

<svelte:head>
	<title>{data.ingredient.name} · Inventory · matcami</title>
</svelte:head>

<PageHeader
	crumbs={[{ label: 'Inventory', href: resolve('/inventory') }]}
	title={data.ingredient.name}
	description={`Base unit ${data.ingredient.baseUnit}. What moved, from the stock book; nothing is typed over.`}
>
	{#snippet below()}
		<nav aria-label="Inventory sections" class="-mb-4 flex flex-wrap gap-x-6 gap-y-1 lg:-mb-5">
			{#each sections as link (link.href)}
				{@const here = page.url.pathname === link.href}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- every href above is a resolve() result -->
				<a
					href={link.href}
					class={SECTION}
					aria-current={here ? 'page' : undefined}
					data-current={here || page.url.pathname.startsWith(`${link.href}/`) ? '' : undefined}
					>{link.label}</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}
		</nav>
	{/snippet}
</PageHeader>

<PageBody>
	<PageColumns>
		<Card>
			<div class="flex flex-col gap-3">
				<h3 class="text-section">Stock</h3>
				<dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
					<dt class="text-ink-2">Status</dt>
					<dd class="text-ink">
						{#if data.ingredient.archived}
							<span aria-hidden="true" class="font-mono">✕</span> Archived
						{:else}
							<span aria-hidden="true" class="font-mono">○</span> In use
						{/if}
					</dd>
					<dt class="text-ink-2">On hand</dt>
					<dd class="text-right font-mono tabular-nums">
						<span class={data.negative ? 'text-danger' : 'text-ink'}>{data.onHand}</span>
						{#if data.negative}
							<span class="text-danger font-sans"
								><span aria-hidden="true" class="font-mono">◆</span> below zero</span
							>
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
			</div>
		</Card>

		<section aria-labelledby="units-h" class={TABLE_CARD}>
			<div class="flex flex-col gap-1 px-6 py-4">
				<h3 id="units-h" class="text-section">Purchase units</h3>
				<p class="text-caption text-ink-2">
					The units deliveries arrive in, each converted to {data.ingredient.baseUnit}.
				</p>
			</div>
			<div class="px-6 md:px-0">
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
							<form method="POST" action="?/archiveUnit" use:enhance={guard('units')}>
								<input type="hidden" name="unitId" value={row.id} />
								<Button type="submit" variant="ghost" disabled={submitting}>
									{submitting ? 'Saving…' : 'Archive unit'}
								</Button>
							</form>
						{/if}
					{/snippet}
				</Table>
			</div>
			{#if !data.ingredient.archived || outcomeAt === 'units'}
				<div class="border-line-soft border-t p-6">
					{#if outcomeAt === 'units'}
						<div class="mb-4">
							<Alert {tone}>{form?.message}</Alert>
						</div>
					{/if}
					{#if !data.ingredient.archived}
						<form
							method="POST"
							action="?/addUnit"
							class="flex flex-col gap-4"
							use:enhance={guard('units')}
						>
							<h4 class="text-ink font-semibold">Add purchase unit</h4>
							<div class="grid gap-4 md:grid-cols-2">
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
									numeric
									inputmode="decimal"
									hint={`How many ${data.ingredient.baseUnit} one unit holds, for example 25000 for a 25 kg bag in g.`}
								/>
							</div>
							<div>
								<Button type="submit" variant="secondary" disabled={submitting}>
									{submitting ? 'Saving…' : 'Add unit'}
								</Button>
							</div>
						</form>
					{/if}
				</div>
			{/if}
		</section>

		<section aria-labelledby="movements-h" class={TABLE_CARD}>
			<div class="px-6 py-4">
				<h3 id="movements-h" class="text-section">Movements</h3>
			</div>
			<div class="px-6 md:px-0">
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
		</section>

		{#snippet aside()}
			{#if !data.ingredient.archived}
				<Card>
					<form
						method="POST"
						action="?/update"
						class="flex flex-col gap-4"
						use:enhance={guard('details')}
					>
						<h3 class="text-section">Details</h3>
						{#if outcomeAt === 'details'}
							<Alert {tone}>{form?.message}</Alert>
						{/if}
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

			{#if data.openingAllowed}
				<Card>
					<form
						method="POST"
						action="?/openingStock"
						class="flex flex-col gap-4"
						use:enhance={guard('opening')}
					>
						<h3 class="text-section">Opening stock</h3>
						<p class="text-ink-2 text-sm">
							Stock already on the shelf. Recorded as money the owner put into the business.
						</p>
						{#if outcomeAt === 'opening'}
							<Alert {tone}>{form?.message}</Alert>
						{/if}
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
						<Field
							id="opening-qty"
							name="qty"
							label="Quantity"
							required
							numeric
							inputmode="decimal"
						/>
						<Field
							id="opening-cost"
							name="cost"
							label="Cost per unit"
							required
							numeric
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

			{#if !data.ingredient.archived}
				<Card>
					<details open={outcomeAt === 'archive'}>
						<summary class="text-section text-ink cursor-pointer">Archive</summary>
						<form
							method="POST"
							action="?/archive"
							class="mt-4 flex flex-col gap-4"
							use:enhance={guard('archive')}
						>
							{#if outcomeAt === 'archive'}
								<Alert {tone}>{form?.message}</Alert>
							{/if}
							<p class="text-ink-2 text-sm">
								An archived ingredient leaves the lists; its movements stay in the stock book. It
								cannot be archived while a recipe uses it.
							</p>
							<div>
								<Button type="submit" variant="danger" disabled={submitting}>
									{submitting ? 'Saving…' : 'Archive ingredient'}
								</Button>
							</div>
						</form>
					</details>
				</Card>
			{/if}
		{/snippet}
	</PageColumns>
</PageBody>
