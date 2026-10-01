<script lang="ts">
	// /pos/session — open a shift with a float, close it with a count (spec 10).
	// Laid out as docs/redesign Phase 4 asks: the context on the left, the keypad
	// card on the right, its closer the card's last element, always on screen.
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
	import Icon from '$lib/components/ui/Icon.svelte';
	import Keypad, { type KeypadKey } from '$lib/components/pos/Keypad.svelte';
	import TillBanner from '$lib/components/pos/TillBanner.svelte';
	import { KEY } from '$lib/components/pos/keys';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let ready = $state(false);
	let deviceId = $state<string | null>(null);
	let session = $state.raw<LocalSession | null>(null);
	let format = $state<MoneyFormat | null>(null);
	let noMenu = $state(false);
	let timeZone = $state<string | null>(null);
	let tillLabel = $state<string | null>(null);
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
		if (!online) lines.push({ id: 'why-offline', text: 'Offline — closing needs a connection' });
		if (unsynced === null) {
			lines.push({
				id: 'why-unknown',
				text: 'Unsynced count unavailable — this device cannot prove its queue is empty'
			});
		} else if (unsynced > 0) {
			lines.push({ id: 'why-unsynced', text: `${unsynced} operations still syncing` });
		}
		if (parked > 0) {
			lines.push({
				id: 'why-parked',
				text: `${parked} operations from a previous registration need the owner — see the dashboard`
			});
		}
		return lines;
	});

	function press(key: KeypadKey) {
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
			refusal = 'Not permitted: this employee cannot close a shift';
			waitingForNetwork = false;
		} else if (event.type === 'stopped' && event.clientOpId === closingOpId) {
			if (event.reason === 'session_has_unrecorded_ops') {
				refusal = `${event.count ?? 0} operations from this shift need the owner's review on the dashboard before it can close`;
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
			const [code, name] = await Promise.all(
				['deviceCode', 'restaurantName'].map((k) => readCachedSetting(k).catch(() => null))
			);
			tillLabel =
				typeof code === 'string' ? (typeof name === 'string' ? `${code} · ${name}` : code) : null;
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
			failure = 'This device could not record the shift — try again';
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
			failure = 'This device could not record the close — try again';
		} finally {
			busy = false;
		}
	}

	function done() {
		signOut();
		void goto(resolve('/pos'));
	}

	// The keypad card's hint — "50000 is 500.00 USD" — built from the cached
	// currency's own format rather than written for one currency.
	const keypadHint = $derived.by(() => {
		if (!format) return '';
		const digits = `500${'0'.repeat(format.exponent)}`;
		return `${digits} is ${formatMoney(minor(BigInt(digits)), format)}`;
	});
	// One line above Close shift, built from the blockers, so the reason for the
	// disabled closer sits right beside it (the full lines are in the left column).
	const blockedLine = $derived.by(() => {
		const parts: string[] = [];
		if (!online) parts.push('offline');
		if (unsynced === null) parts.push('unsynced count unavailable');
		else if (unsynced > 0) parts.push(`${unsynced} unsynced`);
		if (parked > 0) parts.push(`${parked} from a previous registration`);
		return parts.length === 0 ? null : `Can't close yet: ${parts.join(' · ')}`;
	});
	const openedSince = $derived(
		session === null
			? ''
			: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
					new Date(session.openedAt)
				)
	);
</script>

<svelte:head><title>Shift · matcami</title></svelte:head>

