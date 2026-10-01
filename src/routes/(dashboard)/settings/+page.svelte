<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		ActionBar,
		Alert,
		Button,
		Field,
		Icon,
		PageBody,
		PageHeader,
		SelectField
	} from '$lib/components/ui';

	let { data, form } = $props();
	let submitting = $state(false);

	// The action returns a `message` on BOTH paths — `Settings saved.` /
	// `No changes to save.` on success, and fail(400, { message }) on a validation
	// error. Tone must follow the outcome: a hardcoded success tone would render a
	// rejected form in green with a ✓ glyph, which is the colour-plus-glyph rule
	// carrying the WRONG meaning. page.status is 400 after a fail() and 200
	// otherwise, so the outcome is read here without touching +page.server.ts.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// T-29: accepted tenders. Cash is always on. Each of card and mobile money is a
	// tri-state: Not chosen (null on the wire — the till disables the key with the
	// reason), Accepted, or Not accepted. No default anywhere.
	const tenderOptions = [
		{ value: 'unset', label: 'Not chosen' },
		{ value: 'yes', label: 'Accepted' },
		{ value: 'no', label: 'Not accepted' }
	];
	const tenderValue = (accepts: boolean | null) =>
		accepts === null ? 'unset' : accepts ? 'yes' : 'no';

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
	description="The facts every other screen depends on. Changing one is allowed and is recorded with its old and new values; none rewrites anything already posted."
/>

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
			Tax mode, tax rate and currency (spec 33 open decisions 3 and 4, answered
			2026-09-15). NOT required: the columns are nullable and the owner may save
			a rename without answering them. An empty field is "unset", never a default.
			Tax mode is free text with a datalist, mirroring the time zone, because
			Field renders an <input> only. There is NO idle-lock control here: it lives
			on /device, beside the till it protects. Approval limits are still open
			decision 6 and have no field at all.
		-->
		<section aria-labelledby="s-tax" class={SECTION}>
			<div class="flex flex-col gap-1">
				<h3 id="s-tax" class="text-section">Tax</h3>
				<p class="text-body text-ink-2">
					How the till adds tax to a price. Each sale keeps the rate it was sold at.
				</p>
			</div>
			<div class={FIELDS}>
				<Field
					id="taxMode"
					name="taxMode"
					label="Tax mode"
					list="tax-modes"
					value={data.taxMode ?? ''}
					hint="exclusive adds the tax on top of the price; inclusive means the price already contains it."
				/>
				<datalist id="tax-modes">
					{#each data.taxModes as mode (mode)}
						<option value={mode}></option>
					{/each}
				</datalist>
				<Field
					id="taxRateBp"
					name="taxRateBp"
					label="Tax rate (basis points)"
					inputmode="numeric"
					numeric
					value={data.taxRateBp === null ? '' : String(data.taxRateBp)}
					hint="825 means 8.25%. Whole basis points only."
				/>
			</div>
		</section>

		<section aria-labelledby="s-money" class={SECTION}>
			<div class="flex flex-col gap-1">
				<h3 id="s-money" class="text-section">Money and tenders</h3>
				<p class="text-body text-ink-2">
					The one currency, and which keys the till offers besides cash.
				</p>
			</div>
			<div class={FIELDS}>
				<Field
					id="currencyCode"
					name="currencyCode"
					label="Currency code"
					value={data.currencyCode ?? ''}
					hint={`The one currency this restaurant uses. Supported: ${data.supportedCurrencies.join(', ')}.`}
				/>
				<div class="hidden md:block"></div>
				<SelectField
					id="acceptsCard"
					name="acceptsCard"
					label="Card terminal"
					value={tenderValue(data.acceptsCard)}
					options={tenderOptions}
					hint="Accepted: the till offers a Card key and the cashier records what the terminal approved."
				/>
				<SelectField
					id="acceptsMobile"
					name="acceptsMobile"
					label="Mobile money"
					value={tenderValue(data.acceptsMobile)}
					options={tenderOptions}
					hint="Accepted: the till offers a Mobile key and the cashier records the confirmed transfer."
				/>
			</div>
		</section>

		<!--
			T-21 (menu-and-printing): what the receipt prints under the restaurant's
			name. All optional; a blank field clears the line. Spec 33 decision 3 —
			what a receipt must legally show — is still open, so this is the default
			layout's text, not a legal form.
		-->
		<section aria-labelledby="s-receipt" class={SECTION}>
			<div class="flex flex-col gap-1">
				<h3 id="s-receipt" class="text-section">Receipt</h3>
				<p class="text-body text-ink-2">
					What every receipt prints under the restaurant's name. A blank field prints nothing.
				</p>
			</div>
			<div class={FIELDS}>
				<Field
					id="receiptAddress"
					name="receiptAddress"
					label="Address"
					value={data.receiptAddress}
					maxlength="120"
					hint="Printed under the restaurant's name. Leave blank to print none."
				/>
				<Field
					id="receiptPhone"
					name="receiptPhone"
					label="Phone"
					value={data.receiptPhone}
					maxlength="40"
					inputmode="tel"
				/>
				<Field
					id="taxRegistrationNumber"
					name="taxRegistrationNumber"
					label="Tax registration number"
					value={data.taxRegistrationNumber}
					maxlength="40"
					hint="Printed on every receipt when set. What a receipt must legally show is still being confirmed with an accountant."
				/>
				<Field
					id="receiptFooter"
					name="receiptFooter"
					label="Footer line"
					value={data.receiptFooter}
					maxlength="120"
					hint="For example: Mahadsanid! Thank you!"
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
