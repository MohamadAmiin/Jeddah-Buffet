<script lang="ts">
	// ONE CUSTOMER. It renders what the server sends and computes nothing: every
	// amount is the formatter's string. Nothing here edits a posted record — a
	// payment is REVERSED with a reason, and it stays on the statement marked ↩
	// (colour never alone). Charges and payments are made on the till, not here.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		Alert,
		Button,
		Card,
		Field,
		PageBody,
		PageColumns,
		PageHeader,
		Table
	} from '$lib/components/ui';

	let { data, form } = $props();

	const tone = $derived(page.status === 200 ? 'success' : 'danger');
	let submitting = $state(false);

	// WHICH form produced `form.message`, so its Alert renders in that form's card.
	type Source = 'update' | 'archive' | 'restore' | 'reversePayment';
	let submitted = $state<Source | null>(null);
	const fromUrl = $derived(page.url.search.startsWith('?/') ? page.url.search.slice(2) : '');
	const source = $derived<Source>(
		submitted ??
			(fromUrl === 'update' || fromUrl === 'archive' || fromUrl === 'restore'
				? fromUrl
				: 'reversePayment')
	);
	const messageFor = (from: Source) => (form?.message && source === from ? form.message : '');

	const guard = (from: Source) => () => {
		submitting = true;
		submitted = from;
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			submitting = false;
		};
	};

	const columns = [
		{ key: 'businessDate', label: 'Business date' },
		{ key: 'what', label: 'What' },
		{ key: 'cashier', label: 'By' },
		{ key: 'till', label: 'Till' },
		{ key: 'amount', label: 'Amount', numeric: true },
		{ key: 'balance', label: 'Balance', numeric: true },
		{ key: 'action', label: '' }
	];
</script>

<svelte:head>
	<title>{data.customer.name} · matcami</title>
</svelte:head>

<PageHeader
	crumbs={[{ label: 'Customers', href: resolve('/customers') }]}
	title={data.customer.name}
/>

