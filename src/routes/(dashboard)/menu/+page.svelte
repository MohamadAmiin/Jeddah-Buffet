<script lang="ts">
	// THE MENU PAGE. It renders what the server sends and computes nothing: every
	// amount arrives as the money formatter's string, every tax rate as a label,
	// every photo as a URL. Money renders `font-mono tabular-nums text-right`; a
	// negative carries the formatter's leading minus AND text-danger. Price entry is
	// type="text" with inputmode="decimal", never type="number", whose value the
	// browser localises.
	//
	// The layout borrows the till's grammar in the DASHBOARD's teal palette
	// (menu-and-printing R4): a pill filter, a photo grid, ONE add/edit panel with a
	// photo picker, category management. Tailwind's default scale throughout — no
	// POS touch token appears here.
	//
	// THE PHOTO NEVER TRAVELS WITH THE ITEM FIELDS. A phone photo is 3–8 MB;
	// adapter-node refuses bodies over 512K and Nginx over 1m, and a refused
	// request would take the typed name and price down with it. So the picker
	// resizes in the browser (src/lib/image-resize.ts, at most 400 KB), the item
	// is saved first, and the photo goes up in its OWN request to ?/setImage —
	// a failed photo leaves the item saved and says so.
	import { deserialize, enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import {
		Alert,
		Button,
		Card,
		Field,
		PageBody,
		PageHeader,
		SelectField
	} from '$lib/components/ui';
	import { resizePhoto } from '$lib/image-resize';

	let { data, form } = $props();
	type Item = (typeof data)['items'][number];

	// Tone follows the outcome: page.status is 400 after a fail() and 200 otherwise.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// WHICH form produced `form.message`, so its Alert renders inside the card of
	// that form (docs/redesign section 11) rather than at the top of the page. The
	// actions return only { message }, so the page tracks the source itself: an
	// enhanced submit records it through `from()` (which returns nothing, so
	// enhance keeps its default behaviour), and a no-JavaScript POST leaves the
	// action name in the URL (`?/createCategory`). Still EXACTLY ONE role="alert":
	// only the matching card renders the message.
	type Source = 'panel' | 'tile' | 'categories' | 'addCategory' | 'addGroup' | 'addModifier';
	const SOURCE_OF: Record<string, Source> = {
		createItem: 'panel',
		updateItem: 'panel',
		removeImage: 'panel',
		linkGroup: 'panel',
		unlinkGroup: 'panel',
		archiveItem: 'panel',
		setImage: 'panel',
		setAvailability: 'tile',
		renameCategory: 'categories',
		archiveCategory: 'categories',
		createCategory: 'addCategory',
		createModifierGroup: 'addGroup',
		createModifier: 'addModifier'
	};
	let submitted = $state<{ source: Source; itemId: string | null } | null>(null);
	const fromUrl = $derived(
		page.url.search.startsWith('?/') ? (SOURCE_OF[page.url.search.slice(2)] ?? null) : null
	);
	const origin = $derived(
		submitted ?? (fromUrl ? { source: fromUrl, itemId: null } : { source: 'panel', itemId: null })
	);
	/** The outcome for one card, or '' when another form produced it. */
	const messageFor = (source: Source, itemId: string | null = null): string => {
		if (!form?.message) return '';
		// A no-JavaScript availability toggle does not say which tile: the panel shows it.
		const where =
			origin.source === 'tile' && origin.itemId === null
				? { source: 'panel', itemId: null }
				: origin;
		return where.source === source && where.itemId === itemId ? form.message : '';
	};
	const from =
		(source: Source, itemId: string | null = null): SubmitFunction =>
		() => {
			submitted = { source, itemId };
		};

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
				? data.items.filter((item: Item) => item.categoryId === null)
				: data.items.filter((item: Item) => item.categoryId === filter)
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
	const categoryOptions = $derived([
		{ value: '', label: 'No category' },
		...data.categories.map((category: { id: string; name: string }) => ({
			value: category.id,
			label: category.name
		}))
	]);

	// ── The one panel: add mode, or edit mode for one item. ────────────────────
	let mode = $state<'add' | 'edit'>('add');
	let editing = $state.raw<Item | null>(null);
	let panel = $state<HTMLElement | null>(null);
	// The resized photo waiting for its own upload, and its preview.
	let photoBlob = $state.raw<Blob | null>(null);
	let previewUrl = $state<string | null>(null);
	let photoError = $state('');
	let photoOutcome = $state('');

	function resetPhoto() {
		photoBlob = null;
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = null;
		photoError = '';
	}
	function startAdd() {
		mode = 'add';
		editing = null;
		photoOutcome = '';
		resetPhoto();
		panel?.scrollIntoView({ block: 'nearest' });
	}
	function startEdit(item: Item) {
		mode = 'edit';
		editing = item;
		photoOutcome = '';
		resetPhoto();
		panel?.scrollIntoView({ block: 'nearest' });
	}

	async function photoChanged(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) {
			resetPhoto();
			return;
		}
		photoError = '';
		try {
			const blob = await resizePhoto(file);
			if (previewUrl) URL.revokeObjectURL(previewUrl);
			photoBlob = blob;
			previewUrl = URL.createObjectURL(blob);
		} catch (err) {
			resetPhoto();
			photoError = `✕ ${err instanceof Error ? err.message : 'That photo could not be read.'}`;
		}
	}

	// The item fields go first; the photo follows in its own request, only once
	// the server has answered success and given (or confirmed) the item's id.
	const submitItem: SubmitFunction = ({ formData }) => {
		submitted = { source: 'panel', itemId: null };
		formData.delete('image');
		const held = photoBlob;
		const editedId = editing?.id ?? null;
		return async ({ result, update }) => {
			photoOutcome = '';
			if (result.type === 'success' && held) {
				const itemId =
					mode === 'add'
						? typeof result.data?.itemId === 'string'
							? result.data.itemId
							: null
						: editedId;
				if (itemId) {
					const upload = new FormData();
					upload.set('itemId', itemId);
					upload.set(
						'image',
						new File([held], held.type === 'image/webp' ? 'photo.webp' : 'photo.jpg', {
							type: held.type
						})
					);
					try {
						const response = await fetch('?/setImage', {
							method: 'POST',
							body: upload,
							headers: { 'x-sveltekit-action': 'true' }
						});
						// A manual fetch to an action needs deserialize: the body is devalue-encoded.
						const photo = deserialize(await response.text());
						if (photo.type !== 'success') {
							const message =
								photo.type === 'failure' && typeof photo.data?.message === 'string'
									? photo.data.message
									: 'the upload failed.';
							photoOutcome = `Item saved, but the photo was not: ${message}`;
						}
					} catch {
						photoOutcome = 'Item saved, but the photo was not: the upload failed.';
					}
				}
			}
			if (result.type === 'success') resetPhoto();
			await update();
			if (mode === 'edit' && editedId) {
				editing = data.items.find((item: Item) => item.id === editedId) ?? null;
				if (!editing) mode = 'add';
			}
		};
	};

	// A native <select> styled like Field's control (border-control-line: a control
	// edge, never the decorative border-line).
	const selectClass = 'border-control-line bg-bg text-ink rounded-control border px-3 py-2';
	const pillClass = (on: boolean) =>
		`rounded-full border px-4 py-2 font-medium ${
			on ? 'bg-accent text-accent-ink border-accent' : 'bg-raise text-ink border-control-line'
		}`;

	// The recipe editor for one item or modifier (tasks/inventory-cogs T-34).
	function recipeHref(kind: 'item' | 'modifier', id: string): string {
		return resolve('/inventory/recipes') + '?' + new URLSearchParams({ [kind]: id }).toString();
	}
