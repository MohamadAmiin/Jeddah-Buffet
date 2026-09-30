<script lang="ts">
	// /pos/pay — the tender step. A completed CASH sale is a recorded fact the
	// moment completeSale resolves, online or not. Card and mobile never complete
	// offline: their keys are disabled with the reason written on them BEFORE the
	// tap (invariant 5). Change comes from changeDue; this file adds nothing up.
	import { getContext, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { minor, type Minor } from '$lib/money';
	import { formatAmount, formatMoney, moneyFormatFor, type MoneyFormat } from '$lib/money/format';
	import { changeDue, quickTenders } from '$lib/money/change';
	import { TAX_MODES, type TaxMode } from '$lib/money/tax';
	import { RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';
	import {
		abandonSale,
		cartTotals,
		completeSale,
		lineAmounts,
		readCart,
		type Cart,
		type CompleteSaleResult
	} from '$lib/pos/orders';
	import { readLocalSession } from '$lib/pos/session';
	import { flush, onFlushEvent, type FlushEvent } from '$lib/pos/queue';
	import { printOriginals, type OriginalsResult } from '$lib/pos/printing';
	import {
		readBoundDeviceId,
		readCachedSetting,
		readMenu,
		type LocalMenu,
		type LocalSession
	} from '$lib/pos/store';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	type Tender = 'cash' | 'card' | 'mobile';
	const TENDER_LABEL: Record<Tender, string> = {
		cash: 'Cash',
		card: 'Card',
		mobile: 'Mobile money'
	};

	let ready = $state(false);
	let deviceId = $state<string | null>(null);
	let deviceCode = $state<string | null>(null);
	let session = $state.raw<LocalSession | null>(null);
	let menu = $state.raw<LocalMenu | null>(null);
	let format = $state<MoneyFormat | null>(null);
	let taxMode = $state<TaxMode>('exclusive');
	// Raw: completeSale stores the cart, and a $state proxy cannot be cloned into IndexedDB.
	let cart = $state.raw<Cart | null>(null);
	let acceptsCard = $state(false);
	let acceptsMobile = $state(false);
	let online = $state(true);

	let tender = $state<Tender | null>('cash');
	let digits = $state('');
	let tendered = $state<Minor | null>(null);
	let busy = $state(false);
	let failure = $state('');

	let sale = $state<
		(CompleteSaleResult & { method: Tender; total: Minor; tendered: Minor | null }) | null
	>(null);
	let outcome = $state<'paid' | 'pending' | 'review' | 'refused'>('paid');
	let refusalReason = $state('');
	let waitingForNetwork = $state(false);
	// What printing said, AFTER the sale is already recorded and shown (invariant 4).
	let printLine = $state('');
	let drawerLine = $state('');

	const figures = $derived(
		cart ? { totals: cartTotals(cart, taxMode), amounts: lineAmounts(cart) } : null
	);
	const change = $derived(
		figures && tendered !== null && tendered >= figures.totals.total
			? changeDue(tendered, figures.totals.total)
			: null
	);
	const quick = $derived(
		figures && format ? quickTenders(figures.totals.total, format.exponent) : []
	);

	function reasonFor(t: Tender): string | null {
		if (t === 'cash') return null;
		const accepted = t === 'card' ? acceptsCard : acceptsMobile;
		if (!accepted) return 'Not accepted in settings';
		if (!online) return '◆ Cash only while offline';
		return null;
	}

	$effect(() => {
		// A card/mobile selection that loses its connection falls back to Cash.
		if (tender !== null && tender !== 'cash' && reasonFor(tender) !== null) tender = 'cash';
	});

	const payBlocked = $derived(
		busy
			? 'Recording…'
			: tender === null
				? 'Choose a tender'
				: tender === 'cash' && change === null
					? 'Enter the amount tendered'
					: null
	);

	function press(key: string) {
		if (key === 'back') digits = digits.slice(0, -1);
		else if (key === 'clear') digits = '';
		else if (digits.length < 12) digits = digits + key;
		tendered = digits === '' ? null : minor(BigInt(digits));
	}

	function chooseQuick(value: Minor) {
		digits = '';
		tendered = value;
	}

	function onEvent(event: FlushEvent) {
		if (sale === null) return;
		if (event.type === 'done' && event.clientOpId === sale.clientOpId) {
			if (event.status === 'unrecorded') outcome = 'review';
			else outcome = 'paid';
			waitingForNetwork = false;
		} else if (event.type === 'rejected' && event.clientOpId === sale.clientOpId) {
			outcome = 'refused';
			refusalReason =
				event.http === 403 ? 'this employee may not take payments' : (event.flag ?? event.error);
			waitingForNetwork = false;
		} else if (event.type === 'stopped' && event.reason === 'network' && outcome === 'pending') {
			waitingForNetwork = true;
		}
	}

	onMount(() => {
		online = navigator.onLine;
		const up = () => (online = true);
		const down = () => (online = false);
		addEventListener('online', up);
		addEventListener('offline', down);
		const stopEvents = onFlushEvent(onEvent);

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
			session = await readLocalSession(deviceId).catch(() => null);
			if (session === null) {
				void goto(resolve('/pos/session'));
				return;
			}
			menu = await readMenu().catch(() => null);
			const mode = menu?.taxMode ?? null;
			if (
				menu === null ||
				menu.currency === null ||
				mode === null ||
				!(TAX_MODES as readonly string[]).includes(mode)
			) {
				void goto(resolve('/pos/order'));
				return;
			}
			format = moneyFormatFor(menu.currency);
			taxMode = mode as TaxMode;
			cart = await readCart(deviceId).catch(() => null);
			if (cart === null || cart.lines.length === 0) {
				void goto(resolve('/pos/order'));
				return;
			}
			acceptsCard = (await readCachedSetting('acceptsCard').catch(() => null)) === true;
			acceptsMobile = (await readCachedSetting('acceptsMobile').catch(() => null)) === true;
			const code = await readCachedSetting('deviceCode').catch(() => null);
			deviceCode = typeof code === 'string' ? code : null;
			ready = true;
		})();

		return () => {
			removeEventListener('online', up);
			removeEventListener('offline', down);
			stopEvents();
		};
	});

	async function pay() {
		if (
			payBlocked !== null ||
			tender === null ||
			!cart ||
			!menu ||
			!figures ||
			!session ||
			deviceId === null ||
			signedIn.current === null
		) {
			return;
		}
		if (deviceCode === null) {
			failure = '✕ This till has no device code cached — go back to employee select once online';
			return;
		}
		busy = true;
		failure = '';
		try {
			const method = tender;
			const result = await completeSale({
				cart,
				deviceId,
				deviceCode,
				posSessionId: session.posSessionId,
				employeeId: signedIn.current.id,
				taxMode,
				currencyCode: menu.currency as string,
				menuVersion: menu.version,
				payment: { method, tenderedMinor: method === 'cash' ? tendered : null },
				now: new Date(),
				// Kept on the local order for the receipt (T-18).
				cashierName: signedIn.current.displayName,
				businessDate: session.businessDate ?? null
			});
			outcome = method === 'cash' ? 'paid' : 'pending';
			sale = {
				...result,
				method,
				total: figures.totals.total,
				tendered: method === 'cash' ? tendered : null
			};
			void flush().catch(() => {});
			if (method === 'cash') {
				// Fire-and-report: the sale is complete on the device; the printer
				// never holds up ● Paid (invariant 4). Card and mobile print from the
				// layout's auto-printer once the server confirms (invariant 5).
				printLine = '';
				drawerLine = '';
				void printOriginals(result.orderId, { drawer: true }).then(describePrint, () => {
					printLine = '◆ Not printed — reprint it from Sales';
				});
			}
		} catch (err) {
			failure = `✕ ${err instanceof Error ? err.message : 'The sale could not be recorded'}`;
		} finally {
			busy = false;
		}
	}

	function describePrint(result: OriginalsResult) {
		const printed = result.receipt === 'queued' || result.receipt === 'duplicate';
		printLine = printed ? '● Receipt sent to the printer' : '◆ Not printed — reprint it from Sales';
		drawerLine =
			result.drawer === 'too_late' || result.drawer === 'printer_unreachable'
				? '◆ The drawer did not open'
				: '';
	}

	async function cancelPending() {
		if (!sale) return;
		try {
			await abandonSale(sale.orderId, 'cancelled');
		} finally {
			void goto(resolve('/pos/order'));
		}
	}

	const key =
		'min-h-touch-lg min-w-touch-lg border border-control-line rounded-control bg-raise text-ink font-mono font-medium text-title';
	const closer =
		'min-h-touch-xl w-full border border-control-line rounded-control font-semibold text-pos';
