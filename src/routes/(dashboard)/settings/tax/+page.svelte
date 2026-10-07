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

	const liveRates = $derived(data.rates.filter((rate) => !rate.archived));
	const archivedRates = $derived(data.rates.filter((rate) => rate.archived));

	// The two modes come from the money module's list (the load's taxModes); only
	// the words are here. No mode is preselected: "Not chosen" until the owner picks.
	const MODE_LABELS: Record<'exclusive' | 'inclusive', string> = {
		exclusive: 'Prices exclude tax (exclusive)',
		inclusive: 'Prices include tax (inclusive)'
	};
	const modeOptions = $derived(
		data.taxModes.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))
	);
	const rateOptions = $derived(liveRates.map((rate) => ({ value: rate.id, label: rate.label })));

	// Which form produced `form`, so its outcome renders inside that form's card
	// (the roles page's idiom). With JavaScript the enhance callback records the
	// action and the rate; without it, only the action is known (the POST lands on
	// this URL with it as the search).
	let submitted = $state<{ action: string; taxRateId: string } | null>(null);
	const lastAction = $derived(submitted?.action ?? page.url.search);
	const lastRateId = $derived(submitted?.taxRateId ?? '');
	function track({ action, formData }: { action: URL; formData: FormData }) {
		submitted = { action: action.search, taxRateId: String(formData.get('taxRateId') ?? '') };
	}
	// reset: false — a reset would put the fields back as first rendered, and the
	// select would snap away from the value the owner just saved.
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
	const chargeResult = $derived(
		hasResult && (lastAction === '?/mode' || lastAction === '?/setDefault')
	);
	const rateResultId = $derived(
		hasResult && (lastAction === '?/update' || lastAction === '?/archive') ? lastRateId : ''
	);
	const liveResult = $derived(
		rateResultId !== '' && liveRates.some((rate) => rate.id === rateResultId)
	);
	// An archived rate's result belongs to the archived list, where the rate now is.
	const archivedResult = $derived(
		rateResultId !== '' && archivedRates.some((rate) => rate.id === rateResultId)
	);
	// A no-JavaScript submit names no rate: its result shows above the cards.
	const unplacedResult = $derived(
		hasResult && !createResult && !chargeResult && !liveResult && !archivedResult
	);

	// The create panel: open below xl on ?add=1, when there is no live rate, or
	// when the create form has just produced a result.
	let opened = $state(false);
	const asideOpen = $derived(
		opened || page.url.searchParams.get('add') === '1' || liveRates.length === 0 || createResult
	);

	async function openPanel(event: MouseEvent) {
		event.preventDefault();
		opened = true;
		await tick();
		document.getElementById('new-rate-name')?.focus();
	}
</script>

<svelte:head>
	<title>Tax · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Setup"
	title="Tax"
	description="How prices carry tax, the named rates the menu can use, and the one every item uses unless it picks another. A change reaches the till with its next menu update."