{#snippet readout(label: string, hint: string, headingId: string)}
	<div class="flex items-baseline justify-between gap-3">
		<h2 id={headingId} class="text-pos font-sans font-semibold">{label}</h2>
		<p class="text-body text-ink-2">{hint}</p>
	</div>
	{#if format}
		<output
			aria-live="polite"
			class="rounded-control border-control-line bg-bg text-total block border px-4 py-2 text-right font-mono tabular-nums"
			>{formatMoney(typed, format)}</output
		>
	{/if}
	<Keypad label="{label} keypad" onkey={press} />
{/snippet}

<!-- A two-column screen, vertically centred, that always fits: the context on the
     left, the keypad card on the right, its closer the card's last element. -->
<main class="relative flex min-h-0 flex-1 overflow-y-auto p-3 md:p-4 lg:p-6">
	{#if !ready}
		<p class="text-ink-2 m-auto">Loading the shift…</p>
	{:else if result && format}
		{@const negative = result.difference < 0n}
		{@const zero = result.difference === 0n}
		<section
			aria-labelledby="closed-h"
			class="rounded-card border-line bg-raise shadow-raised m-auto flex w-full max-w-xl flex-col gap-4 border p-6"
		>
			<h1 id="closed-h" class="text-display">Shift closed</h1>
			{#if result.businessDate}
				<p class="text-ink-2">
					Business date <span class="text-ink font-mono tabular-nums">{result.businessDate}</span>
				</p>
			{/if}
			<dl class="divide-line-soft flex flex-col divide-y">
				<div class="flex items-baseline justify-between gap-4 py-2">
					<dt class="text-ink-2">Expected</dt>
					<dd class="font-mono tabular-nums">{formatMoney(result.expected, format)}</dd>
				</div>
				<div class="flex items-baseline justify-between gap-4 py-2">
					<dt class="text-ink-2">Counted</dt>
					<dd class="font-mono tabular-nums">{formatMoney(result.counted, format)}</dd>
				</div>
				<div class="flex items-baseline justify-between gap-4 py-2">
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
				</div>
			</dl>
			<p class="text-ink-2">
				{zero ? 'Nothing was posted' : 'The server posted the difference to 6800 Cash Over/Short'}
			</p>
			<button
				type="button"
				class="min-h-touch-xl rounded-control border-control-line bg-accent text-title text-accent-ink w-full border font-semibold"
				onclick={done}>Done</button
			>
		</section>
	{:else if noMenu || !format}
		<section class="m-auto flex w-full max-w-xl flex-col items-start gap-3">
			<TillBanner tone="offline" live="status"
				>No menu on this device yet — connect once so the till can download it</TillBanner
			>
			<button type="button" class="min-h-touch-lg px-4 {KEY}" onclick={retryMenu}>Retry</button>
		</section>
	{:else if session === null}
		<div class="m-auto grid w-full max-w-5xl items-center gap-6 md:grid-cols-2 lg:gap-12">
			<div class="flex flex-col gap-5">
				<div class="flex flex-col gap-2">
					<p class="text-eyebrow text-ink-3 uppercase">Start of shift</p>
					<h1 class="text-display">Open a shift</h1>
				</div>
				<dl
					class="rounded-card border-line bg-raise divide-line-soft flex flex-col divide-y border px-4"
				>
					<div class="flex items-baseline justify-between gap-4 py-3">
						<dt class="text-ink-2">Business date</dt>
						<dd class="text-right font-mono tabular-nums">
							{expectedDate ?? 'set when the server confirms (no time zone cached)'}
						</dd>
					</div>
					<div class="flex items-baseline justify-between gap-4 py-3">
						<dt class="text-ink-2">Device clock</dt>
						<dd class="text-right">{deviceClock}</dd>
					</div>
					{#if tillLabel}
						<div class="flex items-baseline justify-between gap-4 py-3">
							<dt class="text-ink-2">Till</dt>
							<dd class="text-right">{tillLabel}</dd>
						</div>
					{/if}
					{#if signedIn.current}
						<div class="flex items-baseline justify-between gap-4 py-3">
							<dt class="text-ink-2">Cashier</dt>
							<dd class="text-right">{signedIn.current.displayName}</dd>
						</div>
					{/if}
				</dl>
				<p class="text-ink-2 flex items-start gap-3">
					<Icon name="info" class="size-5" />
					<span
						>The server sets the business date from the moment you open. Count the float in the
						drawer, then key it in.</span
					>
				</p>
			</div>
			<section
				aria-labelledby="float-h"
				class="rounded-card border-line bg-raise shadow-raised flex flex-col gap-3 border p-4"
			>
				{@render readout('Opening cash (the float)', keypadHint, 'float-h')}
				{#if failure}
					<TillBanner tone="danger" live="alert">{failure}</TillBanner>
				{/if}
				{#if busy}
					<p id="why-open" class="text-body text-ink-2">Saving the shift on this till…</p>
				{/if}
				<button
					type="button"
					disabled={busy}
					aria-describedby={busy ? 'why-open' : undefined}
					class="min-h-touch-xl rounded-control border-control-line text-title w-full border font-semibold {busy
						? 'bg-disabled-bg text-disabled-ink'
						: 'bg-accent text-accent-ink'}"
					onclick={open}>Open shift</button
				>
			</section>
		</div>
	{:else}
		<div class="m-auto grid w-full max-w-5xl items-center gap-6 md:grid-cols-2 lg:gap-12">
			<div class="flex flex-col gap-5">
				<div class="flex flex-col gap-2">
					<p class="text-eyebrow text-ink-3 uppercase">End of shift</p>
					<h1 class="text-display">Close this shift</h1>
					<p class="text-ink-2">
						Open on this till since {openedSince}
						{#if session.businessDate}
							· business date <span class="font-mono tabular-nums">{session.businessDate}</span>
						{/if}
					</p>
				</div>
				{#if session.state === 'closing'}
					<TillBanner tone="pending" live="status">Closing… waiting for the server</TillBanner>
					{#if waitingForNetwork}
						<TillBanner tone="offline">Waiting for a connection — the close is queued</TillBanner>
					{/if}
					{#if refusal}
						<TillBanner tone="danger" live="alert">{refusal}</TillBanner>
						<p class="text-ink-2">
							The close will retry by itself once the owner has resolved this on the dashboard
						</p>
					{/if}
				{:else}
					{#if blockers.length > 0}
						<ul aria-label="Why the shift cannot close yet" class="flex flex-col gap-2">
							{#each blockers as b (b.id)}
								<li
									id={b.id}
									class="rounded-control bg-st-offline-bg text-st-offline flex items-start gap-3 px-4 py-3"
								>
									<span aria-hidden="true" class="font-mono">◆&nbsp;</span><span>{b.text}</span>
								</li>
							{/each}
						</ul>
					{/if}
					<!-- Hidden while the session is closing: selling into a closing session
					     is exactly what the close must not race. -->
					<a
						href={resolve('/pos/order')}
						class="min-h-touch-min flex w-fit items-center gap-2 px-4 {KEY}"
					>
						<Icon name="arrow-left" class="size-5" />
						Back to the order
					</a>
				{/if}
			</div>
			{#if session.state !== 'closing'}
				<section
					aria-labelledby="count-h"
					class="rounded-card border-line bg-raise shadow-raised flex flex-col gap-3 border p-4"
				>
					{@render readout('Counted cash', 'A blind count', 'count-h')}
					{#if failure}
						<TillBanner tone="danger" live="alert">{failure}</TillBanner>
					{/if}
					{#if blockedLine}
						<p id="why-close" class="text-body text-st-offline flex items-start gap-2">
							<span aria-hidden="true" class="font-mono">◆&nbsp;</span>{blockedLine}
						</p>
					{/if}
					<button
						type="button"
						disabled={blockers.length > 0 || busy}
						aria-describedby={blockers.length > 0
							? ['why-close', ...blockers.map((b) => b.id)].join(' ')
							: undefined}
						class="min-h-touch-xl rounded-control border-control-line text-title w-full border font-semibold {blockers.length >
							0 || busy
							? 'bg-disabled-bg text-disabled-ink'
							: 'bg-accent text-accent-ink'}"
						onclick={close}>Close shift</button
					>
				</section>
			{/if}
		</div>
	{/if}
</main>
