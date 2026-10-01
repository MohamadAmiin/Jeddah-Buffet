<script lang="ts">
	// THE INVENTORY PAGE. It renders what the server sends and computes nothing:
	// every amount is the formatter's string, every quantity formatQty's. Colour
	// never carries meaning alone — below-zero stock shows ◆ and the words, a cache
	// that differs from its movements shows ✕ and the words.
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		Alert,
		Button,
		Callout,
		CreatePanel,
		Field,
		PageBody,
		PageColumns,
		PageHeader,
		Table
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	// The create panel is open below xl when the URL asks for it, when there is
	// nothing to list yet, or when this page's one form has a result to show.
	const PANEL_ID = 'add-ingredient';
	let opened = $state(false);
	const asideOpen = $derived(
		opened ||
			page.url.searchParams.get('add') === '1' ||
			data.ingredients.length === 0 ||
			Boolean(form?.message)
	);
	const addHref = resolve('/inventory') + `?add=1#${PANEL_ID}`;

	async function openPanel(event: MouseEvent) {
		event.preventDefault();
		opened = true;
		await tick();
		document.getElementById('ingredient-name')?.focus();
	}

	const columns = [
		{ key: 'name', label: 'Ingredient' },
		{ key: 'onHand', label: 'On hand', numeric: true },
		{ key: 'perUnit', label: 'Average cost', numeric: true },
		{ key: 'value', label: 'Value', numeric: true },
		{ key: 'status', label: 'Status' }
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
	<title>Inventory · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Catalogue"
	title="Inventory"
	description="What is on the shelf and what it is worth, from the stock book. Every delivery, sale, waste entry and count moves it; nothing is typed over."
>
	{#snippet actions()}
		<Button variant="primary" href={addHref} class="xl:hidden" onclick={openPanel}>
			Add ingredient
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
	{#if data.mismatch}
		<Callout tone="danger" title="The stock book and the books disagree">
			The stock value differs from the books by {data.mismatch.difference ?? '—'} ({data.mismatch
				.driftCount}
			{data.mismatch.driftCount === 1 ? 'ingredient differs' : 'ingredients differ'} from the stock book).
		</Callout>
	{/if}

	<PageColumns collapsible {asideOpen}>
		<section
			aria-labelledby="ingredients-h"
			class="rounded-card border-line bg-raise shadow-card overflow-hidden border"
		>
			<div class="px-6 py-4">
				<h3 id="ingredients-h" class="text-section">Ingredients</h3>
			</div>
			<div class="px-6 md:px-0">
				<Table
					caption="Ingredients"
					{columns}
					rows={data.ingredients}
					empty="No ingredients yet. Add the first one with Add ingredient."
				>
					{#snippet cell(row, key)}
						{#if key === 'name'}
							<a
								class={`font-medium underline underline-offset-2 ${row.archived ? 'text-ink-2' : 'text-ink'}`}
								href={resolve(`/inventory/${row.id}`)}
							>
								{row.name}{row.archived ? ' (archived)' : ''}
							</a>
						{:else if key === 'onHand'}
							<span class={row.negative ? 'text-danger' : 'text-ink'}>{row.onHand}</span>
						{:else if key === 'perUnit'}
							<span class="text-ink">{row.perUnit ?? '—'} / {row.perUnitName}</span>
						{:else if key === 'value'}
							<span class={row.valueNegative ? 'text-danger' : 'text-ink'}>{row.value ?? '—'}</span>
						{:else if key === 'status'}
							<div class="flex flex-wrap gap-2 text-sm">
								{#if row.negative}
									<span class="text-danger"
										><span aria-hidden="true" class="font-mono">◆</span> below zero</span
									>
								{/if}
								{#if row.drift}
									<span class="text-danger"
										><span aria-hidden="true" class="font-mono">✕</span> differs from the stock book</span
									>
								{/if}
							</div>
						{/if}
					{/snippet}
				</Table>
			</div>
		</section>

		{#snippet aside()}
			<CreatePanel id={PANEL_ID} title="Add ingredient">
				<form
					method="POST"
					action="?/createIngredient"
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
					<Field id="ingredient-name" name="name" label="Name" required maxlength={80} />
					<Field
						id="ingredient-unit"
						name="baseUnit"
						label="Base unit"
						required
						maxlength={16}
						hint="The unit recipes use, for example g, ml or pcs. It cannot change once stock has moved."
					/>
					<div>
						<Button type="submit" variant="primary" disabled={submitting}>
							{submitting ? 'Saving…' : 'Add ingredient'}
						</Button>
					</div>
				</form>
			</CreatePanel>
		{/snippet}
	</PageColumns>
</PageBody>