>
	{#snippet actions()}
		<Button href="?add=1#add-tax-rate" variant="primary" class="xl:hidden" onclick={openPanel}>
			Add tax rate
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

		<!-- The mode and the default: two forms, two named actions, one card. -->
		<Card class="flex flex-col gap-6">
			<div class="flex flex-col gap-1">
				<h3 class="text-section">How tax is charged</h3>
				<p class="text-body text-ink-2">
					The mode applies to every sale. The default rate is what a menu item set to Default uses.
				</p>
			</div>

			{#if chargeResult}
				<Alert {tone}>{form?.message}</Alert>
			{/if}

			<form method="POST" action="?/mode" class="flex flex-col gap-4" use:enhance={keepValues}>
				<SelectField
					id="taxMode"
					name="taxMode"
					label="Tax mode"
					options={modeOptions}
					value={data.taxMode ?? ''}
					placeholder="Not chosen"
					hint="Exclusive adds tax on top of each price; inclusive means each price already contains it. Applies to new sales only."
				/>
				<div>
					<Button type="submit">Save tax mode</Button>
				</div>
			</form>

			<form
				method="POST"
				action="?/setDefault"
				class="border-line-soft flex flex-col gap-4 border-t pt-4"
				use:enhance={keepValues}
			>
				<SelectField
					id="defaultTaxRateId"
					name="taxRateId"
					label="Default tax rate"
					options={rateOptions}
					value={data.defaultTaxRateId ?? ''}
					placeholder="Not chosen"
					disabled={liveRates.length === 0}
					disabledReason="Add a rate first."
					hint="Every menu item set to Default uses this rate."
				/>
				<div>
					<Button type="submit">Save default rate</Button>
				</div>
			</form>
		</Card>

		<!-- One card per live rate. The fields are labelled Name and Percent, NOT
		     Rate name / Rate (%): Playwright's getByLabel matches substrings, and the
		     create panel owns those two labels. -->
		<div class="grid items-start gap-6 lg:grid-cols-2">
			{#each liveRates as rate (rate.id)}
				<Card class="flex flex-col gap-4">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<h3 class="text-section">{rate.label}</h3>
						{#if rate.isDefault}
							<StatusMark status="done" label="default" />
						{/if}
					</div>
					<p class="text-ink-2 text-sm">Chosen by {rate.liveItemCount} menu item(s)</p>

					{#if rateResultId === rate.id}
						<Alert {tone}>{form?.message}</Alert>
					{/if}

					<form
						method="POST"
						action="?/update"
						class="flex flex-col gap-4"
						use:enhance={keepValues}
					>
						<input type="hidden" name="taxRateId" value={rate.id} />
						<Field
							id={`rate-${rate.id}-name`}
							name="name"
							label="Name"
							value={rate.name}
							required
						/>
						<Field
							id={`rate-${rate.id}-percent`}
							name="percent"
							label="Percent"
							inputmode="decimal"
							value={rate.percent}
							required
							hint="Changing a rate applies to new sales; every past receipt keeps the rate it was sold at."
						/>
						<div>
							<Button type="submit">Save rate</Button>
						</div>
					</form>

					<div class="border-line-soft border-t pt-4">
						<form
							method="POST"
							action="?/archive"
							class="flex flex-col gap-2"
							use:enhance={keepValues}
						>
							<input type="hidden" name="taxRateId" value={rate.id} />
							<input type="hidden" name="name" value={rate.name} />
							<Button
								type="submit"
								variant="danger"
								disabled={rate.isDefault || rate.liveItemCount > 0}
								disabledReason={rate.isDefault
									? 'The default rate cannot be archived.'
									: rate.liveItemCount > 0
										? `Used by ${rate.liveItemCount} menu item(s) — move them first.`
										: ''}
							>
								Archive
							</Button>
						</form>
					</div>
				</Card>
			{/each}
		</div>

		<Card class="flex flex-col gap-4">
			<h3 class="text-section">Archived rates</h3>

			{#if archivedResult}
				<Alert {tone}>{form?.message}</Alert>
			{/if}

			<div class="flex flex-col gap-3">
				{#if archivedRates.length > 0}
					{#each archivedRates as rate (rate.id)}
						<div class="flex items-center justify-between gap-3">
							<span class="text-ink-2">{rate.label}</span>
							<StatusMark status="blocked" label="archived" />
						</div>
					{/each}
				{:else}
					<p class="text-ink-2 text-sm">None.</p>
				{/if}
			</div>
		</Card>

		{#snippet aside()}
			<CreatePanel id="add-tax-rate" title="Add tax rate">
				<form method="POST" action="?/create" class="flex flex-col gap-4" use:enhance={track}>
					{#if createResult}
						<Alert {tone}>{form?.message}</Alert>
					{/if}

					<Field id="new-rate-name" name="name" label="Rate name" required />
					<Field
						id="new-rate-percent"
						name="percent"
						label="Rate (%)"
						inputmode="decimal"
						required
						hint="For example 5 or 8.25. 0 is a real rate: no tax charged."
					/>
					<!-- Ticked by default only while the restaurant has no default yet; the
					     rate still becomes the default only when the owner submits it ticked. -->
					<CheckField
						id="new-rate-default"
						name="makeDefault"
						value="yes"
						label="Make this the default rate"
						checked={data.defaultTaxRateId === null}
					/>

					<div>
						<Button type="submit" variant="primary">Add rate</Button>
					</div>
				</form>
			</CreatePanel>
		{/snippet}
	</PageColumns>
</PageBody>
