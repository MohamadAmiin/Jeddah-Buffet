<script lang="ts">
	// THE MENU PAGE. It renders what the server sends and computes nothing: every
	// amount arrives as the money formatter's string, every tax rate as a label,
	// every photo as a URL. Money renders `font-mono tabular-nums text-right`; a
	// negative carries the formatter's leading minus AND text-danger. Price entry is
	// type="text" with inputmode="decimal", never type="number", whose value the
	// browser localises.
	//
	// The layout borrows the till's grammar in the DASHBOARD's teal palette
	// (menu-and-printing R4): a pill filter, a photo grid, category management.
	// Tailwind's default scale throughout — no POS touch token appears here.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';

	let { data, form } = $props();

	// Tone follows the outcome: page.status is 400 after a fail() and 200 otherwise.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// No currency, no exponent, no way to read a typed price: the gate the server
	// enforces, said on screen beside every control it disables.
	const NO_CURRENCY = 'Set the currency in Settings before adding prices.';
	const ready = $derived(data.currency !== null);
	const priceHint = $derived(
		data.currency ? `In ${data.currency.code}, for example 8.50.` : NO_CURRENCY
	);

	// The pill filter: every item, the items with no category, or one category.
	let filter = $state<'all' | 'none' | string>('all');
	const visibleItems = $derived(
		filter === 'all'
			? data.items
			: filter === 'none'
				? data.items.filter((item: { categoryId: string | null }) => item.categoryId === null)
				: data.items.filter((item: { categoryId: string | null }) => item.categoryId === filter)
	);

	const categoryName = (id: string | null) =>
		id === null
			? 'No category'
			: (data.categories.find((category: { id: string }) => category.id === id)?.name ??
				'No category');
	const groupName = (id: string) =>
		data.groups.find((group: { id: string }) => group.id === id)?.name ?? '';
	// The photo-less tile: the first letter of the first two words, upper-cased.
	const initials = (name: string) =>
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => word.charAt(0).toUpperCase())
			.join('');

	// A native <select> styled like Field's control (border-control-line: a control
	// edge, never the decorative border-line).
	const selectClass = 'border-control-line bg-bg text-ink rounded-control border px-3 py-2';
	const pillClass = (on: boolean) =>
		`rounded-full border px-4 py-2 font-medium ${
			on ? 'bg-accent text-accent-ink border-accent' : 'bg-raise text-ink border-control-line'
		}`;
</script>

<svelte:head>
	<title>Menu · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Catalogue"
	title="Menu"
	description="What the till sells: items with their prices and photos, the categories that group them, and the modifier groups that change them. A category and a photo are both optional. An item is archived, never deleted — it stays on past receipts and reports."
