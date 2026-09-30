<script lang="ts">
	// /pos/session — open a shift with a float, close it with a count (spec 10).
	//
	// The keypad's digits ARE minor units: 50000 reads 500.00 USD. BigInt of a
	// digit string is the one way a typed amount becomes money here. The till
	// never computes expected cash; the close result shows the server's figures.
	import { getContext, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { minor, type Minor } from '$lib/money';
	import { formatMoney, moneyFormatFor, type MoneyFormat } from '$lib/money/format';
	import { RESTORED_CONTEXT, signedIn, signOut } from '$lib/pos/employee.svelte';
	import { closeLocalSession, openLocalSession, readLocalSession } from '$lib/pos/session';
	import { flush, onFlushResult, parkedCount, type FlushEvent } from '$lib/pos/queue';
	import {
		countUnsynced,
		onUnsyncedChange,
		readBoundDeviceId,
		readCachedSetting,
		readMenu,
		syncMenu,
		type LocalSession
	} from '$lib/pos/store';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let ready = $state(false);
	let deviceId = $state<string | null>(null);
	let session = $state.raw<LocalSession | null>(null);
	let format = $state<MoneyFormat | null>(null);
	let noMenu = $state(false);
	let timeZone = $state<string | null>(null);
	let clock = $state(new Date());

	let online = $state(true);
	let unsynced = $state<number | null>(null);
	let parked = $state(0);

	let digits = $state('');
	let busy = $state(false);
	let failure = $state('');

	let closingOpId = $state<string | null>(null);
	let countedTyped = $state<Minor | null>(null);
	let refusal = $state('');
	let waitingForNetwork = $state(false);
	let result = $state<{
		businessDate: string | null;
		expected: Minor;
		counted: Minor;
		difference: Minor;
	} | null>(null);

	const typed = $derived(minor(BigInt(digits === '' ? '0' : digits)));

	const expectedDate = $derived(
		timeZone === null
			? null
			: new Intl.DateTimeFormat('en-CA', {
					timeZone,
					year: 'numeric',
					month: '2-digit',
					day: '2-digit'
				}).format(clock)
	);
	const deviceClock = $derived(
		new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(clock)
	);

	const blockers = $derived.by(() => {
		const lines: { id: string; text: string }[] = [];
		if (!online) lines.push({ id: 'why-offline', text: '◆ Offline — closing needs a connection' });
		if (unsynced === null) {
			lines.push({
				id: 'why-unknown',
				text: '◆ Unsynced count unavailable — this device cannot prove its queue is empty'
			});
		} else if (unsynced > 0) {
			lines.push({ id: 'why-unsynced', text: `◆ ${unsynced} operations still syncing` });
		}
		if (parked > 0) {
			lines.push({
				id: 'why-parked',
				text: `◆ ${parked} operations from a previous registration need the owner — see the dashboard`
			});
		}
		return lines;
	});

	function press(key: string) {
		if (key === 'back') digits = digits.slice(0, -1);
		else if (key === 'clear') digits = '';
		else if (digits.length < 12) digits = digits + key;
	}

	async function reloadState() {
		if (deviceId === null) return;
		try {
			session = await readLocalSession(deviceId);
		} catch {
			session = null;
		}
	}

	async function recount() {
		try {
			unsynced = await countUnsynced();
		} catch {
			unsynced = null;
		}
		try {
			parked = await parkedCount();
		} catch {
			parked = 0;
		}
	}

	async function loadMenuFormat() {
		const menu = await readMenu().catch(() => null);
		if (menu === null || menu.currency === null) {
			noMenu = true;
			format = null;
			return;
		}
		try {
			format = moneyFormatFor(menu.currency);
			noMenu = false;
		} catch {
			noMenu = true;
			format = null;
		}
	}

	async function retryMenu() {
		await syncMenu().catch(() => undefined);
		await loadMenuFormat();
	}

	function onEvent(event: FlushEvent) {
		if (closingOpId === null) return;
		if (event.type === 'done' && event.clientOpId === closingOpId) {
			if (event.status === 'accepted' || event.status === 'replayed') {
				const body = event.body;
				result = {
					businessDate: body.businessDate ?? null,
					expected: minor(BigInt(body.expectedCashMinor ?? '0')),
					counted: countedTyped ?? minor(0n),
					difference: minor(BigInt(body.differenceMinor ?? '0'))
				};
				waitingForNetwork = false;
			}
		} else if (
			event.type === 'rejected' &&
			event.clientOpId === closingOpId &&
			event.http === 403
		) {
			refusal = '✕ Not permitted: this employee cannot close a session';
			waitingForNetwork = false;
		} else if (event.type === 'stopped' && event.clientOpId === closingOpId) {
			if (event.reason === 'session_has_unrecorded_ops') {
				refusal = `✕ ${event.count ?? 0} operations from this session need the owner's review on the dashboard before it can close`;
				waitingForNetwork = false;
			} else if (event.reason === 'network') {
				waitingForNetwork = true;
			}
		}
		void reloadState();
	}

	onMount(() => {
		online = navigator.onLine;
		const up = () => (online = true);
		const down = () => (online = false);
		addEventListener('online', up);
		addEventListener('offline', down);
		const tick = setInterval(() => (clock = new Date()), 30_000);
		const stopUnsynced = onUnsyncedChange(() => void recount());
		const stopFlush = onFlushResult(onEvent);

		void (async () => {
			await restored;
			if (!signedIn.current) {
				void goto(resolve('/pos'));
				return;
			}
			deviceId = await readBoundDeviceId().catch(() => null);
			if (deviceId === null) {
				void goto(resolve('/pos'));
				return;
			}
			await reloadState();
			await loadMenuFormat();
			const zone = await readCachedSetting('timeZone').catch(() => null);
			timeZone = typeof zone === 'string' ? zone : null;
			await recount();
			ready = true;
		})();

		return () => {
			removeEventListener('online', up);
			removeEventListener('offline', down);
			clearInterval(tick);
			stopUnsynced();
			stopFlush();
		};
	});

	async function open() {
		if (deviceId === null || signedIn.current === null) return;
		busy = true;
		failure = '';
		try {
			await openLocalSession({
				deviceId,
				employeeId: signedIn.current.id,
				openingCashMinor: typed,
				now: new Date()
			});
			void flush().catch(() => {});
			void goto(resolve('/pos/order'));
		} catch {
			failure = '✕ This device could not record the session — try again';
		} finally {
			busy = false;
		}
	}

	async function close() {
		if (deviceId === null || signedIn.current === null || blockers.length > 0) return;
		busy = true;
		failure = '';
		refusal = '';
		try {
			countedTyped = typed;
			const { clientOpId } = await closeLocalSession({
				deviceId,
				employeeId: signedIn.current.id,
				countedCashMinor: typed,
				now: new Date()
			});
			// Subscribed since mount; set the id before the flush so a fast answer lands.
			closingOpId = clientOpId;
			digits = '';
			await reloadState();
			void flush().catch(() => {});
		} catch {
			failure = '✕ This device could not record the close — try again';
		} finally {
			busy = false;
		}
	}

	function done() {
		signOut();
		void goto(resolve('/pos'));
	}

	const key =
		'min-h-touch-lg min-w-touch-lg border border-control-line rounded-control bg-raise text-ink font-mono font-medium text-title';
	const closer =
		'min-h-touch-xl w-full border border-control-line rounded-control font-semibold text-pos';
	const enabledCloser = 'bg-accent text-accent-ink';
	const disabledCloser = 'bg-disabled-bg text-disabled-ink';
</script>

<svelte:head><title>Session · matcami</title></svelte:head>

{#snippet keypad(label: string)}
	<section aria-label={label} class="flex flex-col gap-3">
		<h3 class="text-section text-ink">{label}</h3>
		{#if format}
			<p class="text-total text-ink text-right font-mono tabular-nums" aria-live="polite">
				{formatMoney(typed, format)}
			</p>
		{/if}
		<p class="text-caption text-ink-2">Keys enter cents: 50000 is 500.00 USD</p>
		<div class="grid grid-cols-3 gap-2">
			{#each ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as d (d)}
				<button type="button" class={key} onclick={() => press(d)}>{d}</button>
			{/each}
			<button type="button" class={key} onclick={() => press('clear')}>Clear</button>
			<button type="button" class={key} onclick={() => press('0')}>0</button>
			<button type="button" class={key} onclick={() => press('back')}>
				<span aria-hidden="true">⌫</span><span class="sr-only">Delete the last digit</span>
			</button>
		</div>
	</section>
{/snippet}

<main class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
	{#if !ready}
		<p class="text-ink-2">Loading the session…</p>
	{:else if result && format}
		{@const negative = result.difference < 0n}
		{@const zero = result.difference === 0n}
		<h2 class="text-title text-ink">Session closed</h2>
		{#if result.businessDate}
			<p class="font-mono">Business date {result.businessDate}</p>
		{/if}
		<dl class="grid grid-cols-2 gap-y-2">
			<dt class="text-ink-2">Expected</dt>
			<dd class="text-right font-mono tabular-nums">{formatMoney(result.expected, format)}</dd>
			<dt class="text-ink-2">Counted</dt>
			<dd class="text-right font-mono tabular-nums">{formatMoney(result.counted, format)}</dd>
			<dt class="text-ink-2">Difference</dt>
			<dd
				class="text-right font-mono tabular-nums {negative
					? 'text-danger'
					: zero
						? 'text-ok'
						: 'text-warn'}"
			>
				{formatMoney(result.difference, format)}
				{#if negative}✕ Short{:else if zero}● Balanced{:else}▲ Over{/if}
			</dd>
		</dl>
		<p class="text-ink-2">
			{zero ? 'Nothing was posted' : 'The server posted the difference to 6800 Cash Over/Short'}
		</p>
		<button type="button" class="{closer} {enabledCloser}" onclick={done}>Done</button>
	{:else if noMenu || !format}
		<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
			◆ No menu on this device yet — connect once so the till can download it
		</p>
		<button
			type="button"
			class="min-h-touch-lg border-control-line rounded-control bg-raise text-ink border px-4"
			onclick={retryMenu}>Retry</button
		>
	{:else if session === null}
		<h2 class="text-title text-ink">Open a session</h2>
		<p class="font-mono">
			{#if expectedDate}
				Business date: {expectedDate}
			{:else}
				Business date: set when the server confirms (no time zone cached)
			{/if}
		</p>
		<p class="text-ink-2">Device clock: {deviceClock}</p>
		<p class="text-ink-2">The server sets the business date from the moment you open</p>
		{@render keypad('Opening cash (the float)')}
		{#if failure}
			<p class="bg-danger-bg text-danger rounded-control px-3 py-2">{failure}</p>
		{/if}
		<button
			type="button"
			class="{closer} {busy ? disabledCloser : enabledCloser}"
			disabled={busy}
			onclick={open}
		>
			Open session
		</button>
	{:else}
		<p class="text-ink-2">
			A session is already open on this till since {new Intl.DateTimeFormat(undefined, {
				dateStyle: 'medium',
				timeStyle: 'short'
			}).format(new Date(session.openedAt))}
		</p>
		<a
			class="{closer} {enabledCloser} flex items-center justify-center"
			href={resolve('/pos/order')}>Continue</a
		>
		<h2 class="text-title text-ink">Close this session</h2>
		{#if session.state === 'closing'}
			<p class="bg-st-billed-bg text-st-billed rounded-control px-3 py-2">
				◐ Closing… waiting for the server
			</p>
			{#if waitingForNetwork}
				<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
					◆ Waiting for a connection — the close is queued
				</p>
			{/if}
			{#if refusal}
				<p class="bg-danger-bg text-danger rounded-control px-3 py-2">{refusal}</p>
				<p class="text-ink-2">
					The close will retry by itself once the owner has resolved this on the dashboard
				</p>
			{/if}
		{:else}
			{#each blockers as b (b.id)}
				<p id={b.id} class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">{b.text}</p>
			{/each}
			{@render keypad('Counted cash')}
			{#if failure}
				<p class="bg-danger-bg text-danger rounded-control px-3 py-2">{failure}</p>
			{/if}
			<button
				type="button"
				class="{closer} {blockers.length > 0 || busy ? disabledCloser : enabledCloser}"
				disabled={blockers.length > 0 || busy}
				aria-describedby={blockers.length > 0 ? blockers.map((b) => b.id).join(' ') : undefined}
				onclick={close}
			>
				Close session
			</button>
		{/if}
	{/if}
</main>
