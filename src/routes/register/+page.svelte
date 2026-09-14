<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';

	let { data, form } = $props();
	let submitting = $state(false);

	// Pre-fill from the browser. This value may be a spelling that a
	// list-membership check would reject (Firefox reports Asia/Kolkata and
	// Europe/Kyiv), which is exactly why the server validates by construction.
	const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>

<svelte:head>
	<title>Set up matcami</title>
</svelte:head>

{#snippet timeZoneHint()}
	This decides which business day a sale belongs to — a sale at 01:30 counts toward the previous
	evening. You can change it later.
{/snippet}

{#snippet setupTokenHint()}
	The one-time value from the server's <code>SETUP_TOKEN</code> environment variable. It is required only
	for the first restaurant, and should be unset afterwards.
{/snippet}

<!-- No bg-bg/text-ink here: the element base layer sets the page ground and ink on
     `body`. The full-height centring stays. -->
<main class="flex min-h-screen items-center justify-center p-6">
	<Card class="w-full max-w-lg">
		<PageHeader
			level={1}
			title="Set up your restaurant"
			description="This creates the restaurant and its owner account. It can only be done once."
		/>

		{#if form?.message}
			<div class="mt-4">
				<Alert tone="danger">{form.message}</Alert>
			</div>
		{/if}

		<form
			method="POST"
			class="mt-4 flex flex-col gap-4"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<Field
				id="restaurantName"
				name="restaurantName"
				label="Restaurant name"
				required
				value={form?.restaurantName ?? ''}
			/>

			<Field
				id="timeZone"
				name="timeZone"
				label="Time zone"
				list="time-zones"
				required
				value={form?.timeZone || browserTimeZone}
				hint={timeZoneHint}
			/>
			<!-- A datalist, not a select: the owner must be able to type a zone the
			     suggestion list omits. Field takes `list` and renders no datalist itself. -->
			<datalist id="time-zones">
				{#each data.timeZones as tz (tz)}
					<option value={tz}></option>
				{/each}
			</datalist>

			<Field
				id="ownerDisplayName"
				name="ownerDisplayName"
				label="Your name"
				required
				value={form?.ownerDisplayName ?? ''}
			/>

			<Field
				id="email"
				name="email"
				type="email"
				label="Email"
				autocomplete="username"
				required
				value={form?.email ?? ''}
			/>

			<Field
				id="password"
				name="password"
				type="password"
				label="Password"
				autocomplete="new-password"
				required
				minlength={8}
				hint="At least 8 characters."
			/>

			<Field
				id="passwordConfirm"
				name="passwordConfirm"
				type="password"
				label="Confirm password"
				autocomplete="new-password"
				required
			/>

			<Field id="setupToken" name="setupToken" label="Setup token" required hint={setupTokenHint} />

			<Button type="submit" variant="primary" disabled={submitting}>
				{submitting ? 'Creating…' : 'Create restaurant'}
			</Button>
		</form>
	</Card>
</main>
