<script lang="ts">
	// THE WASTE PAGE. It renders what the server sends and computes nothing: every
	// amount is the formatter's string, every quantity formatQty's.
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		Alert,
		Button,
		CreatePanel,
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

	// The "Record waste" panel is open below xl when the URL asks for it, when
	// nothing is listed yet, or when its form has a result to show.
	const PANEL_ID = 'record-waste';
	let opened = $state(false);
	const asideOpen = $derived(
		opened ||
			page.url.searchParams.get('add') === '1' ||
			data.entries.length === 0 ||
			Boolean(form?.message)
	);
	const addHref = resolve('/inventory/waste') + `?add=1#${PANEL_ID}`;

	async function openPanel(event: MouseEvent) {
		event.preventDefault();
		opened = true;
		await tick();
		document.getElementById('waste-ingredient')?.focus();
	}

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
	<title>Waste · matcami</title>
</svelte:head>

<PageHeader
	crumbs={[{ label: 'Inventory', href: resolve('/inventory') }]}
	title="Waste"
	description="Goods thrown away leave the stock book at their average cost. A waste entry is never edited."
>
	{#snippet actions()}
		<Button variant="primary" href={addHref} class="xl:hidden" onclick={openPanel}>
			Record waste
		</Button>
	{/snippet}
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
	<PageColumns collapsible {asideOpen}>
		<section
			aria-labelledby="recent-waste-h"
			class="rounded-card border-line bg-raise shadow-card overflow-hidden border"
		>
			<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-6 py-4">
				<h3 id="recent-waste-h" class="text-section">Recent waste</h3>
				<p class="text-caption text-ink-2">The last 50 entries from the last 30 business days.</p>
			</div>
			<div class="px-6 md:px-0">
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
		</section>

		{#snippet aside()}
			<CreatePanel id={PANEL_ID} title="Record waste" icon="plus-circle">
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
					{#if form?.message}
						<Alert {tone}>{form.message}</Alert>
					{/if}
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
						numeric
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
			</CreatePanel>
		{/snippet}
	</PageColumns>
</PageBody>
