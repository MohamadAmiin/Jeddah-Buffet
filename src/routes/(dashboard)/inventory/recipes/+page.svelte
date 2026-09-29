<script lang="ts">
	// THE RECIPE EDITOR. It renders what the server sends and computes nothing:
	// every cost is the formatter's string and every quantity formatQty's. The rows
	// are plain form fields — "Add row" and "Remove" only change which fields are
	// on the page; the server parses and checks every one (it trusts nothing here).
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Alert, Button, Card, PageHeader } from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	type Row = { key: string; ingredientId: string; qty: string };

	// A row key only tells Svelte which DOM row is which; it is not data.
	let nextKey = 0;
	function blankRow(): Row {
		nextKey += 1;
		return { key: `new-${nextKey}`, ingredientId: '', qty: '' };
	}

	// Writable $derived: reset from the server whenever the selection or its saved
	// recipe changes, reassigned by Add row / Remove in between. The inputs are
	// uncontrolled and keyed, so typed values survive adding or removing a row.
	let rows = $derived<Row[]>([
		...(data.selected?.rows ?? []).map((line, index) => ({
			key: `saved-${index}`,
			ingredientId: line.ingredientId,
			qty: line.qty
		})),
		blankRow()
	]);

	const MAX_ROWS = 30;

	function addRow() {
		rows = [...rows, blankRow()];
	}

	function removeRow(key: string) {
		rows = rows.filter((row) => row.key !== key);
	}

	// The picker's link to one owner: the resolve()d route plus its query string.
	function recipeHref(kind: 'item' | 'modifier', id: string): string {
		return resolve('/inventory/recipes') + '?' + new URLSearchParams({ [kind]: id }).toString();
	}

	const controlClass = 'border-control-line bg-bg text-ink rounded-control border px-3 py-2';
</script>

<svelte:head>
	<title>Recipes · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Inventory"
	title="Recipes"
	description="What each menu item and each modifier uses, in each ingredient's base unit. A sale deducts its recipe; the cost is the recipe at today's average costs."
