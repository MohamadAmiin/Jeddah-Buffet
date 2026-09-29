<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';

	let { data, form } = $props();
	let submitting = $state(false);

	// The action returns a `message` on BOTH paths — `Settings saved.` /
	// `No changes to save.` on success, and fail(400, { message }) on a validation
	// error. Tone must follow the outcome: a hardcoded success tone would render a
	// rejected form in green with a ✓ glyph, which is the colour-plus-glyph rule
	// carrying the WRONG meaning. page.status is 400 after a fail() and 200
	// otherwise, so the outcome is read here without touching +page.server.ts.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');
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

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	{#if form?.message}
		<!-- EXACTLY ONE role="alert" may be visible on this page at a time. The journey
		     asserts against a single page.getByRole('alert') locator, so a second region
		     is a Playwright strict-mode violation failing with "resolved to 2 elements" —
		     which looks nothing like a styling problem. Field's per-field error carries
		     no alert role, for this reason. -->
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{/if}

	<Card class="max-w-form">
		<form
			method="POST"
			class="flex flex-col gap-5"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
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

			<!--
				Tax mode, tax rate and currency (spec 33 open decisions 3 and 4, answered
				2026-09-15). NOT required: the columns are nullable and the owner may save
				a rename without answering them. An empty field is "unset", never a default.
				Tax mode is free text with a datalist, mirroring the time zone, because
				Field renders an <input> only. There is NO idle-lock control here: it lives
				on /device, beside the till it protects. Approval limits are still open
				decision 6 and have no field at all.
			-->
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
				value={data.taxRateBp === null ? '' : String(data.taxRateBp)}
				hint="825 means 8.25%. Whole basis points only."
			/>
			<Field
				id="currencyCode"
				name="currencyCode"
				label="Currency code"
				value={data.currencyCode ?? ''}
				hint={`The one currency this restaurant uses. Supported: ${data.supportedCurrencies.join(', ')}.`}
			/>

			<!--
				T-29: accepted tenders. Cash is always on. Each of card and mobile
				money is a tri-state: Not chosen (null on the wire — the till
				disables the key with the reason), Accepted, or Not accepted. No
				default anywhere.
			-->
			<div class="flex flex-col gap-2">
				<label for="acceptsCard" class="text-ink font-semibold">Card terminal</label>
				<select
					id="acceptsCard"
					name="acceptsCard"
					class="border-control-line rounded-md border p-2"
				>
					<option value="unset" selected={data.acceptsCard === null}>Not chosen</option>
					<option value="yes" selected={data.acceptsCard === true}>Accepted</option>
					<option value="no" selected={data.acceptsCard === false}>Not accepted</option>
				</select>
				<span class="text-caption text-ink-2"
					>Accepted: the till offers a Card key and the cashier records what the terminal approved.</span
				>
			</div>

			<div class="flex flex-col gap-2">
				<label for="acceptsMobile" class="text-ink font-semibold">Mobile money</label>
				<select
					id="acceptsMobile"
					name="acceptsMobile"
					class="border-control-line rounded-md border p-2"
				>
					<option value="unset" selected={data.acceptsMobile === null}>Not chosen</option>
					<option value="yes" selected={data.acceptsMobile === true}>Accepted</option>
					<option value="no" selected={data.acceptsMobile === false}>Not accepted</option>
				</select>
				<span class="text-caption text-ink-2"
					>Accepted: the till offers a Mobile key and the cashier records the confirmed transfer.</span
				>
			</div>

			<!--
				T-21 (menu-and-printing): what the receipt prints under the restaurant's
				name. All optional; a blank field clears the line. Spec 33 decision 3 —
				what a receipt must legally show — is still open, so this is the default
				layout's text, not a legal form.
			-->
			<fieldset class="border-line flex flex-col gap-4 rounded-md border p-4">
				<legend class="text-ink px-1 font-semibold">Receipt</legend>
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
			</fieldset>

			<div class="flex flex-wrap items-center gap-3">
				<!-- The label says WHY it is disabled while a save is in flight: "Saving…"
				     is the reason, in the one place the owner is already looking. -->
				<Button type="submit" variant="primary" disabled={submitting}>
					{submitting ? 'Saving…' : 'Save settings'}
				</Button>
				<span class="text-caption text-ink-2 grow basis-48">
					Saved immediately. The change is written to the audit log.
				</span>
			</div>
		</form>
	</Card>
</div>