</script>

<svelte:head><title>Pay · matcami</title></svelte:head>

<main class="text-pos flex flex-col gap-6 overflow-x-hidden px-4 py-6 md:flex-row md:items-start">
	{#if !ready || !figures || !format || !cart}
		<p class="text-ink-2">Loading the bill…</p>
	{:else if sale}
		<section class="mx-auto flex w-full max-w-xl flex-col gap-4" aria-live="polite">
			{#if outcome === 'paid'}
				<p class="bg-st-paid-bg text-st-paid rounded-control px-3 py-2 font-semibold">● Paid</p>
				{#if printLine}
					<p
						data-testid="print-line"
						class="rounded-control px-3 py-2 {printLine.startsWith('●')
							? 'bg-ok-bg text-ok'
							: 'bg-st-offline-bg text-st-offline'}"
					>
						{printLine}
					</p>
				{/if}
				{#if drawerLine}
					<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">{drawerLine}</p>
				{/if}
			{:else if outcome === 'pending'}
				<p class="bg-st-billed-bg text-st-billed rounded-control px-3 py-2">
					◐ Waiting for the server to confirm…
				</p>
				<p
					class="bg-st-billed-bg text-st-billed rounded-control px-3 py-2"
					data-testid="print-line"
				>
					◐ The receipt prints once the payment is confirmed
				</p>
				{#if waitingForNetwork}
					<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
						◆ Waiting for a connection
					</p>
				{/if}
			{:else if outcome === 'review'}
				<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
					◆ Recorded for the owner's review — not confirmed as paid
				</p>
			{:else}
				<p class="bg-danger-bg text-danger rounded-control px-3 py-2">
					✕ Not recorded: {refusalReason}
				</p>
				<p class="text-ink-2">The card terminal's charge, if any, must be voided on the terminal</p>
			{/if}
			<p class="font-mono">Invoice {sale.invoiceNumber}</p>
			<dl class="grid grid-cols-2 gap-y-1">
				<dt class="text-ink-2">Total</dt>
				<dd class="text-right font-mono tabular-nums">{formatMoney(sale.total, format)}</dd>
				{#if sale.method === 'cash' && sale.tendered !== null && sale.changeMinor !== null}
					<dt class="text-ink-2">Tendered</dt>
					<dd class="text-right font-mono tabular-nums">{formatMoney(sale.tendered, format)}</dd>
					<dt class="text-ink-2">Change</dt>
					<dd class="text-right font-mono tabular-nums">
						{formatMoney(minor(sale.changeMinor), format)}
					</dd>
				{/if}
			</dl>
			{#if outcome === 'review' || outcome === 'refused'}
				<a
					class="{closer} bg-raise text-ink flex items-center justify-center"
					href={resolve('/pos/order')}>Back to order</a
				>
			{:else}
				{#if outcome === 'pending'}
					<button
						type="button"
						class="min-h-touch-lg border-control-line rounded-control bg-raise text-ink border px-4"
						onclick={cancelPending}>Cancel</button
					>
				{/if}
				<a
					class="{closer} bg-accent text-accent-ink flex items-center justify-center"
					href={resolve('/pos/order')}>New sale</a
				>
			{/if}
		</section>
	{:else}
		<section aria-label="Bill" class="flex min-w-0 flex-1 flex-col gap-4">
			<div class="flex items-center justify-between gap-2">
				<h1 class="text-title text-ink">Amount due</h1>
				<span class="bg-st-billed-bg text-st-billed rounded-control px-2">◐ BILLED</span>
			</div>
			<p class="text-total text-ink text-right font-mono tabular-nums">
				{formatMoney(figures.totals.total, format)}
			</p>
			<ul class="flex flex-col gap-1">
				{#each cart.lines as line, i (line.lineId)}
					<li class="flex justify-between gap-2">
						<span>{line.itemName} ×{line.quantity}</span>
						<span class="font-mono tabular-nums">{formatAmount(figures.amounts[i], format)}</span>
					</li>
				{/each}
			</ul>
			<dl class="text-ink-2 grid grid-cols-2 gap-y-1">
				<dt>Subtotal</dt>
				<dd class="text-right font-mono tabular-nums">
					{formatMoney(figures.totals.subtotal, format)}
				</dd>
				{#if figures.totals.discount !== 0n}
					<dt>Discount</dt>
					<dd class="text-right font-mono tabular-nums">
						{formatMoney(figures.totals.discount, format)}
					</dd>
				{/if}
				<dt>Tax</dt>
				<dd class="text-right font-mono tabular-nums">{formatMoney(figures.totals.tax, format)}</dd>
				<dt>Total</dt>
				<dd class="text-right font-mono tabular-nums">
					{formatMoney(figures.totals.total, format)}
				</dd>
			</dl>

			<div role="group" aria-label="Tender" class="grid grid-cols-3 gap-2">
				{#each ['cash', 'card', 'mobile'] as const as t (t)}
					{@const why = reasonFor(t)}
					<button
						type="button"
						aria-pressed={tender === t}
						disabled={why !== null}
						aria-describedby={why !== null ? `why-${t}` : undefined}
						class="min-h-touch-lg border-control-line rounded-control flex flex-col items-center justify-center border px-2 {why !==
						null
							? 'bg-disabled-bg text-disabled-ink'
							: tender === t
								? 'bg-accent text-accent-ink'
								: 'bg-raise text-ink'}"
						onclick={() => (tender = t)}
					>
						<span>{TENDER_LABEL[t]}</span>
						{#if why}<span class="text-caption">{why}</span>{/if}
					</button>
				{/each}
			</div>
			{#each ['card', 'mobile'] as const as t (t)}
				{@const why = reasonFor(t)}
				{#if why}<p id="why-{t}" class="sr-only">{TENDER_LABEL[t]}: {why}</p>{/if}
			{/each}
		</section>

		<section aria-label="Payment" class="flex min-w-0 flex-1 flex-col gap-4">
			{#if tender === 'cash'}
				<h2 class="text-section text-ink">Quick cash</h2>
				<div class="flex flex-wrap gap-2">
					{#each quick as value, i (value)}
						<button
							type="button"
							class="min-h-touch-lg border-control-line rounded-control bg-raise text-ink border px-4 font-mono"
							onclick={() => chooseQuick(value)}
						>
							{i === 0 ? 'Exact' : formatMoney(value, format)}
						</button>
					{/each}
				</div>
				<section aria-label="Amount tendered" class="flex flex-col gap-3">
					<p class="text-right font-mono tabular-nums">
						Amount tendered: {formatMoney(tendered ?? minor(0n), format)}
					</p>
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
				<div>
					<p class="text-ink-2">Change due</p>
					{#if change !== null}
						<p class="text-total text-right font-mono tabular-nums">
							{formatMoney(change, format)}
						</p>
					{:else}
						<p class="text-ink-2">Tendered is less than the amount due</p>
					{/if}
				</div>
			{/if}

			{#if failure}
				<p class="bg-danger-bg text-danger rounded-control px-3 py-2">{failure}</p>
			{/if}
			<button
				type="button"
				disabled={payBlocked !== null}
				class="{closer} {payBlocked !== null
					? 'bg-disabled-bg text-disabled-ink'
					: 'bg-accent text-accent-ink'}"
				onclick={pay}
			>
				{#if payBlocked !== null}
					{payBlocked}
				{:else}
					Pay · {TENDER_LABEL[tender as Tender]} {formatMoney(figures.totals.total, format)}
				{/if}
			</button>
			<a class="text-ink-2 text-center underline" href={resolve('/pos/order')}>Back to the check</a>
		</section>
	{/if}
</main>
