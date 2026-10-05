<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { ActionBar, Alert, Button, Field, Icon, PageBody, PageHeader } from '$lib/components/ui';
	import { settingsSections, SETTINGS_SECTION_LINK } from './sections';

	let { data, form } = $props();
	let submitting = $state(false);

	// The action returns a `message` on BOTH paths — `Settings saved.` /
	// `No changes to save.` on success, and fail(400, { message }) on a validation
	// error. Tone must follow the outcome: a hardcoded success tone would render a
	// rejected form in green with a ✓ glyph, which is the colour-plus-glyph rule
	// carrying the WRONG meaning. page.status is 400 after a fail() and 200
	// otherwise, so the outcome is read here without touching +page.server.ts.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	const SECTION = 'border-line grid gap-4 border-b pb-8 lg:grid-cols-3 lg:gap-8';
	const FIELDS =
		'bg-raise border-line shadow-card rounded-card grid gap-4 border p-6 md:grid-cols-2 lg:col-span-2';
</script>

<svelte:head>
	<title>Settings · matcami</title>
</svelte:head>

{#snippet timeZoneHint()}
	This decides which business day a sale belongs to — a sale at 01:30 counts toward the previous
	evening. Changing it is allowed and is recorded with the old and new values; it does not rewrite
	anything already recorded.
{/snippet}

<!-- The page band, matching the overview. h2, not h1 — the layout's h1 is the
     restaurant name. The eyebrow names the rail group this screen lives in, so the
     heading and the navigation agree about where the owner is. -->
<PageHeader
	eyebrow="Setup"
	title="Restaurant settings"
	description="The restaurant's name, the clock that decides its business day, and its one currency. Tax, payment methods and the receipt each have their own page."
>
	{#snippet below()}
		<!-- The settings sub-navigation (gate decision 8). EXACT match only: every
		     /settings/<page> starts with /settings/, so the inventory nav's prefix rule
		     would light General on all four pages. -->
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
	<form
		id="settings-form"
		method="POST"
		class="flex flex-col gap-8"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		}}
	>
		<section aria-labelledby="s-restaurant" class={SECTION}>
			<div class="flex flex-col gap-1">
				<h3 id="s-restaurant" class="text-section">Restaurant</h3>
				<p class="text-body text-ink-2">Its name, and whose clock decides the business day.</p>
			</div>
			<div class={FIELDS}>
				<Field id="name" name="name" label="Restaurant name" required value={data.name} />

				<!-- Free text with a datalist, not a select: the owner must be able to enter
				     a zone the suggestion list omits. Field takes `list`; the datalist stays
				     here. -->
				<Field
					id="timeZone"
					name="timeZone"
					label="Time zone"
					list="time-zones"
					required
					value={data.timeZone}
					hint={timeZoneHint}
				/>
				<datalist id="time-zones">
					{#each data.timeZones as tz (tz)}
						<option value={tz}></option>
					{/each}
				</datalist>
			</div>
		</section>

		<!--
			The currency (spec 33 open decision 4, answered 2026-09-15). NOT required:
			the column is nullable and the owner may save a rename without answering
			it. An empty field is "unset", never a default. The tax mode and the default
			tax rate are chosen on /settings/tax (tasks/settings-tax-payments-receipt
			T-28), the payment methods on /settings/payments (T-29) and the receipt
			text on /settings/receipt (T-31) — not here. There is NO idle-lock control
			here: it lives on /device, beside the till it protects. Approval limits
			are still open decision 6 and have no field at all.
		-->
		<section aria-labelledby="s-money" class={SECTION}>
			<div class="flex flex-col gap-1">
				<h3 id="s-money" class="text-section">Money</h3>
				<p class="text-body text-ink-2">The one currency every price, receipt and report uses.</p>
			</div>
			<div class={FIELDS}>
				<Field
					id="currencyCode"
					name="currencyCode"
					label="Currency code"
					value={data.currencyCode ?? ''}
					hint={`The one currency this restaurant uses. Supported: ${data.supportedCurrencies.join(', ')}.`}
				/>
			</div>
		</section>
	</form>

	<!-- The idle lock is a required setting, but it lives on /device beside the
	     till it protects; this row points there. -->
	<section
		aria-labelledby="s-autolock"
		class="bg-raise-2 border-line rounded-card flex flex-wrap items-center gap-4 border px-5 py-4"
	>
		<Icon name="lock" class="text-ink-2 size-5" />
		<div class="flex min-w-0 flex-1 basis-72 flex-col gap-0.5">
			<h3 id="s-autolock" class="text-section">The till's auto-lock is set on POS device</h3>
			<p class="text-body text-ink-2">
				It lives with the tablet it protects. Setup counts it as a required setting.
			</p>
		</div>
		<Button href={resolve('/device')}>Open POS device</Button>
	</section>
</PageBody>

<ActionBar caption="Saved immediately. The change is written to the audit log.">
	{#snippet message()}
		{#if form?.message}
			<!-- EXACTLY ONE role="alert" may be visible on this page at a time. The journey
			     asserts against a single page.getByRole('alert') locator, so a second region
			     is a Playwright strict-mode violation failing with "resolved to 2 elements" —
			     which looks nothing like a styling problem. Field's per-field error carries
			     no alert role, for this reason. -->
			<Alert {tone}>{form.message}</Alert>
		{:else}
			<p class="text-caption text-ink-2">
				Saved immediately. The change is written to the audit log.
			</p>
		{/if}
	{/snippet}

	<!-- The label says WHY it is disabled while a save is in flight: "Saving…" is
	     the reason, in the one place the owner is already looking. -->
	<Button type="submit" form="settings-form" variant="primary" disabled={submitting}>
		{submitting ? 'Saving…' : 'Save settings'}
	</Button>
</ActionBar>
