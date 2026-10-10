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
		PageHeader,
		StatusMark,
		Table
	} from '$lib/components/ui';
	import { firstRunSteps, notCheckedLabel, osLabel, sizeLabel } from '$lib/print-agent-download';

	let { data, form } = $props();
	let saving = $state(false);

	// A restaurant may run MANY tills (decision of 2026-10-08): the load returns every
	// device it ever registered, revoked rows included, live ones first. LIVE = not
	// revoked; the onboarding checklist uses the same predicate (hasLiveDevice on the
	// server), so the two screens cannot disagree.
	const live = $derived(data.devices.filter((device) => device.revokedAt === null));
	const revoked = $derived(data.devices.filter((device) => device.revokedAt !== null));

	// Status carries its glyph, never colour alone (CLAUDE.md: WCAG 1.4.1).
	const columns = [
		{ key: 'label', label: 'Till' },
		{ key: 'deviceCode', label: 'Code' },
		{ key: 'registeredAt', label: 'Registered' },
		{ key: 'status', label: 'Status' },
		{ key: 'actions', label: '' }
	];

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
	description="The tills this restaurant sells from: see them, choose how soon they lock, open one, or revoke one."
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
			<h3 class="text-section">Registered tills</h3>

			{#if revokeResult}
				<Alert {tone}>{form?.message}</Alert>
			{/if}

			<!-- Spec 7: a device is registered ON THE TILL, not from here. Said whether
			     or not one exists, because every further till is registered the same way. -->
			<p class="text-ink-2">
				A till is registered on the device itself, not from this page: open the POS on that device
				and sign in there once with the owner’s email and password. The server then gives it a
				long-lived device cookie and the next free till code. Do this on every counter device you
				sell from; each till numbers its own invoices and runs its own shift. This page is where you
				see them and revoke them. Open the POS opens in a new tab.
			</p>

			<Table
				caption="Registered tills"
				{columns}
				rows={data.devices}
				empty="No till is registered yet."
			>
				{#snippet cell(device, key)}
					{#if key === 'label'}
						<span class={device.revokedAt === null ? 'text-ink font-medium' : 'text-ink-3'}>
							{device.label}
						</span>
					{:else if key === 'deviceCode'}
						<span class="font-mono">{device.deviceCode}</span>
					{:else if key === 'registeredAt'}
						<span class="text-ink-2">{when(device.registeredAt)}</span>
					{:else if key === 'status'}
						{#if device.revokedAt === null}
							<span class="text-ok"
								><span aria-hidden="true" class="font-mono">●</span> Live · last seen {device.lastSeenAt
									? when(device.lastSeenAt)
									: 'never'}</span
							>
						{:else}
							<span class="text-ink-3"
								><span aria-hidden="true" class="font-mono">✕</span> Revoked {when(
									device.revokedAt
								)}</span
							>
						{/if}
					{:else if key === 'actions'}
						{#if device.revokedAt === null}
							<!-- One form per live till, each with a distinct accessible name, so a
							     test — and a screen reader — can address exactly one. Not a modal:
							     modals are for POS reason codes, owner approval and errors. -->
							<form method="POST" action="?/revoke" use:enhance={track}>
								<!-- Not optional: the revoke action validates deviceId as a uuid and
								     answers 400 without it. -->
								<input type="hidden" name="deviceId" value={device.id} />
								<!-- Visible text "Revoke", accessible name "Revoke POS1": the code names
								     the row to a screen reader without printing it twice in the row. -->
								<Button variant="danger" type="submit" aria-label={`Revoke ${device.deviceCode}`}
									>Revoke</Button
								>
							</form>
						{/if}
					{/if}
				{/snippet}
			</Table>

			{#if live.length > 0}
				<p class="text-ink-2 text-sm">
					Revoking a till stops its PIN logins immediately; the owner signs in on it again to
					re-register it, and it then takes a new code — a code is never reused, so old invoices
					keep their meaning.
				</p>
			{:else if revoked.length > 0}
				<p class="text-ink-2 text-sm">Every till has been revoked. Register one to sell again.</p>
			{/if}
		</Card>

		<Card class="flex flex-col gap-3">
			<h3 class="text-section">Install the POS as an app</h3>
			<p class="text-ink-2">
				The POS installs from the browser as its own app — its own window and icon, no address bar,
				and it starts offline once installed. Open the POS on the till, then:
			</p>
			<ul class="text-ink-2 flex flex-col gap-1">
				<li>
					<span class="text-ink font-medium">Windows, Mac, Linux, Android (Chrome or Edge):</span>
					tap <span class="text-ink font-medium">Install app</span> on the sign-in screen, or use the
					install icon at the right of the address bar.
				</li>
				<li>
					<span class="text-ink font-medium">iPad and iPhone (Safari):</span>
					tap Share, then <span class="text-ink font-medium">Add to Home Screen</span>.
				</li>
				<li>
					<span class="text-ink font-medium">Firefox</span> cannot install web apps; use Chrome or Edge
					on that device.
				</li>
			</ul>
			<p class="text-ink-2 text-sm">
				Installing needs the site served over HTTPS; on a plain http:// address the browser offers
				no install and the till cannot start offline.
			</p>
		</Card>

		<!-- The print agent installers (tasks/print-agent-installer T-13): one file per
		     OS, built at deploy, carrying this app's address. Nothing to install first. -->
		<Card class="flex flex-col gap-3">
			<h3 class="text-section">Print agent</h3>
			<p class="text-ink-2">
				Prints receipts and kitchen tickets and opens the cash drawer. Install it once on the PC the
				till runs on.
			</p>
			{#if data.printAgent === null}
				<p class="text-ink-2">
					<StatusMark
						status="not-started"
						label="Not built yet — the installers are made when the app is deployed"
					/>
				</p>
			{:else}
				<ul class="flex flex-col gap-4">
					{#each data.printAgent.files as file (file.name)}
						<li class="flex flex-col gap-1">
							<div class="flex flex-wrap items-center gap-3">
								<Button href={file.url} download={file.name}
									>{`Download for ${osLabel(file.os, file.arch)}`}</Button
								>
								<span class="text-ink-2 text-sm">{sizeLabel(file.bytes)}</span>
								{#if !file.verified}
									<span class="text-ink-2 text-sm"
										><span aria-hidden="true" class="font-mono">◆</span>
										{notCheckedLabel(file.os)}</span
									>
								{/if}
							</div>
							<p class="text-ink-2 font-mono text-xs break-all">SHA-256 {file.sha256}</p>
						</li>
					{/each}
				</ul>
				<p class="text-ink-2 text-sm">
					Answers {data.printAgent.origin} · built {when(data.printAgent.builtAt)}
				</p>
				<details class="text-ink-2">
					<summary class="text-ink cursor-pointer font-medium">First run on this PC</summary>
					<dl class="mt-2 flex flex-col gap-2">
						{#each [{ os: 'windows', name: 'Windows' }, { os: 'macos', name: 'Mac' }, { os: 'linux', name: 'Linux' }] as const as entry (entry.os)}
							<div>
								<dt class="text-ink font-medium">{entry.name}</dt>
								{#each firstRunSteps(entry.os) as step, i (i)}
									<dd>{step}</dd>
								{/each}
							</div>
						{/each}
					</dl>
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
