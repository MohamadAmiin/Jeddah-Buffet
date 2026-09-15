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
