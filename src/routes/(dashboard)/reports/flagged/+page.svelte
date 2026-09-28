<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';

	let { data, form } = $props();
</script>

<svelte:head><title>Sales awaiting review · matcami</title></svelte:head>

<PageHeader
	title="Sales awaiting review"
	description="A synced sale that fails validation is stored and flagged for your review, never discarded. Retry runs it again under the same operation key; dismiss records your reason."
/>

<div class="flex max-w-6xl flex-col gap-8 px-4 pt-8 pb-16 lg:px-7">
	{#if data.notice}
		<Alert tone="info">{data.notice}</Alert>
	{/if}

	{#if data.ops.length === 0}
		<Card>
			<p class="text-body text-ink-2">
				<span aria-hidden="true" class="text-ok font-mono">●</span> Nothing awaits review.
			</p>
		</Card>
	{:else}
		<Card>
			<ul class="divide-line-soft divide-y">
				{#each data.ops as op (op.id)}
					<li class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
						<p class="text-sm font-medium">
							{#if op.status === 'unrecorded'}
								<span aria-hidden="true" class="text-st-offline font-mono">◆</span> Not recorded
							{:else}
								<span aria-hidden="true" class="text-st-billed font-mono">▲</span> Recorded, flagged
							{/if}
						</p>
						<dl class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
							<div>
								<dt class="text-eyebrow text-ink-3 uppercase">When</dt>
								<dd>{op.occurred}</dd>
							</div>
							<div>
								<dt class="text-eyebrow text-ink-3 uppercase">Business date</dt>
								<dd>{op.businessDate ?? '—'}</dd>
							</div>
							<div>
								<dt class="text-eyebrow text-ink-3 uppercase">Kind</dt>
								<dd>{op.kind}</dd>
							</div>
							<div>
								<dt class="text-eyebrow text-ink-3 uppercase">Invoice</dt>
								<dd class="font-mono">{op.invoiceNumber ?? '—'}</dd>
							</div>
							<div>
								<dt class="text-eyebrow text-ink-3 uppercase">Employee</dt>
								<dd>{op.employeeName}</dd>
							</div>
							<div>
								<dt class="text-eyebrow text-ink-3 uppercase">Flag</dt>
								<dd class="font-mono">{op.flag ?? '—'}</dd>
							</div>
							{#if op.error}
								<div class="col-span-2 sm:col-span-4">
									<dt class="text-eyebrow text-ink-3 uppercase">Error</dt>
									<dd class="text-danger">{op.error}</dd>
								</div>
							{/if}
						</dl>
						<div class="text-sm">
							<ul>
								{#each op.summary.lines as line, i (i)}
									<li>{line}</li>
								{/each}
							</ul>
							{#if op.summary.total}
								<p>Total <span class="font-mono tabular-nums">{op.summary.total}</span></p>
							{/if}
							{#if op.summary.tender}
								<p>Tender <span class="font-mono tabular-nums">{op.summary.tender}</span></p>
							{/if}
						</div>
						<div class="flex flex-wrap items-end gap-3">
							{#if op.retryable}
								<form method="POST" action="?/retry" use:enhance>
									<input type="hidden" name="opId" value={op.id} />
									<Button type="submit" variant="secondary">Retry</Button>
								</form>
							{/if}
							<form method="POST" action="?/dismiss" use:enhance class="flex items-end gap-2">
								<input type="hidden" name="opId" value={op.id} />
								<Field id={'reason-' + op.id} name="reason" label="Reason" required minlength={3} />
								<Button type="submit" variant="danger">Dismiss</Button>
							</form>
						</div>
						{#if form?.message && form.opId === op.id}
							<p class="text-danger text-sm">{form.message}</p>
						{/if}
					</li>
				{/each}
			</ul>
			{#if form?.message && form.opId === null}
				<p class="text-danger mt-4 text-sm">{form.message}</p>
			{/if}
			<p class="text-caption text-ink-2 mt-4">
				Dismissing a sale that was not recorded leaves an explained hole in the till's invoice
				sequence: its number stays on the customer's receipt, nothing on the server will ever carry
				it, and the reason you give is the explanation.
			</p>
		</Card>
	{/if}
</div>
