<script lang="ts">
	// THE DASHBOARD'S POS DEVICE PAGE — at /device, never at a path beginning with
	// the characters "pos": the till's service worker is scoped to /pos by STRING
	// prefix, and would otherwise control this authenticated page. The rail item that
	// leads here is labelled "POS"; only the URL differs, on purpose.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';

	let { data, form } = $props();
	let saving = $state(false);

	// REGISTERED = a device exists AND it has not been revoked. The load returns a
	// revoked row on purpose; this predicate is what gives it meaning, and the
	// onboarding checklist uses the same one, so the two screens cannot disagree.
	const registered = $derived(data.device !== null && data.device.revokedAt === null);

	// Tone follows the outcome: page.status is 400 after a fail() and 200 otherwise,
	// so a rejected save never renders green with a ✓.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// The restaurant's own clock (invariant 11) and a fixed locale, which also keeps
	// the server-rendered text identical to the hydrated text.
	const when = (value: Date | string) =>
		new Intl.DateTimeFormat('en-GB', {
			timeZone: data.timeZone ?? 'UTC',
			day: '2-digit',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date(value));
</script>

<svelte:head>
	<title>POS device · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Setup"
	title="POS device"
	description="The one tablet this restaurant sells from: see it, choose how soon it locks, open it, or revoke it."
/>

<div class="flex flex-col gap-5 px-4 pt-8 pb-16 lg:px-7">
	<!-- EXACTLY ONE role="alert" region may be visible at a time: the form's message
	     when there is one, and otherwise the settings-incomplete message — never
	     both. Two is a Playwright strict-mode failure ("resolved to 2 elements"). -->
	{#if form?.message}
		<div class="max-w-form">
			<Alert {tone}>{form.message}</Alert>
		</div>
	{:else if !data.settings.complete}
		<div class="max-w-form">
			<Alert tone="info">
				<span>Still needed: {data.settings.missing.join(', ')}.</span>
				{#if data.settings.missing.includes('POS idle lock')}
					Set the auto-lock on this page.
				{/if}
				{#if data.settings.missing.includes('time zone')}
					<a href={resolve('/settings')} class="underline"
						>Set the time zone in Restaurant settings.</a
					>
				{/if}
			</Alert>
		</div>
	{/if}

	<Card class="max-w-form">
		<div class="flex flex-col gap-4">
			<h3 class="text-ink font-semibold">Registered device</h3>
			{#if registered && data.device}
				<dl class="flex flex-col gap-2">
					<div class="flex flex-wrap gap-x-2">
						<dt class="text-ink-2">Label</dt>
						<dd class="text-ink">{data.device.label}</dd>
					</div>
					<div class="flex flex-wrap gap-x-2">
						<dt class="text-ink-2">Device code</dt>
						<dd class="text-ink font-mono">{data.device.deviceCode}</dd>
					</div>
					<div class="flex flex-wrap gap-x-2">
						<dt class="text-ink-2">Registered</dt>
						<dd class="text-ink">{when(data.device.registeredAt)}</dd>
					</div>
					<div class="flex flex-wrap gap-x-2">
						<dt class="text-ink-2">Last seen</dt>
						<dd class="text-ink">
							{data.device.lastSeenAt ? when(data.device.lastSeenAt) : 'never'}
						</dd>
					</div>
				</dl>
			{:else if data.device && data.device.revokedAt}
				<p class="text-ink-2">
					{data.device.label} ({data.device.deviceCode}) was revoked on {when(
						data.device.revokedAt
					)}. No tablet is registered now.
				</p>
			{:else}
				<p class="text-ink-2">No tablet is registered yet.</p>
			{/if}
			<!-- Spec 7: the device is registered ON THE TILL, not from here. Said whether
			     or not a device exists. -->
			<p class="text-ink-2">
				A tablet is registered on the till itself, not from this page: open the POS on the tablet
				and sign in there once with the owner’s email and password. The server then gives that
				tablet a long-lived device cookie. This page is where you see it and revoke it.
			</p>
		</div>
	</Card>

	<Card class="max-w-form">
		<form
			method="POST"
			action="?/setIdleLock"
			class="flex flex-col gap-5"
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update();
					saving = false;
				};
			}}
		>
			<!-- The value is the stored setting, and empty when none is stored: there is
			     no default to show (CLAUDE.md, decision of 2026-09-15). -->
			<Field
				id="idle-lock"
				name="posIdleLockSeconds"
				label="Auto-lock after (seconds)"
				type="number"
				required
				value={String(data.idleLockSeconds ?? '')}
				hint="From 30 to 1800 seconds. After this long with no touch, the till returns to employee select."
			/>
			<div class="flex flex-wrap items-center gap-3">
				<Button type="submit" variant="primary" disabled={saving}>
					{saving ? 'Saving…' : 'Save auto-lock'}
				</Button>
			</div>
		</form>
	</Card>

	<Card class="max-w-form">
		<div class="flex flex-col gap-3">
			<h3 class="text-ink font-semibold">Open the till</h3>
			{#if data.settings.complete}
				<!-- rel="noopener": without it the opened till holds a window.opener
				     reference to this authenticated dashboard page. -->
				<div>
					<Button href={resolve('/pos')} target="_blank" rel="noopener">Open the POS</Button>
				</div>
				<p class="text-ink-2">
					Opens in a new tab. On a tablet that is not registered yet, the POS first asks for the
					owner’s email and password, once.
				</p>
			{:else}
				<!-- No launch control at all while a setting is missing — not a dead one. -->
				<p class="text-ink-2">
					Available once every setting the till needs is in place: {data.settings.missing.join(
						', '
					)}.
				</p>
			{/if}
		</div>
	</Card>

	{#if registered && data.device}
		<Card class="max-w-form">
			<!-- A native <details>, not a modal: modals are for POS reason codes, owner
			     approval and errors. Two distinct accessible names, so a test can address
			     either without ambiguity. -->
			<details>
				<summary class="text-danger cursor-pointer font-medium">Revoke this device…</summary>
				<div class="mt-3 flex flex-col gap-3">
					<p class="text-ink-2">
						The till stops accepting PIN logins immediately, and the owner must sign in on it again
						to re-register it.
					</p>
					<form method="POST" action="?/revoke" use:enhance>
						<!-- Not optional: the revoke action validates deviceId as a uuid and
						     answers 400 without it. -->
						<input type="hidden" name="deviceId" value={data.device.id} />
						<Button variant="danger" type="submit">Revoke device</Button>
					</form>
				</div>
			</details>
		</Card>
	{/if}
</div>
