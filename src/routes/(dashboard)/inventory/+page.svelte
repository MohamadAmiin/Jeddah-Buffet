<script lang="ts">
	// THE INVENTORY PAGE. It renders what the server sends and computes nothing:
	// every amount is the formatter's string, every quantity formatQty's. Colour
	// never carries meaning alone — below-zero stock shows ◆ and the words, a cache
	// that differs from its movements shows ✕ and the words.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader, Table } from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	const columns = [
		{ key: 'name', label: 'Ingredient' },
		{ key: 'onHand', label: 'On hand', numeric: true },
		{ key: 'perUnit', label: 'Average cost', numeric: true },
		{ key: 'value', label: 'Value', numeric: true },
		{ key: 'status', label: 'Status' }
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
		<nav class="flex flex-wrap gap-2" aria-label="Inventory sections">
			<Button variant="secondary" href={resolve('/inventory/recipes')}>Recipes</Button>
			<Button variant="secondary" href={resolve('/purchases')}>Deliveries</Button>
			<Button variant="secondary" href={resolve('/inventory/waste')}>Waste</Button>
			<Button variant="secondary" href={resolve('/inventory/counts')}>Counts</Button>
			<Button variant="secondary" href={resolve('/inventory/reports')}>Reports</Button>
		</nav>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	{#if data.mismatch}
		<div class="max-w-form">
			<Alert tone="danger">
				The stock value differs from the books by {data.mismatch.difference} ({data.mismatch
					.driftCount}
				{data.mismatch.driftCount === 1 ? 'ingredient differs' : 'ingredients differ'} from the stock
				book).
			</Alert>
		</div>
	{/if}

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Ingredients</h3>
			<Table
				caption="Ingredients"
				{columns}
				rows={data.ingredients}
				empty="No ingredients yet. Add the first one below."
			>
				{#snippet cell(row, key)}
					{#if key === 'name'}
						<a
							class={`font-medium underline-offset-2 hover:underline ${row.archived ? 'text-ink-2' : 'text-ink'}`}
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
								<span class="text-danger">◆ below zero</span>
							{/if}
							{#if row.drift}
								<span class="text-danger">✕ differs from the stock book</span>
							{/if}
						</div>
					{/if}
				{/snippet}
			</Table>
		</div>
	</Card>

	<Card class="max-w-form">
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
			<h3 class="text-ink font-semibold">Add ingredient</h3>
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
	</Card>
</div>