/>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<!-- EXACTLY ONE role="alert" region: the form's message, and nothing else. -->
	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
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

	<!-- The filter sits on the page ground, not in a card. -->
	<div role="group" aria-label="Filter by category" class="flex flex-wrap gap-2">
		<button
			type="button"
			aria-pressed={filter === 'all'}
			class={pillClass(filter === 'all')}
			onclick={() => (filter = 'all')}
		>
			All ({data.items.length})
		</button>
		{#each data.categories as category (category.id)}
			<button
				type="button"
				aria-pressed={filter === category.id}
				class={pillClass(filter === category.id)}
				onclick={() => (filter = category.id)}
			>
				{category.name} ({category.itemCount})
			</button>
		{/each}
		{#if data.uncategorisedCount > 0}
			<button
				type="button"
				aria-pressed={filter === 'none'}
				class={pillClass(filter === 'none')}
				onclick={() => (filter = 'none')}
			>
				No category ({data.uncategorisedCount})
			</button>
		{/if}
	</div>

	<!-- The photo grid: tiles on the page ground, so nothing nests in a card. -->
	{#if data.items.length === 0}
		<p class="text-ink-2">
			<span aria-hidden="true" class="font-mono">○</span>
			No items yet. Add your first item — a category and a photo are both optional.
		</p>
	{:else if visibleItems.length === 0}
		<p class="text-ink-2"><span aria-hidden="true" class="font-mono">○</span> No items here.</p>
	{/if}
	<ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
		{#each visibleItems as item (item.id)}
			<li class="bg-raise border-line rounded-card flex flex-col overflow-hidden border">
				{#if item.imageUrl}
					<img
						src={item.imageUrl}
						alt=""
						loading="lazy"
						decoding="async"
						class="aspect-video w-full object-cover"
					/>
				{:else}
					<div class="bg-raise-2 text-ink-2 flex aspect-video w-full items-center justify-center">
						<span aria-hidden="true" class="font-display text-display font-semibold"
							>{initials(item.name)}</span
						>
						<span class="sr-only">No photo</span>
					</div>
				{/if}
				<div class="flex flex-col gap-3 p-4">
					<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
						<div class="flex grow flex-col">
							<span class="text-ink font-semibold">{item.name}</span>
							<span class="text-ink-2 text-sm">{categoryName(item.categoryId)}</span>
						</div>
						<div class="flex flex-col items-end">
							<span class="text-ink text-right font-mono tabular-nums">{item.price ?? '—'}</span>
							<span class="text-ink-2 text-sm">Tax: {item.taxRate}</span>
						</div>
					</div>

					<div class="flex flex-wrap items-center justify-between gap-2">
						{#if item.isAvailable}
							<span class="text-ok"
								><span aria-hidden="true" class="font-mono">●</span> Available</span
							>
						{:else}
							<span class="text-ink-2"
								><span aria-hidden="true" class="font-mono">○</span> Sold out</span
							>
						{/if}
						<form method="POST" action="?/setAvailability" use:enhance>
							<input type="hidden" name="itemId" value={item.id} />
							<input type="hidden" name="available" value={item.isAvailable ? 'no' : 'yes'} />
							<Button type="submit" variant="secondary">
								{item.isAvailable ? 'Mark sold out' : 'Mark available'}
							</Button>
						</form>
					</div>

					{#if item.groupIds.length > 0}
						<ul class="flex flex-wrap gap-2">
							{#each item.groupIds as groupId (groupId)}
								<li class="flex items-center gap-2">
									<span class="text-ink-2 text-sm">{groupName(groupId)}</span>
									<form method="POST" action="?/unlinkGroup" use:enhance>
										<input type="hidden" name="itemId" value={item.id} />
										<input type="hidden" name="groupId" value={groupId} />
										<Button type="submit" variant="ghost" disabled={!ready}>Detach</Button>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
					<details>
						<summary class="text-ink cursor-pointer text-sm">Edit {item.name}…</summary>
						<form method="POST" action="?/updateItem" class="mt-3 flex flex-col gap-3" use:enhance>
							<input type="hidden" name="itemId" value={item.id} />
							<Field id={`name-${item.id}`} name="name" label="Name" value={item.name} />
							<Field
								id={`price-${item.id}`}
								name="price"
								label="New price"
								inputmode="decimal"
								disabled={!ready}
								hint={ready ? `Now ${item.price}. Leave blank to keep it.` : NO_CURRENCY}
							/>
							<div class="flex flex-col gap-1">
								<label class="text-ink-2 text-sm font-medium" for={`category-${item.id}`}
									>Category</label
								>
								<select
									id={`category-${item.id}`}
									name="categoryId"
									class={selectClass}
									value={item.categoryId ?? ''}
								>
									<option value="">No category</option>
									{#each data.categories as category (category.id)}
										<option value={category.id}>{category.name}</option>
									{/each}
								</select>
							</div>
							<Field
								id={`rate-${item.id}`}
								name="taxRateBp"
								label="Tax rate (basis points)"
								inputmode="numeric"
								value={item.taxRateBp === null ? '' : String(item.taxRateBp)}
								hint="Leave blank to use the restaurant rate. 825 means 8.25%."
							/>
							<div>
								<Button
									type="submit"
									variant="secondary"
									disabled={!ready}
									disabledReason={NO_CURRENCY}>Save item</Button
								>
							</div>
						</form>
					</details>
					{#if data.groups.length > 0}
						<form
							method="POST"
							action="?/linkGroup"
							class="flex flex-wrap items-end gap-2"
							use:enhance
						>
							<input type="hidden" name="itemId" value={item.id} />
							<label class="text-ink-2 text-sm" for={`link-${item.id}`}>Modifier group</label>
							<select id={`link-${item.id}`} name="groupId" class={selectClass}>
								{#each data.groups as group (group.id)}
									<option value={group.id}>{group.name}</option>
								{/each}
							</select>
							<Button type="submit" variant="secondary" disabled={!ready}>Attach</Button>
						</form>
					{/if}
					<!-- Archive, never delete: no delete control exists on this page. -->
					<details>
						<summary class="text-danger cursor-pointer text-sm">Archive {item.name}…</summary>
						<div class="mt-2 flex flex-col gap-2">
							<p class="text-ink-2 text-sm">
								It leaves the till and this page, and stays on past receipts and reports.
							</p>
							<form method="POST" action="?/archiveItem" use:enhance>
								<input type="hidden" name="itemId" value={item.id} />
								<Button type="submit" variant="danger" disabled={!ready}>Archive item</Button>
							</form>
						</div>
					</details>
				</div>
			</li>
		{/each}
	</ul>

	<div class="grid gap-5 lg:grid-cols-2">
		<Card>
			<div class="flex flex-col gap-4">
				<h3 class="text-ink font-semibold">Categories</h3>
				{#if data.categories.length === 0}
					<p class="text-ink-2">
						<span aria-hidden="true" class="font-mono">○</span>
						No categories yet. Items do not need one.
					</p>
				{/if}
				<ul class="flex flex-col">
					{#each data.categories as category (category.id)}
						<li class="border-line flex flex-col gap-2 border-t py-3 first:border-t-0">
							<form
								method="POST"
								action="?/renameCategory"
								class="flex flex-wrap items-end gap-2"
								use:enhance
							>
								<input type="hidden" name="categoryId" value={category.id} />
								<div class="grow">
									<Field
										id={`rename-${category.id}`}
										name="name"
										label="Name"
										value={category.name}
										required
									/>
								</div>
								<Button type="submit" variant="secondary">Rename</Button>
							</form>
							<details>
								<summary class="text-danger cursor-pointer text-sm"
									>Archive {category.name}…</summary
								>
								<div class="mt-2 flex flex-col gap-2">
									<p class="text-ink-2 text-sm">
										Its {category.itemCount} item(s) move to No category. Past receipts and reports keep
										their category.
									</p>
									<form method="POST" action="?/archiveCategory" use:enhance>
										<input type="hidden" name="categoryId" value={category.id} />
										<Button type="submit" variant="danger">Archive category</Button>
									</form>
								</div>
							</details>
						</li>
					{/each}
				</ul>
			</div>
		</Card>

		<Card>
			<form method="POST" action="?/createCategory" class="flex flex-col gap-4" use:enhance>
				<h3 class="text-ink font-semibold">Add a category</h3>
				<Field id="category-name" name="name" label="Category name" required />
				<div>
					<Button type="submit" disabled={!ready} disabledReason={NO_CURRENCY}>Add category</Button>
				</div>
			</form>
		</Card>
	</div>

	<Card class="max-w-form">
		<form method="POST" action="?/createItem" class="flex flex-col gap-4" use:enhance>
			<h3 class="text-ink font-semibold">Add an item</h3>
			<div class="flex flex-col gap-1">
				<label class="text-ink-2 text-sm font-medium" for="item-category">Category</label>
				<select id="item-category" name="categoryId" class={selectClass}>
					<option value="">No category</option>
					{#each data.categories as category (category.id)}
						<option value={category.id}>{category.name}</option>
					{/each}
				</select>
			</div>
			<Field id="item-name" name="name" label="Item name" required />
			<Field
				id="item-price"
				name="price"
				label="Price"
				inputmode="decimal"
				required
				disabled={!ready}
				hint={priceHint}
			/>
			<Field
				id="item-rate"
				name="taxRateBp"
				label="Item tax rate (basis points)"
				inputmode="numeric"
				hint="Leave blank to use the restaurant rate. 825 means 8.25%."
			/>
			<div>
				<Button type="submit" disabled={!ready} disabledReason={NO_CURRENCY}>Add item</Button>
			</div>
		</form>
	</Card>

	<Card>
		<div class="flex flex-col gap-4">
			<h3 class="text-ink font-semibold">Modifier groups</h3>
			{#if data.groups.length === 0}
				<p class="text-ink-2">No modifier groups yet.</p>
			{/if}
			{#each data.groups as group (group.id)}
				<section class="flex flex-col gap-1">
					<h4 class="text-ink font-medium">
						{group.name}
						<span class="text-ink-2 text-sm font-normal">
							— pick {group.minSelect} to {group.maxSelect}
						</span>
					</h4>
					<ul class="flex flex-col">
						{#each group.modifiers as modifier (modifier.id)}
							<li class="flex items-baseline gap-4">
								<span class="text-ink grow">{modifier.name}</span>
								<span
									class={`text-right font-mono tabular-nums ${modifier.negative ? 'text-danger' : 'text-ink'}`}
								>
									{modifier.delta ?? '—'}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</Card>

	<div class="grid gap-5 lg:grid-cols-2">
		<Card>
			<form method="POST" action="?/createModifierGroup" class="flex flex-col gap-4" use:enhance>
				<h3 class="text-ink font-semibold">Add a modifier group</h3>
				<Field id="group-name" name="name" label="Group name" required />
				<Field
					id="group-min"
					name="minSelect"
					label="Fewest a guest must pick"
					inputmode="numeric"
					value="0"
				/>
				<Field
					id="group-max"
					name="maxSelect"
					label="Most a guest may pick"
					inputmode="numeric"
					value="1"
				/>
				<div>
					<Button type="submit" disabled={!ready} disabledReason={NO_CURRENCY}>Add group</Button>
				</div>
			</form>
		</Card>

		<Card>
			<form method="POST" action="?/createModifier" class="flex flex-col gap-4" use:enhance>
				<h3 class="text-ink font-semibold">Add a modifier</h3>
				<div class="flex flex-col gap-1">
					<label class="text-ink-2 text-sm font-medium" for="modifier-group">Group</label>
					<select id="modifier-group" name="groupId" class={selectClass} required>
						{#each data.groups as group (group.id)}
							<option value={group.id}>{group.name}</option>
						{/each}
					</select>
				</div>
				<Field id="modifier-name" name="name" label="Modifier name" required />
				<Field
					id="modifier-delta"
					name="priceDelta"
					label="Price change"
					inputmode="decimal"
					required
					disabled={!ready}
					hint={ready ? 'Negative takes money off, for example -0.50.' : NO_CURRENCY}
				/>
				<div>
					<Button
						type="submit"
						disabled={!ready || data.groups.length === 0}
						disabledReason={ready ? 'Add a modifier group first.' : NO_CURRENCY}
						>Add modifier</Button
					>
				</div>
			</form>
		</Card>
	</div>
</div>
