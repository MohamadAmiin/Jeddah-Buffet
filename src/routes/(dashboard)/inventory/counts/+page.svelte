<script lang="ts">
	// THE STOCK COUNTS PAGE. It renders what the server sends and computes nothing.
	// A blank counted field means "not counted": partial counts are normal. While a
	// blocker stands, the Alert says why and the submit Button says so too.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader, Table } from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	const blocked = $derived(data.blockers.length > 0);
	const blockedReason = $derived(data.blockers.join(' '));

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
</script>

<svelte:head>
	<title>Stock counts · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Inventory"
	title="Stock counts"
	description="Count what is on the shelf after the shift. The difference from the stock book is posted at the average cost."
/>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<p class="text-ink-2 text-sm">
		<a class="text-ink underline" href={resolve('/inventory')}>Back to inventory</a>
	</p>

	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	{#if blocked}
		<div class="max-w-form">
			<Alert tone="danger">
				{#each data.blockers as message (message)}
					<span class="block">{message}</span>
				{/each}
			</Alert>
		</div>
	{/if}

	<Card>
		<form
			method="POST"
			action="?/post"
			class="flex flex-col gap-4"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<h3 class="text-ink font-semibold">New count</h3>
			<p class="text-ink-2 text-sm">
				Leave an ingredient blank when you did not count it. Quantities are in each ingredient's
				base unit.
			</p>
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
							<span class="text-danger block text-sm">◆ below zero</span>
						{/if}
					{:else if key === 'counted'}
						<input type="hidden" name="ingredientId" value={row.id} />
						<span class="flex items-center gap-2">
							<input
								name="countedQty"
								inputmode="decimal"
								maxlength={20}
								aria-label={`${row.name}, counted in ${row.baseUnit}`}
								class="border-control-line bg-bg text-ink rounded-control w-32 border px-3 py-2 font-mono tabular-nums"
							/>
							<span class="text-ink-2 text-sm">{row.baseUnit}</span>
						</span>
					{/if}
				{/snippet}
			</Table>
			<div class="max-w-form flex flex-col gap-4">
				<Field id="count-note" name="note" label="Note" maxlength={200} />
				<Field
					id="count-date"
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
						disabled={submitting || blocked || data.ingredients.length === 0}
						disabledReason={blocked
							? blockedReason
							: data.ingredients.length === 0
								? 'Add an ingredient first.'
								: ''}
					>
						{submitting ? 'Saving…' : 'Post count'}
					</Button>
				</div>
			</div>
		</form>
	</Card>

	<Card>
		<div class="flex flex-col gap-2">
			<h3 class="text-ink font-semibold">Past counts</h3>
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
	</Card>
</div>
