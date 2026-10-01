<script lang="ts">
	// THE STOCK COUNTS PAGE. It renders what the server sends and computes nothing.
	// A blank counted field means "not counted": partial counts are normal. While a
	// blocker stands, Post count is disabled and says why, in the blockers' words.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		ActionBar,
		Alert,
		Button,
		Card,
		Field,
		PageBody,
		PageHeader,
		Table
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	const blocked = $derived(data.blockers.length > 0);
	const blockedReason = $derived(data.blockers.join(' '));
	const FORM_ID = 'count-form';

	const countColumns = [
		{ key: 'name', label: 'Ingredient' },
		{ key: 'system', label: 'In the stock book', numeric: true },
		{ key: 'counted', label: 'Counted' }
	];
	const historyColumns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'lineCount', label: 'Ingredients counted', numeric: true },
		{ key: 'shortfall', label: 'Shortfall', numeric: true },
		{ key: 'surplus', label: 'Surplus', numeric: true },
		{ key: 'note', label: 'Note' }
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
	<title>Stock counts · matcami</title>
</svelte:head>

<PageHeader
	crumbs={[{ label: 'Inventory', href: resolve('/inventory') }]}
	title="Stock counts"
	description="Count what is on the shelf after the shift. The difference from the stock book is posted at the average cost."
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
	<form
		id={FORM_ID}
		method="POST"
		action="?/post"
		class="flex flex-col gap-6"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
	>
		<section aria-labelledby="new-count-h" class={TABLE_CARD}>
			<div class="flex flex-col gap-1 px-6 py-4">
				<h3 id="new-count-h" class="text-section">New count</h3>
				<p class="text-caption text-ink-2">
					Leave an ingredient blank when you did not count it. Quantities are in each ingredient's
					base unit.
				</p>
			</div>
			<div class="px-6 md:px-0">
				<Table
					caption="Ingredients to count"
					columns={countColumns}
					rows={data.ingredients}
					empty="No ingredients yet. Add them on the Inventory page."
				>
					{#snippet cell(row, key)}
						{#if key === 'name'}
							<span class="text-ink font-medium">{row.name}</span>
						{:else if key === 'system'}
							<span class={row.negative ? 'text-danger' : 'text-ink'}>{row.system}</span>
							{#if row.negative}
								<span class="text-danger block font-sans text-sm"
									><span aria-hidden="true" class="font-mono">◆</span> below zero</span
								>
							{/if}
						{:else if key === 'counted'}
							<input type="hidden" name="ingredientId" value={row.id} />
							<div class="w-40">
								<Field
									id={`count-${row.id}`}
									name="countedQty"
									label={`${row.name}, counted in ${row.baseUnit}`}
									numeric
									inputmode="decimal"
									maxlength={20}
									autocomplete="off"
								/>
							</div>
						{/if}
					{/snippet}
				</Table>
			</div>
		</section>

		<Card>
			<div class="grid gap-4 md:grid-cols-2">
				<Field id="count-note" name="note" label="Note" maxlength={200} />
				<Field
					id="count-date"
					name="businessDate"
					label="Business date"
					type="date"
					required
					value={data.today}
				/>
			</div>
		</Card>
	</form>

	<section aria-labelledby="past-counts-h" class={TABLE_CARD}>
		<div class="px-6 py-4">
			<h3 id="past-counts-h" class="text-section">Past counts</h3>
		</div>
		<div class="px-6 md:px-0">
			<Table
				caption="Past counts"
				columns={historyColumns}
				rows={data.counts}
				empty="No count has been posted yet."
			>
				{#snippet cell(row, key)}
					{#if key === 'businessDate'}
						<a class="text-ink underline" href={resolve(`/inventory/counts/${row.id}`)}>
							{row.businessDate}
						</a>
					{:else if key === 'lineCount'}
						<span class="text-ink">{row.lineCount}</span>
					{:else if key === 'shortfall'}
						<span class="text-ink">{row.shortfall ?? '—'}</span>
					{:else if key === 'surplus'}
						<span class="text-ink">{row.surplus ?? '—'}</span>
					{:else if key === 'note'}
						<span class="text-ink-2">{row.note ?? ''}</span>
					{/if}
				{/snippet}
			</Table>
		</div>
	</section>
</PageBody>

<ActionBar>
	{#snippet message()}
		{#if form?.message}
			<Alert {tone}>{form.message}</Alert>
		{:else}
			<p class="text-caption text-ink-2">
				Blank fields are not counted. The difference is posted at the average cost.
			</p>
		{/if}
	{/snippet}
	<Button
		type="submit"
		form={FORM_ID}
		variant="primary"
		disabled={submitting || blocked || data.ingredients.length === 0}
		disabledReason={blocked
			? blockedReason
			: data.ingredients.length === 0
				? 'Add an ingredient first.'
				: ''}
	>
		{submitting ? 'Saving…' : 'Post count'}
	</Button>
</ActionBar>