</script>

<svelte:head>
	<title>Menu · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Catalogue"
	title="Menu"
	description="What the till sells: items with their prices and photos, the categories that group them, and the modifier groups that change them. A category and a photo are both optional. An item is archived, never deleted — it stays on past receipts and reports."
>
	{#snippet actions()}
		<Button type="button" variant="primary" onclick={startAdd}>Add item</Button>
	{/snippet}
</PageHeader>

<PageBody>
	<!-- EXACTLY ONE role="alert" region: the form's message, inside the card of
	     the form that produced it (messageFor), and nothing else. -->
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

	<div class="grid gap-6 lg:grid-cols-3">
		<!-- The photo grid: tiles on the page ground, so nothing nests in a card. -->
		<div class="flex min-w-0 flex-col gap-4 lg:col-span-2">
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
							<div
								class="bg-raise-2 text-ink-2 flex aspect-video w-full items-center justify-center"
							>
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
									<span class="text-ink text-right font-mono tabular-nums">{item.price ?? '—'}</span
									>
									<span class="text-ink-2 text-sm">Tax: {item.taxRate}</span>
								</div>
							</div>
							{#if item.groupIds.length > 0}
								<p class="text-ink-2 text-sm">
									Modifiers: {item.groupIds.map(groupName).join(', ')}
								</p>
							{/if}
							<!-- Cost and margin are READ-ONLY here: the recipe's cost at the stock
							     book's current averages, and the price net of tax minus it. -->
							<div class="text-ink-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
								<span>
									Cost
									<span
										class={`font-mono tabular-nums ${item.cost?.negative ? 'text-danger' : 'text-ink'}`}
									>
										{item.cost ? (item.cost.text ?? '—') : '—'}
									</span>
								</span>
								<span>
									Margin
									{#if item.margin?.unset}
										<span class="text-ink-2"
											>Set the tax mode and default rate in Settings › Tax</span
										>
									{:else}
										<span
											class={`font-mono tabular-nums ${item.margin?.negative ? 'text-danger' : 'text-ink'}`}
										>
											{item.margin ? (item.margin.text ?? '—') : '—'}
										</span>
									{/if}
								</span>
								{#if !item.cost}
									<span class="text-ink-2">No recipe yet</span>
								{/if}
								<!-- eslint-disable svelte/no-navigation-without-resolve -- the path IS resolve()d; the rule only accepts a bare resolve() call, and the owner id has to travel as a query string -->
								<a class="text-ink underline" href={recipeHref('item', item.id)}>Edit recipe</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</div>
							{#if messageFor('tile', item.id)}
								<Alert {tone}>{messageFor('tile', item.id)}</Alert>
							{/if}
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
								<div class="flex flex-wrap gap-2">
									<form
										method="POST"
										action="?/setAvailability"
										use:enhance={from('tile', item.id)}
									>
										<input type="hidden" name="itemId" value={item.id} />
										<input type="hidden" name="available" value={item.isAvailable ? 'no' : 'yes'} />
										<Button type="submit" variant="secondary">
											{item.isAvailable ? 'Mark sold out' : 'Mark available'}
										</Button>
									</form>
									<Button
										type="button"
										variant="secondary"
										aria-pressed={mode === 'edit' && editing?.id === item.id}
										onclick={() => startEdit(item)}>Edit</Button
									>
								</div>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		</div>

		<!-- THE panel: one Card, sticky beside the grid on wide screens. -->
		<div bind:this={panel} class="min-w-0 self-start lg:sticky lg:top-6">
			<Card>
				{#if messageFor('panel')}
					<div class="mb-4">
						<Alert {tone}>{messageFor('panel')}</Alert>
					</div>
				{/if}
				{#key editing?.id ?? 'add'}
					<!-- multipart: the form holds a file input, and SvelteKit's enhance refuses
					     to submit such a form in dev without it. The photo is still deleted
					     from the item's FormData in submitItem and uploaded separately. -->
					<form
						method="POST"
						enctype="multipart/form-data"
						action={mode === 'add' ? '?/createItem' : '?/updateItem'}
						class="flex flex-col gap-4"
						use:enhance={submitItem}
					>
						<h3 class="text-ink font-semibold">
							{mode === 'add' || !editing ? 'Add an item' : `Edit ${editing.name}`}
						</h3>
						{#if mode === 'edit' && editing}
							<input type="hidden" name="itemId" value={editing.id} />
						{/if}
						<Field
							id="panel-name"
							name="name"
							label="Item name"
							required
							maxlength="120"
							value={editing?.name ?? ''}
						/>
						<Field
							id="panel-price"
							name="price"
							label={mode === 'add' ? 'Price' : 'New price'}
							inputmode="decimal"
							required={mode === 'add'}
							disabled={!ready}
							hint={mode === 'edit' && editing
								? `Now ${editing.price ?? '—'}. Leave blank to keep it.`
								: priceHint}
						/>
						<SelectField
							id="panel-category"
							name="categoryId"
							label="Category"
							value={editing?.categoryId ?? ''}
							options={categoryOptions}
						/>
						<!-- Default ('' → null) FOLLOWS the restaurant's default rate even after it
						     changes; a named rate (its id) PINS the item to that rate. Two different
						     choices, never collapsed (T-32). The options are the server's: live
						     rates only, each labelled by the money module's formatter. -->
						<SelectField
							id="panel-rate"
							name="taxRateId"
							label="Tax rate"
							value={editing?.taxRateId ?? ''}
							options={data.rateOptions}
							hint="Default follows the restaurant's default rate, even after it changes. A named rate keeps this item on that rate."
						/>
						<div class="flex flex-col gap-1">
							<label class="text-ink-2 text-sm font-medium" for="panel-photo">Photo</label>
							{#if previewUrl}
								<img
									src={previewUrl}
									alt=""
									class="rounded-control aspect-video w-full object-cover"
								/>
							{:else if mode === 'edit' && editing?.imageUrl}
								<img
									src={editing.imageUrl}
									alt=""
									class="rounded-control aspect-video w-full object-cover"
								/>
							{/if}
							<input
								id="panel-photo"
								name="image"
								type="file"
								accept="image/jpeg,image/png,image/webp"
								class="text-ink"
								onchange={photoChanged}
							/>
							<p class="text-ink-2 text-sm">
								Optional. Resized in your browser to at most 400 KB before it is sent.
							</p>
							{#if photoError}
								<p class="text-danger">{photoError}</p>
							{/if}
						</div>
						<div class="flex flex-wrap gap-2">
							<Button
								type="submit"
								variant="secondary"
								disabled={!ready}
								disabledReason={NO_CURRENCY}>Save item</Button
							>
							{#if mode === 'edit'}
								<Button type="button" variant="ghost" onclick={startAdd}>Cancel</Button>
							{/if}
						</div>
						{#if photoOutcome}
							<p class="text-danger">✕ {photoOutcome}</p>
						{/if}
					</form>

					{#if mode === 'edit' && editing}
						<div class="border-line mt-4 flex flex-col gap-4 border-t pt-4">
							{#if editing.imageUrl}
								<form method="POST" action="?/removeImage" use:enhance={from('panel')}>
									<input type="hidden" name="itemId" value={editing.id} />
									<Button type="submit" variant="secondary">Remove photo</Button>
								</form>
							{/if}

							<div class="flex flex-col gap-2">
								<h4 class="text-ink font-medium">Modifier groups</h4>
								{#if editing.groupIds.length === 0}
									<p class="text-ink-2 text-sm">None attached.</p>
								{/if}
								<ul class="flex flex-col gap-1">
									{#each editing.groupIds as groupId (groupId)}
										<li class="flex items-center justify-between gap-2">
											<span class="text-ink-2 text-sm">{groupName(groupId)}</span>
											<form method="POST" action="?/unlinkGroup" use:enhance={from('panel')}>
												<input type="hidden" name="itemId" value={editing.id} />
												<input type="hidden" name="groupId" value={groupId} />
												<Button type="submit" variant="ghost" disabled={!ready}>Detach</Button>
											</form>
										</li>
									{/each}
								</ul>
								{#if data.groups.length > 0}
									<form
										method="POST"
										action="?/linkGroup"
										class="flex flex-wrap items-end gap-2"
										use:enhance={from('panel')}
									>
										<input type="hidden" name="itemId" value={editing.id} />
										<label class="text-ink-2 text-sm" for="panel-link">Modifier group</label>
										<select id="panel-link" name="groupId" class={selectClass}>
											{#each data.groups as group (group.id)}
												<option value={group.id}>{group.name}</option>
											{/each}
										</select>
										<Button type="submit" variant="secondary" disabled={!ready}>Attach</Button>
									</form>
								{/if}
							</div>

							<!-- Archive, never delete: no delete control exists on this page. -->
							<details>
								<summary class="text-danger cursor-pointer text-sm">Archive {editing.name}…</summary
								>
								<div class="mt-2 flex flex-col gap-2">
									<p class="text-ink-2 text-sm">
										It leaves the till and this page, and stays on past receipts and reports.
									</p>
									<form method="POST" action="?/archiveItem" use:enhance={from('panel')}>
										<input type="hidden" name="itemId" value={editing.id} />
										<Button type="submit" variant="danger" disabled={!ready}>Archive item</Button>
									</form>
								</div>
							</details>
						</div>
					{/if}
				{/key}
			</Card>
		</div>
	</div>

	<div class="grid gap-5 lg:grid-cols-2">
		<Card>
			<div class="flex flex-col gap-4">
				<h3 class="text-ink font-semibold">Categories</h3>
				{#if messageFor('categories')}
					<Alert {tone}>{messageFor('categories')}</Alert>
				{/if}
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
								use:enhance={from('categories')}
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
									<form method="POST" action="?/archiveCategory" use:enhance={from('categories')}>
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
			<form
				method="POST"
				action="?/createCategory"
				class="flex flex-col gap-4"
				use:enhance={from('addCategory')}
			>
				<h3 class="text-ink font-semibold">Add a category</h3>
				{#if messageFor('addCategory')}
					<Alert {tone}>{messageFor('addCategory')}</Alert>
				{/if}
				<Field id="category-name" name="name" label="Category name" required />
				<div>
					<Button type="submit" variant="secondary" disabled={!ready} disabledReason={NO_CURRENCY}
						>Add category</Button
					>
				</div>
			</form>
		</Card>
	</div>

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
								<span class="text-ink-2 text-sm">
									Cost
									<span
										class={`font-mono tabular-nums ${modifier.cost?.negative ? 'text-danger' : 'text-ink'}`}
									>
										{modifier.cost ? (modifier.cost.text ?? '—') : '—'}
									</span>
								</span>
								<!-- eslint-disable svelte/no-navigation-without-resolve -- the path IS resolve()d; the rule only accepts a bare resolve() call, and the owner id has to travel as a query string -->
								<a class="text-ink text-sm underline" href={recipeHref('modifier', modifier.id)}>
									Edit recipe
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</Card>

	<div class="grid gap-5 lg:grid-cols-2">
		<Card>
			<form
				method="POST"
				action="?/createModifierGroup"
				class="flex flex-col gap-4"
				use:enhance={from('addGroup')}
			>
				<h3 class="text-ink font-semibold">Add a modifier group</h3>
				{#if messageFor('addGroup')}
					<Alert {tone}>{messageFor('addGroup')}</Alert>
				{/if}
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
					<Button type="submit" variant="secondary" disabled={!ready} disabledReason={NO_CURRENCY}
						>Add group</Button
					>
				</div>
			</form>
		</Card>

		<Card>
			<form
				method="POST"
				action="?/createModifier"
				class="flex flex-col gap-4"
				use:enhance={from('addModifier')}
			>
				<h3 class="text-ink font-semibold">Add a modifier</h3>
				{#if messageFor('addModifier')}
					<Alert {tone}>{messageFor('addModifier')}</Alert>
				{/if}
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
						variant="secondary"
						disabled={!ready || data.groups.length === 0}
						disabledReason={ready ? 'Add a modifier group first.' : NO_CURRENCY}
						>Add modifier</Button
					>
				</div>
			</form>
		</Card>
	</div>
</PageBody>
