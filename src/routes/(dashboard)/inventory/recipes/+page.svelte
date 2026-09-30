<script lang="ts">
	// THE RECIPE EDITOR. It renders what the server sends and computes nothing:
	// every cost is the formatter's string and every quantity formatQty's. The rows
	// are plain form fields — "Add row" and "Remove" only change which fields are
	// on the page; the server parses and checks every one (it trusts nothing here).
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		ActionBar,
		Alert,
		Button,
		Card,
		PageBody,
		PageColumns,
		PageHeader
	} from '$lib/components/ui';

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
	const FORM_ID = 'recipe-form';

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
	<title>Recipes · matcami</title>
</svelte:head>

<PageHeader
	crumbs={[{ label: 'Inventory', href: resolve('/inventory') }]}
	title="Recipes"
	description="What each menu item and each modifier uses, in each ingredient's base unit. A sale deducts its recipe; the cost is the recipe at today's average costs."
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
	{#if form?.message && !data.selected}
		<!-- No editor on screen, so no ActionBar to hold the result. -->
		<Alert {tone}>{form.message}</Alert>
	{/if}

	<PageColumns asideFirst>
		<Card>
			{#if data.selected}
				<form
					id={FORM_ID}
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
						<h3 class="text-section">
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
					</div>
				</form>
			{:else}
				<div class="flex flex-col gap-2">
					<h3 class="text-section">Choose a menu item or a modifier</h3>
					<p class="text-ink-2 text-sm">
						Pick one from the list to see and edit its recipe. Quantities are in each ingredient's
						base unit. Extras may be negative: 'No tomato' takes tomato away.
					</p>
				</div>
			{/if}
		</Card>

		{#snippet aside()}
			<Card>
				<nav aria-label="Recipes to edit" class="flex flex-col gap-4">
					<h3 class="text-section">Menu items</h3>
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

					<h3 class="text-section">Modifiers</h3>
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
				</nav>
			</Card>
		{/snippet}
	</PageColumns>
</PageBody>

{#if data.selected}
	<ActionBar caption="Empty rows are ignored. Saving with no rows clears the recipe.">
		{#snippet message()}
			{#if form?.message}
				<Alert {tone}>{form.message}</Alert>
			{:else}
				<p class="text-caption text-ink-2">
					Empty rows are ignored. Saving with no rows clears the recipe.
				</p>
			{/if}
		{/snippet}
		<Button type="submit" form={FORM_ID} variant="primary" disabled={submitting}>
			{submitting ? 'Saving…' : 'Save recipe'}
		</Button>
	</ActionBar>
{/if}