/>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<p>
		<a href={resolve('/inventory')} class="text-ink underline underline-offset-2"
			>Back to inventory</a
		>
	</p>

	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	<div class="grid gap-5 lg:grid-cols-2">
		<Card>
			<div class="flex flex-col gap-4">
				<h3 class="text-ink font-semibold">Menu items</h3>
				{#if data.categories.every((category) => category.items.length === 0)}
					<p class="text-ink-2 text-sm">No menu items yet. Add them on the Menu page.</p>
				{/if}
				{#each data.categories as category (category.id)}
					{#if category.items.length > 0}
						<div class="flex flex-col gap-1">
							<h4 class="text-ink-2 text-sm font-medium">{category.name}</h4>
							<ul class="flex flex-col gap-1">
								{#each category.items as item (item.id)}
									<li class="flex items-baseline justify-between gap-3">
										<!-- eslint-disable svelte/no-navigation-without-resolve -- the path IS resolve()d; the rule only accepts a bare resolve() call, and the owner id has to travel as a query string -->
										<a
											href={recipeHref('item', item.id)}
											class="text-ink underline underline-offset-2"
											aria-current={data.selected?.kind === 'item' && data.selected.id === item.id
												? 'page'
												: undefined}>{item.name}</a
										>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
										<span
											class={`font-mono tabular-nums ${item.costNegative ? 'text-danger' : 'text-ink'}`}
										>
											{item.hasRecipe ? (item.cost ?? '—') : '—'}
										</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				{/each}

				<h3 class="text-ink font-semibold">Modifiers</h3>
				{#if data.groups.every((group) => group.modifiers.length === 0)}
					<p class="text-ink-2 text-sm">No modifiers yet.</p>
				{/if}
				{#each data.groups as group (group.id)}
					{#if group.modifiers.length > 0}
						<div class="flex flex-col gap-1">
							<h4 class="text-ink-2 text-sm font-medium">{group.name}</h4>
							<ul class="flex flex-col gap-1">
								{#each group.modifiers as modifier (modifier.id)}
									<li class="flex items-baseline justify-between gap-3">
										<!-- eslint-disable svelte/no-navigation-without-resolve -- the path IS resolve()d; the rule only accepts a bare resolve() call, and the owner id has to travel as a query string -->
										<a
											href={recipeHref('modifier', modifier.id)}
											class="text-ink underline underline-offset-2"
											aria-current={data.selected?.kind === 'modifier' &&
											data.selected.id === modifier.id
												? 'page'
												: undefined}>{modifier.name}</a
										>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
										<span
											class={`font-mono tabular-nums ${modifier.costNegative ? 'text-danger' : 'text-ink'}`}
										>
											{modifier.hasRecipe ? (modifier.cost ?? '—') : '—'}
										</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				{/each}
			</div>
		</Card>

		<Card>
			{#if data.selected}
				<form
					method="POST"
					action="?/save"
					class="flex flex-col gap-4"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							await update({ reset: false });
							submitting = false;
						};
					}}
				>
					<div class="flex flex-col gap-1">
						<h3 class="text-ink font-semibold">
							{data.selected.name}
							{#if data.selected.context}
								<span class="text-ink-2 font-normal"> · {data.selected.context}</span>
							{/if}
						</h3>
						<p class="text-ink-2 text-sm">
							Recipe cost:
							<span
								class={`font-mono tabular-nums ${data.selected.costNegative ? 'text-danger' : 'text-ink'}`}
								>{data.selected.hasRecipe ? (data.selected.cost ?? '—') : '—'}</span
							>
						</p>
						<p class="text-ink-2 text-sm">
							Quantities are in each ingredient's base unit. Extras may be negative: 'No tomato'
							takes tomato away.
						</p>
					</div>

					<input type="hidden" name="kind" value={data.selected.kind} />
					<input type="hidden" name="ownerId" value={data.selected.id} />

					{#if data.ingredients.length === 0}
						<p class="text-ink-2 text-sm">
							No ingredients yet. Add them on the <a
								href={resolve('/inventory')}
								class="text-ink underline underline-offset-2">Inventory</a
							> page first.
						</p>
					{/if}

					<ol class="flex flex-col gap-3">
						{#each rows as row, index (row.key)}
							<li class="flex flex-wrap items-end gap-2">
								<label class="flex min-w-0 flex-1 flex-col gap-1">
									<span class="text-ink-2 text-sm font-medium">Ingredient, row {index + 1}</span>
									<select name="ingredientId" value={row.ingredientId} class={controlClass}>
										<option value="">—</option>
										{#each data.ingredients as ingredient (ingredient.id)}
											<option value={ingredient.id}>
												{ingredient.name} ({ingredient.baseUnit}){ingredient.archived
													? ' — archived'
													: ''}
											</option>
										{/each}
									</select>
								</label>
								<label class="flex w-32 flex-col gap-1">
									<span class="text-ink-2 text-sm font-medium">Quantity, row {index + 1}</span>
									<input
										name="qty"
										value={row.qty}
										inputmode="decimal"
										autocomplete="off"
										maxlength={20}
										class={`${controlClass} text-right font-mono tabular-nums`}
									/>
								</label>
								<Button variant="ghost" onclick={() => removeRow(row.key)}
									>Remove row {index + 1}</Button
								>
							</li>
						{/each}
					</ol>

					<div class="flex flex-wrap gap-2">
						<Button
							variant="secondary"
							onclick={addRow}
							disabled={rows.length >= MAX_ROWS}
							disabledReason="A recipe has at most 30 ingredients.">Add row</Button
						>
						<Button type="submit" variant="primary" disabled={submitting}>
							{submitting ? 'Saving…' : 'Save recipe'}
						</Button>
					</div>
					<p class="text-ink-2 text-sm">
						Empty rows are ignored. Saving with no rows clears the recipe.
					</p>
				</form>
			{:else}
				<div class="flex flex-col gap-2">
					<h3 class="text-ink font-semibold">Choose a menu item or a modifier</h3>
					<p class="text-ink-2 text-sm">
						Pick one from the list to see and edit its recipe. Quantities are in each ingredient's
						base unit. Extras may be negative: 'No tomato' takes tomato away.
					</p>
				</div>
			{/if}
		</Card>
	</div>
</div>
