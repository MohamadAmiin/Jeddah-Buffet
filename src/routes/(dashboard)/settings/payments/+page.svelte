<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { SubmitFunction } from '@sveltejs/kit';
	import {
		Alert,
		Button,
		Card,
		CheckField,
		CreatePanel,
		Field,
		PageBody,
		PageColumns,
		PageHeader,
		SelectField,
		StatusMark
	} from '$lib/components/ui';
	import { settingsSections, SETTINGS_SECTION_LINK } from '../sections';

	let { data, form } = $props();

	// Every action returns a `message` on BOTH paths — success, or fail(400). The
	// tone follows the outcome: page.status is 400 after a fail() and 200 otherwise.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// Card or mobile ONLY — never cash, which is the one built-in row
	// (payment_methods_one_cash). No type is preselected on purpose: a kind is
	// permanent (migration 0017's trigger refuses a change), so the owner chooses it.
	const KIND_OPTIONS = [
		{ value: 'mobile', label: 'Mobile money' },
		{ value: 'card', label: 'Card terminal' }
	];

	// Which form produced `form`, so its outcome renders inside that form's card
	// (the roles page's idiom). With JavaScript the enhance callback records the
	// action and the method; without it, only the action is known (the POST lands
	// on this URL with it as the search).
	let submitted = $state<{ action: string; methodId: string } | null>(null);
	const lastAction = $derived(submitted?.action ?? page.url.search);
	const lastMethodId = $derived(submitted?.methodId ?? '');
	function track({ action, formData }: { action: URL; formData: FormData }) {
		submitted = { action: action.search, methodId: String(formData.get('methodId') ?? '') };
	}
	// reset: false — a reset would put the fields back as first rendered, and the
	// checkbox would snap away from the value the owner just saved.
	const keepValues: SubmitFunction = (input) => {
		track(input);
		return async ({ update }) => {
			await update({ reset: false });
		};
	};

	// AT MOST ONE Alert is visible at a time: the conditions below are mutually
	// exclusive by construction. The e2e suite reads a single page.getByRole('alert').
	const hasResult = $derived(form?.message !== undefined);
	const createResult = $derived(hasResult && lastAction === '?/create');
	const methodResultId = $derived(
		hasResult &&
			(lastAction === '?/update' || lastAction === '?/move' || lastAction === '?/archive')
			? lastMethodId
			: ''
	);
	const liveResult = $derived(
		methodResultId !== '' && data.methods.some((method) => method.id === methodResultId)
	);
	// An archived method's result belongs to the archived list, where the method now is.
	const archivedResult = $derived(
		methodResultId !== '' && data.archived.some((method) => method.id === methodResultId)
	);
	// A no-JavaScript submit names no method: its result shows above the cards.
	const unplacedResult = $derived(hasResult && !createResult && !liveResult && !archivedResult);

	// The create panel: open below xl on ?add=1, when there is no owner method yet,
	// or when the create form has just produced a result.
	let opened = $state(false);
	const asideOpen = $derived(
		opened || page.url.searchParams.get('add') === '1' || data.methods.length === 0 || createResult
	);

	async function openPanel(event: MouseEvent) {
		event.preventDefault();
		opened = true;
		await tick();
		document.getElementById('new-method-name')?.focus();
	}
</script>

<svelte:head>
	<title>Payment methods · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Setup"
	title="Payment methods"
	description="Cash is built in. Add each card terminal and mobile-money service you take. Every mobile-money method posts to 1030 Payment Clearing – Mobile Money and every card method to 1020 Payment Clearing – Card; the till offers them only while it is online."
