<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, AuthSplit, Button, Field } from '$lib/components/ui';

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

<!-- The two halves are declared as TOP-LEVEL snippets and handed to AuthSplit as
     attributes, never written as children named `form` and `brand` inside its block.
     A snippet named `form` there would shadow this page's `form` prop — the action
     result — throughout its own body, and every `form?.message` below would silently
     read the snippet instead. -->
{#snippet formPanel()}
	{#if form?.message}
		<Alert tone="danger">{form.message}</Alert>
	{/if}

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

		<!-- Stretched flex child, so it fills the form measure without a width class —
		     Button applies its own class last and a caller's would be dropped. While the
		     request is in flight it is disabled and its LABEL says why, which is what
		     keeps a disabled control from sitting dead. -->
		<Button type="submit" variant="primary" disabled={submitting}>
			{submitting ? 'Creating…' : 'Create restaurant'}
		</Button>
	</form>
{/snippet}

<!-- NO MONEY FIGURE ON A DASHBOARD SURFACE. Nothing in this product states the
     restaurant's revenue, today's takings or any other computed figure — not even a
     zero, because the money module does not exist yet and a zero is
     indistinguishable from a broken query.

     The slip below carries NO money at all, which is what makes it legal here. It
     is a KITCHEN TICKET, not a guest check: spec 11 says a kitchen ticket prints
     the order number, table, waiter, items, modifiers and notes — and no prices,
     because the kitchen cooks and the till charges. An earlier draft drew a guest
     check with typed-in prices and a "Tax 5%" line; that broke the rule above and
     silently answered spec 33 open decision 3 (tax mode, rate and rounding), which
     is still open. The caption says outright that it is a specimen. -->
{#snippet brandPanel()}
	<div class="bg-raise text-ink rounded-card shadow-floating w-full p-4 font-mono">
		<div class="border-line flex flex-col gap-0.5 border-b border-dashed pb-2">
			<p class="text-caption font-semibold tracking-widest uppercase">Matcami Suugo · KITCHEN</p>
			<p class="text-ink-3 text-eyebrow uppercase">Takeaway · Order #1043 · Cabdi</p>
		</div>

		<ul class="text-caption flex list-none flex-col gap-1 p-0 pt-2">
			<li class="flex gap-3">
				<span class="text-ink-3 w-9 shrink-0 tabular-nums">1×</span>
				<span class="min-w-0 break-words">Canjeero & Suqaar</span>
			</li>
			<li class="flex gap-3">
				<span class="text-ink-3 w-9 shrink-0 tabular-nums">2×</span>
				<span class="min-w-0 break-words">Sambuusa</span>
			</li>
			<li class="text-ink-2 flex gap-3 pl-12">
				<span class="min-w-0 break-words">+ No basbaas</span>
			</li>
			<li class="flex gap-3">
				<span class="text-ink-3 w-9 shrink-0 tabular-nums">1×</span>
				<span class="min-w-0 break-words">Shaah Cadays</span>
			</li>
		</ul>

		<p class="border-line text-ink-2 text-eyebrow mt-2 border-t border-dashed pt-2 uppercase">
			Note: pack the shaah separately
		</p>
	</div>

	<p class="text-caption">
		A specimen kitchen ticket, not live data. A kitchen ticket carries the order, the table, the
		waiter, the items and their modifiers — and <strong>no prices</strong>: the kitchen cooks, the
		till charges.
	</p>
{/snippet}

<AuthSplit
	title="Set up your restaurant"
	caption="This creates the restaurant and its owner account. It can only be done once."
	eyebrow="First run · one time only"
	statement="One restaurant. One till. Books that balance."
	form={formPanel}
	brand={brandPanel}
/>
