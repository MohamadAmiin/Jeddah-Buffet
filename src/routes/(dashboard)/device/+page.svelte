<script lang="ts">
	// THE DASHBOARD'S POS DEVICE PAGE — at /device, never at a path beginning with
	// the characters "pos": the till's service worker is scoped to /pos by STRING
	// prefix, and would otherwise control this authenticated page. The rail item that
	// leads here is labelled "POS"; only the URL differs, on purpose.
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		Alert,
		Button,
		Card,
		Field,
		PageBody,
		PageColumns,
		PageHeader
	} from '$lib/components/ui';

	let { data, form } = $props();
	let saving = $state(false);

	// REGISTERED = a device exists AND it has not been revoked. The load returns a
	// revoked row on purpose; this predicate is what gives it meaning, and the
	// onboarding checklist uses the same one, so the two screens cannot disagree.
	const registered = $derived(data.device !== null && data.device.revokedAt === null);

	// Tone follows the outcome: page.status is 400 after a fail() and 200 otherwise,
	// so a rejected save never renders green with a ✓.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// Which form produced `form`, so its outcome renders inside that form's card.
	// With JavaScript the enhance callback records the action; without it, the POST
	// lands on this URL with the action as its search. EXACTLY ONE role="alert"
	// region is visible at a time — only the form just submitted shows its result.
	let submitted = $state<string | null>(null);
	const lastAction = $derived(submitted ?? page.url.search);
	function track({ action }: { action: URL }) {
		submitted = action.search;
	}
	const revokeResult = $derived(form?.message !== undefined && lastAction === '?/revoke');
	const idleLockResult = $derived(form?.message !== undefined && lastAction !== '?/revoke');

	// Where each missing setting is set: the idle lock on this page, the rest on
	// /settings. Names as settingsComplete() reports them.
	const missingOnThisPage = (name: string) => name === 'POS idle lock';

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
>
	{#snippet actions()}
		{#if data.settings.complete}
			<!-- rel="noopener": without it the opened till holds a window.opener
			     reference to this authenticated dashboard page. -->
			<Button variant="primary" href={resolve('/pos')} target="_blank" rel="noopener"
				>Open the POS</Button
			>
		{:else}
			<!-- No launch control at all while a setting is missing — not a dead one. -->
			<div class="flex flex-col gap-1">
				<p class="text-caption text-ink-2">The POS opens once these are set:</p>
				<ul class="text-caption flex flex-wrap gap-x-3 gap-y-1">
					{#each data.settings.missing as name (name)}
						<li>
							{#if missingOnThisPage(name)}
								<a href="#idle-lock" class="text-accent font-medium underline underline-offset-2"
									>{name}</a
								>
							{:else}
								<a
									href={resolve('/settings')}
									class="text-accent font-medium underline underline-offset-2">{name}</a
								>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/snippet}
</PageHeader>

<PageBody>
	<PageColumns>
		<Card class="flex flex-col gap-4">
			<h3 class="text-section">Registered device</h3>

			{#if revokeResult}
				<Alert {tone}>{form?.message}</Alert>
			{/if}

			{#if registered && data.device}
				<dl class="grid gap-x-6 gap-y-2 sm:grid-cols-2">
					<div class="flex flex-col">
						<dt class="text-ink-2 text-sm">Label</dt>
						<dd class="text-ink">{data.device.label}</dd>
					</div>
					<div class="flex flex-col">
						<dt class="text-ink-2 text-sm">Device code</dt>
						<dd class="text-ink font-mono">{data.device.deviceCode}</dd>
					</div>
					<div class="flex flex-col">
						<dt class="text-ink-2 text-sm">Registered</dt>
						<dd class="text-ink">{when(data.device.registeredAt)}</dd>
					</div>
					<div class="flex flex-col">
						<dt class="text-ink-2 text-sm">Last seen</dt>
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
				tablet a long-lived device cookie. This page is where you see it and revoke it. Open the POS
				opens in a new tab.
			</p>

			{#if registered && data.device}
				<!-- A native <details>, not a modal: modals are for POS reason codes, owner
				     approval and errors. Two distinct accessible names, so a test can address
				     either without ambiguity. -->
				<details class="border-line-soft border-t pt-4">
					<summary class="text-danger cursor-pointer font-medium">Revoke this device…</summary>
					<div class="mt-3 flex flex-col gap-3">
						<p class="text-ink-2">
							The till stops accepting PIN logins immediately, and the owner must sign in on it
							again to re-register it.
						</p>
						<form method="POST" action="?/revoke" use:enhance={track}>
							<!-- Not optional: the revoke action validates deviceId as a uuid and
							     answers 400 without it. -->
							<input type="hidden" name="deviceId" value={data.device.id} />
							<Button variant="danger" type="submit">Revoke device</Button>
						</form>
					</div>
				</details>
			{/if}
		</Card>

		{#snippet aside()}
			<Card>
				<form
					method="POST"
					action="?/setIdleLock"
					class="flex flex-col gap-4"
					use:enhance={(input) => {
						track(input);
						saving = true;
						return async ({ update }) => {
							await update({ reset: false });
							saving = false;
						};
					}}
				>
					<h3 class="text-section">Auto-lock</h3>

					{#if idleLockResult}
						<Alert {tone}>{form?.message}</Alert>
					{/if}

					<!-- The value is the stored setting, and empty when none is stored: there is
					     no default to show (CLAUDE.md, decision of 2026-09-15). -->
					<Field
						id="idle-lock"
						name="posIdleLockSeconds"
						label="Auto-lock after (seconds)"
						type="number"
						required
						numeric
						value={String(data.idleLockSeconds ?? '')}
						hint="From 30 to 1800 seconds. After this long with no touch, the till returns to employee select."
					/>
					<div class="flex flex-wrap items-center gap-3">
						<Button type="submit" disabled={saving}>
							{saving ? 'Saving…' : 'Save auto-lock'}
						</Button>
					</div>
				</form>
			</Card>
		{/snippet}
	</PageColumns>
</PageBody>