<PageBody>
	<PageColumns showAside>
		<Card>
			<dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
				<div>
					<dt class="text-ink-2 text-xs">Phone</dt>
					<dd class="text-ink font-mono">{data.customer.phone}</dd>
				</div>
				<div>
					<dt class="text-ink-2 text-xs">Owes</dt>
					<dd class="text-ink font-mono font-medium tabular-nums" data-testid="customer-balance">
						{data.customer.balance ?? '—'}
					</dd>
				</div>
				<div>
					<dt class="text-ink-2 text-xs">Credit limit</dt>
					<dd class="text-ink font-mono tabular-nums">{data.customer.limit ?? 'No limit'}</dd>
				</div>
				<div>
					<dt class="text-ink-2 text-xs">Status</dt>
					<dd class="text-ink">
						{#if data.customer.archived}
							<span aria-hidden="true" class="font-mono">◐</span> archived
						{:else}
							<span aria-hidden="true" class="font-mono">●</span> active
						{/if}
					</dd>
				</div>
			</dl>
		</Card>

		<Card>
			<div class="flex flex-col gap-2">
				<h3 class="text-section text-ink">Statement</h3>
				<p class="text-ink-2 text-sm">
					Every bill charged to this customer and every payment received, oldest first. Bills are
					charged and payments received on the till.
				</p>
				{#if messageFor('reversePayment')}
					<Alert {tone}>{messageFor('reversePayment')}</Alert>
				{/if}
				<Table
					caption="Customer statement"
					{columns}
					rows={data.statement}
					empty="Nothing has been charged to this customer yet."
				>
					{#snippet cell(row, key)}
						{#if key === 'businessDate'}
							<span class="text-ink">{row.businessDate}</span>
						{:else if key === 'what'}
							<span class="text-ink">
								{#if row.kind === 'reversal'}<span aria-hidden="true" class="font-mono">↩</span>
								{/if}{row.what}{#if row.reversed}
									<span class="text-ink-2">
										— <span aria-hidden="true" class="font-mono">↩</span> reversed</span
									>{/if}
							</span>
						{:else if key === 'cashier'}
							<span class="text-ink">{row.cashier}</span>
						{:else if key === 'till'}
							<span class="text-ink font-mono">{row.till}</span>
						{:else if key === 'amount'}
							<span class={row.reversed ? 'text-ink-2 line-through' : 'text-ink'}>
								{row.amount ?? '—'}
							</span>
						{:else if key === 'balance'}
							<span class="text-ink">{row.balance ?? '—'}</span>
						{:else if key === 'action'}
							{#if row.paymentId !== null && row.reversible}
								<details>
									<summary class="text-ink cursor-pointer text-sm underline">Reverse…</summary>
									<form
										method="POST"
										action="?/reversePayment"
										class="mt-2 flex flex-wrap items-end gap-2"
										use:enhance={guard('reversePayment')}
									>
										<input type="hidden" name="paymentId" value={row.paymentId} />
										<Field
											id={`reason-${row.paymentId}`}
											name="reason"
											label="Reason for reversing"
											required
											minlength={3}
											maxlength={200}
										/>
										<Button type="submit" variant="secondary" disabled={submitting}>
											{submitting ? 'Saving…' : 'Reverse payment'}
										</Button>
									</form>
								</details>
							{:else if row.paymentId !== null}
								<span class="text-ink-2 text-sm">Cash — its shift is closed</span>
							{/if}
						{/if}
					{/snippet}
				</Table>
			</div>
		</Card>

		{#snippet aside()}
			<Card>
				<form
					method="POST"
					action="?/update"
					class="flex flex-col gap-4"
					use:enhance={guard('update')}
				>
					<h3 class="text-section text-ink">Details</h3>
					{#if messageFor('update')}
						<Alert {tone}>{messageFor('update')}</Alert>
					{/if}
					<Field
						id="customer-name"
						name="name"
						label="Name"
						required
						maxlength={80}
						value={data.customer.name}
					/>
					<Field
						id="customer-phone"
						name="phone"
						label="Phone"
						required
						maxlength={32}
						inputmode="tel"
						value={data.customer.phone}
					/>
					<Field
						id="customer-limit"
						name="creditLimit"
						label="Credit limit"
						inputmode="decimal"
						numeric
						value={data.customer.limitInput}
						disabled={data.currency === null}
						hint={data.currency
							? `In ${data.currency.code}. Leave empty for no limit.`
							: 'Set the currency in Settings before entering a limit.'}
					/>
					<div>
						<Button type="submit" variant="primary" disabled={submitting}>
							{submitting ? 'Saving…' : 'Save'}
						</Button>
					</div>
				</form>
			</Card>

			<Card>
				{#if data.customer.archived}
					<form
						method="POST"
						action="?/restore"
						class="flex flex-col gap-3"
						use:enhance={guard('restore')}
					>
						<h3 class="text-section text-ink">Restore</h3>
						<p class="text-ink-2 text-sm">
							An archived customer cannot be charged. Restoring puts them back on the till's list.
						</p>
						{#if messageFor('restore')}
							<Alert {tone}>{messageFor('restore')}</Alert>
						{/if}
						<div>
							<Button type="submit" variant="secondary" disabled={submitting}
								>Restore customer</Button
							>
						</div>
					</form>
				{:else}
					<form
						method="POST"
						action="?/archive"
						class="flex flex-col gap-3"
						use:enhance={guard('archive')}
					>
						<h3 class="text-section text-ink">Archive</h3>
						<p class="text-ink-2 text-sm">
							Takes the customer off the till's list. Only a customer who owes nothing can be
							archived; nothing is deleted.
						</p>
						{#if messageFor('archive')}
							<Alert {tone}>{messageFor('archive')}</Alert>
						{/if}
						<div>
							<Button type="submit" variant="secondary" disabled={submitting}
								>Archive customer</Button
							>
						</div>
					</form>
				{/if}
			</Card>
		{/snippet}
	</PageColumns>
</PageBody>