>
	{#snippet actions()}
		<Button
			href="?add=1#add-payment-method"
			variant="primary"
			class="xl:hidden"
			onclick={openPanel}
		>
			Add payment method
		</Button>
	{/snippet}
	{#snippet below()}
		<!-- The settings sub-navigation (gate decision 8). EXACT match only: every
		     /settings/<page> starts with /settings/, so a prefix rule would light
		     General on all four pages. -->
		<nav aria-label="Settings sections" class="-mb-4 flex flex-wrap gap-x-6 gap-y-1 lg:-mb-5">
			{#each settingsSections() as link (link.href)}
				{@const here = page.url.pathname === link.href}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- every href above is a resolve() result -->
				<a
					href={link.href}
					class={SETTINGS_SECTION_LINK}
					aria-current={here ? 'page' : undefined}
					data-current={here ? '' : undefined}>{link.label}</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}
		</nav>
	{/snippet}
</PageHeader>

<PageBody>
	<PageColumns collapsible {asideOpen}>
		{#if unplacedResult}
			<Alert {tone}>{form?.message}</Alert>
		{/if}

		<!-- Cash: the one built-in row. NO form and no controls — it is always
		     enabled, never archived and has no number (payment_methods_cash_rules). -->
		<Card class="flex flex-col gap-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h3 class="text-section">{data.cash?.name ?? 'Cash'}</h3>
				<StatusMark status="done" label="always accepted" />
			</div>
			<p class="text-body text-ink-2">
				Built in. Cash sales open the drawer and count toward the shift's expected cash.
			</p>
		</Card>

		<!-- One card per live owner method. The fields are labelled Name, Number and
		     Offered at the till, NOT Method name / Merchant number / Accepted at the
		     till: Playwright's getByLabel matches substrings, and the create panel owns
		     those three labels. -->
		<div class="grid items-start gap-6 lg:grid-cols-2">
			{#each data.methods as method (method.id)}
				<Card class="flex flex-col gap-4">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<h3 class="text-section">{method.name}</h3>
						{#if method.enabled}
							<StatusMark status="done" label="offered at the till" />
						{:else}
							<StatusMark status="not-started" label="not offered" />
						{/if}
					</div>

					<div class="flex flex-col gap-1">
						<!-- The kind is FIXED: it decides the ledger account and the offline
						     rule, so there is no control for it, only the words. -->
						<p class="text-sm font-medium">{method.kindLabel}</p>
						<p class="text-ink-2 text-xs">
							The type cannot be changed. Archive the method and add a new one instead.
						</p>
					</div>

					{#if method.merchantNumber}
						<p class="font-mono text-sm tabular-nums">{method.merchantNumber}</p>
					{:else}
						<p class="text-ink-2 text-sm">No merchant number.</p>
					{/if}

					{#if methodResultId === method.id}
						<Alert {tone}>{form?.message}</Alert>
					{/if}

					<form
						method="POST"
						action="?/update"
						class="flex flex-col gap-4"
						use:enhance={keepValues}
					>
						<input type="hidden" name="methodId" value={method.id} />
						<Field
							id={`method-${method.id}-name`}
							name="name"
							label="Name"
							value={method.name}
							required
						/>
						<Field
							id={`method-${method.id}-number`}
							name="merchantNumber"
							label="Number"
							maxlength={40}
							value={method.merchantNumber ?? ''}
							hint="Your own number customers send money to. Printed on every receipt."
						/>
						<CheckField
							id={`method-${method.id}-enabled`}
							name="enabled"
							value="yes"
							label="Offered at the till"
							checked={method.enabled}
						/>
						<div>
							<Button type="submit">Save method</Button>
						</div>
					</form>

					<!-- The till's order: two forms, one per direction. A disabled key says why. -->
					<div class="border-line-soft flex flex-wrap items-start gap-3 border-t pt-4">
						<form
							method="POST"
							action="?/move"
							class="flex flex-col gap-1"
							use:enhance={keepValues}
						>
							<input type="hidden" name="methodId" value={method.id} />
							<input type="hidden" name="direction" value="up" />
							<Button type="submit" disabled={method.first} disabledReason="Already first.">
								Move up
							</Button>
						</form>
						<form
							method="POST"
							action="?/move"
							class="flex flex-col gap-1"
							use:enhance={keepValues}
						>
							<input type="hidden" name="methodId" value={method.id} />
							<input type="hidden" name="direction" value="down" />
							<Button type="submit" disabled={method.last} disabledReason="Already last.">
								Move down
							</Button>
						</form>
					</div>

					<div class="border-line-soft border-t pt-4">
						<form
							method="POST"
							action="?/archive"
							class="flex flex-col gap-2"
							use:enhance={keepValues}
						>
							<input type="hidden" name="methodId" value={method.id} />
							<input type="hidden" name="name" value={method.name} />
							<div>
								<Button type="submit" variant="danger">Archive</Button>
							</div>
							<p class="text-ink-2 text-xs">
								Archived methods leave the till; past sales keep the name.
							</p>
						</form>
					</div>
				</Card>
			{/each}
		</div>

		<Card class="flex flex-col gap-4">
			<h3 class="text-section">Archived methods</h3>

			{#if archivedResult}
				<Alert {tone}>{form?.message}</Alert>
			{/if}

			<div class="flex flex-col gap-3">
				{#if data.archived.length > 0}
					{#each data.archived as method (method.id)}
						<div class="flex flex-wrap items-center justify-between gap-3">
							<span class="text-ink-2">{method.name} · {method.kindLabel}</span>
							<StatusMark status="blocked" label="archived" />
						</div>
					{/each}
				{:else}
					<p class="text-ink-2 text-sm">None.</p>
				{/if}
			</div>
		</Card>

		{#snippet aside()}
			<CreatePanel id="add-payment-method" title="Add payment method">
				<form method="POST" action="?/create" class="flex flex-col gap-4" use:enhance={track}>
					{#if createResult}
						<Alert {tone}>{form?.message}</Alert>
					{/if}

					<Field id="new-method-name" name="name" label="Method name" required />
					<SelectField
						id="new-method-kind"
						name="kind"
						label="Method type"
						options={KIND_OPTIONS}
						value=""
						placeholder="Choose a type"
						required
						hint="Fixed once added — archive the method to change it."
					/>
					<Field
						id="new-method-number"
						name="merchantNumber"
						label="Merchant number"
						maxlength={40}
						hint="For example 61 234 5678. Leave blank for a card terminal."
					/>
					<CheckField
						id="new-method-enabled"
						name="enabled"
						value="yes"
						label="Accepted at the till"
						checked
					/>

					<div>
						<Button type="submit" variant="primary">Add method</Button>
					</div>
				</form>
			</CreatePanel>
		{/snippet}
	</PageColumns>
</PageBody>
