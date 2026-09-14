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

<!-- level={2}: the (dashboard) layout's h1 is the restaurant name. -->
<PageHeader level={2} title="Restaurant settings" />

{#if form?.message}
	<!-- EXACTLY ONE role="alert" may be visible on this page at a time. The journey
	     asserts against a single page.getByRole('alert') locator, so a second region
	     is a Playwright strict-mode violation failing with "resolved to 2 elements" —
	     which looks nothing like a styling problem. Field's per-field error carries
	     no alert role, for this reason. -->
	<div class="mt-4">
		<Alert {tone}>{form.message}</Alert>
	</div>
{/if}

<Card class="mt-4 max-w-lg">
	<form
		method="POST"
		class="flex flex-col gap-4"
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
			NO fields for tax mode, tax rate, currency, approval limits or idle-lock
			timing — not even disabled ones. Spec 33 open decisions 3, 4 and 6 are
			unresolved, and a greyed-out field showing a plausible default is how an
			unmade decision becomes a remembered fact.
		-->

		<div>
			<Button type="submit" variant="primary" disabled={submitting}>
				{submitting ? 'Saving…' : 'Save settings'}
			</Button>
		</div>
	</form>
</Card>
