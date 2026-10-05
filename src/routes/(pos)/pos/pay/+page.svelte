<script lang="ts">
	// /pos/pay — the tender step (docs/redesign Phase 3): the tender pane on the
	// left, THE SAME Check as the order screen on the right in `bill` mode — so
	// modifiers, unit prices and tax rates stay visible — and the closer pinned to
	// the bottom-right, the spot where Pay was. The document never scrolls.
	//
	// /pos/pay — the tender step. The tenders are the owner's NAMED methods from
	// the till's cache (tenders.ts, settings-tax-payments-receipt T-22): Cash
	// always first, then each card- or mobile-kind method under its name, with
	// its merchant number shown once chosen. Every decision here keys on the
	// method's KIND, never its name. A completed CASH sale is a recorded fact the
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
	import { readPaymentMethods } from '$lib/pos/settings';
	import {
		readBoundDeviceId,
		readCachedSetting,
		readMenu,
		type LocalMenu,
		type LocalSession
	} from '$lib/pos/store';
	import { lineTaxRateText } from '$lib/pos/menu-view';
	import {
		CASH_TENDER_KEY,
		tenderOptions,
		tenderReason,
		type TenderKind,
		type TenderOption
	} from '$lib/pos/tenders';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Check from '$lib/components/pos/Check.svelte';
	import Closer from '$lib/components/pos/Closer.svelte';
	import Keypad, { type KeypadKey } from '$lib/components/pos/Keypad.svelte';
	import TillBanner from '$lib/components/pos/TillBanner.svelte';
	import type { CheckLineView } from '$lib/components/pos/CheckLine.svelte';
	import { KEY, KEY_CHOSEN } from '$lib/components/pos/keys';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let ready = $state(false);
	let deviceId = $state<string | null>(null);
	let deviceCode = $state<string | null>(null);
	let session = $state.raw<LocalSession | null>(null);
	let menu = $state.raw<LocalMenu | null>(null);
	let format = $state<MoneyFormat | null>(null);
	let taxMode = $state<TaxMode>('exclusive');
	// Raw: completeSale stores the cart, and a $state proxy cannot be cloned into IndexedDB.
	let cart = $state.raw<Cart | null>(null);
	// The tenders: Cash is offered before the cache read lands (tenders.ts).
	let options = $state.raw<TenderOption[]>(tenderOptions([]));
	let online = $state(true);

	// The chosen option's KEY: `cash`, or a method's id.
	let tender = $state<string | null>(CASH_TENDER_KEY);
	let digits = $state('');
	let tendered = $state<Minor | null>(null);
	let busy = $state(false);
	let failure = $state('');

	let sale = $state<
		| (CompleteSaleResult & {
				kind: TenderKind;
				name: string;
				total: Minor;
				tendered: Minor | null;
		  })
		| null
	>(null);
	let outcome = $state<'paid' | 'pending' | 'review' | 'refused'>('paid');
	let refusalReason = $state('');
	let waitingForNetwork = $state(false);
	// What printing said, AFTER the sale is already recorded and shown (invariant 4).
	// Words only: TillBanner draws the glyph.
	let print = $state<{ ok: boolean; text: string } | null>(null);
	let drawerLine = $state('');

	const figures = $derived(
		cart ? { totals: cartTotals(cart, taxMode), amounts: lineAmounts(cart) } : null
	);
	// CASH WITH NOTHING KEYED IS THE EXACT AMOUNT (decided 2026-10-01): Pay works
	// at once, the way a cashier handed the right money expects, and `tendered`
	// stays null only as "the cashier has not said otherwise". Keying an amount or
	// tapping a quick-cash key replaces it; an amount below the total blocks Pay.
	const cashTendered = $derived(tendered ?? figures?.totals.total ?? null);
	const change = $derived(
		figures && cashTendered !== null && cashTendered >= figures.totals.total
			? changeDue(cashTendered, figures.totals.total)
			: null
	);
	const quick = $derived(
		figures && format ? quickTenders(figures.totals.total, format.exponent) : []
	);

	const selected = $derived(options.find((o) => o.key === tender) ?? null);

	// THE offline rule, by KIND (invariant 5): cash never; card and mobile while offline.
	function reasonFor(o: TenderOption): string | null {
		return tenderReason(o.kind, online);
	}

	$effect(() => {
		// A choice that is no longer offered, or a card/mobile choice that loses
		// its connection, falls back to Cash.
		if (selected === null || (selected.kind !== 'cash' && reasonFor(selected) !== null)) {
			tender = CASH_TENDER_KEY;
		}
	});

	const payBlocked = $derived(
		busy
			? 'Recording…'
			: selected === null
				? 'Choose a tender'
				: selected.kind === 'cash' && change === null
					? 'The amount tendered is less than the total'
					: null
	);

	function press(key: KeypadKey) {
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
			options = tenderOptions(await readPaymentMethods().catch(() => []));
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
			selected === null ||
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
			failure = 'This till has no device code cached — go back to employee select once online';
			return;
		}
		busy = true;
		failure = '';
		try {
			// Captured once: every decision below keys on the option's KIND.
			const option = selected;
			const result = await completeSale({
				cart,
				deviceId,
				deviceCode,
				posSessionId: session.posSessionId,
				employeeId: signedIn.current.id,
				taxMode,
				currencyCode: menu.currency as string,
				menuVersion: menu.version,
				payment: {
					method: option.kind,
					tenderedMinor: option.kind === 'cash' ? cashTendered : null,
					// The owner-named method, id and name always as a pair; the synthetic
					// Cash sends both null and the server resolves the restaurant's Cash
					// row and its name (T-15).
					paymentMethodId: option.id,
					paymentMethodName: option.id === null ? null : option.name
				},
				now: new Date(),
				// Kept on the local order for the receipt (T-18).
				cashierName: signedIn.current.displayName,
				businessDate: session.businessDate ?? null
			});
			outcome = option.kind === 'cash' ? 'paid' : 'pending';
			sale = {
				...result,
				kind: option.kind,
				name: option.name,
				total: figures.totals.total,
				tendered: option.kind === 'cash' ? cashTendered : null
			};
			void flush().catch(() => {});
			if (option.kind === 'cash') {
				// Fire-and-report: the sale is complete on the device; the printer
				// never holds up ● Paid (invariant 4). Card and mobile print from the
				// layout's auto-printer once the server confirms (invariant 5).
				print = null;
				drawerLine = '';
				void printOriginals(result.orderId, { drawer: true }).then(describePrint, () => {
					print = { ok: false, text: 'Not printed — reprint it from Sales' };
				});
			}
		} catch (err) {
			failure = `${err instanceof Error ? err.message : 'The sale could not be recorded'}`;
		} finally {
			busy = false;
		}
	}

	function describePrint(result: OriginalsResult) {
		const printed = result.receipt === 'queued' || result.receipt === 'duplicate';
		print = printed
			? { ok: true, text: 'Receipt sent to the printer' }
			: { ok: false, text: 'Not printed — reprint it from Sales' };
		drawerLine =
			result.drawer === 'too_late' || result.drawer === 'printer_unreachable'
				? 'The drawer did not open'
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

	// The tender radio group: only the checked radio is in the tab order, and the
	// arrow keys move the choice, skipping a tender that is disabled.
	let tenderRadios = $state<HTMLButtonElement[]>([]);
	function tenderKey(event: KeyboardEvent, index: number) {
		const step =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? -1
					: 0;
		if (step === 0) return;
		event.preventDefault();
		for (let n = 1; n < options.length; n++) {
			const next = (index + step * n + options.length) % options.length;
			if (reasonFor(options[next]) === null) {
				tender = options[next].key;
				tenderRadios[next]?.focus();
				return;
			}
		}
	}

	// "Keys enter cents: 2000 is 20.00 USD", built from the cached currency's own
	// format rather than written for one currency.
	const keypadHint = $derived.by(() => {
		if (!format) return '';
		if (format.exponent === 0) return 'Keys enter whole amounts';
		const digits = `20${'0'.repeat(format.exponent)}`;
		return `Keys enter cents: ${digits} is ${formatMoney(minor(BigInt(digits)), format)}`;
	});

	// The check's lines and totals as strings — the money module formats them.
	const checkLines = $derived.by((): CheckLineView[] => {
		if (!cart || !figures || !format) return [];
		const money = format;
		return cart.lines.map((line, i) => ({
			id: line.lineId,
			quantity: line.quantity,
			name: line.itemName,
			modifiers: line.modifiers.map((m) => ({
				id: m.modifierId,
				name: m.modifierName,
				delta: formatAmount(minor(m.priceDeltaMinor), money),
				negative: m.priceDeltaMinor < 0n
			})),
			unitPrice: formatAmount(minor(line.unitPriceMinor), money),
			taxRate: lineTaxRateText(line),
			amount: formatAmount(figures.amounts[i], money)
		}));
	});
	const checkTotals = $derived.by(() => {
		if (!figures || !format) return null;
		return {
			subtotal: formatMoney(figures.totals.subtotal, format),
			discount:
				figures.totals.discount !== 0n ? formatMoney(figures.totals.discount, format) : null,
			tax: formatMoney(figures.totals.tax, format),
			taxMode,
			total: formatMoney(figures.totals.total, format)
		};
	});
	const checkPill = $derived(
		sale === null
			? { glyph: '◐' as const, word: 'BILLED' }
			: outcome === 'paid'
				? { glyph: '●' as const, word: 'PAID' }
				: outcome === 'pending'
					? { glyph: '◐' as const, word: 'PENDING' }
					: outcome === 'review'
						? { glyph: '◆' as const, word: 'FOR REVIEW' }
						: { glyph: '✕' as const, word: 'NOT RECORDED' }
	);
	const caption = $derived(
		cart === null
			? ''
			: cart.orderType === 'takeaway'
				? 'Takeaway'
				: cart.orderType === 'delivery'
					? 'Delivery'
					: cart.tableLabel
						? `Dine in · Table ${cart.tableLabel}`
						: 'Dine in'
	);
</script>

<svelte:head><title>Pay · matcami</title></svelte:head>

<!-- The closer slot: Pay · {tender} before the sale; New sale or Back to order
     after it. Always the bottom-right of the check (or the pinned row on a phone). -->
{#snippet closers(uid: string)}
	{#if figures && format}
		{#if sale}
			{#if outcome === 'review' || outcome === 'refused'}
				<Closer href={resolve('/pos/order')} tone="raise">Back to order</Closer>
			{:else}
				<Closer href={resolve('/pos/order')}>New sale</Closer>
			{/if}
		{:else}
			<Closer
				disabled={payBlocked !== null}
				reason={payBlocked ?? undefined}
				reasonId="{uid}-why-pay"
				onclick={pay}
			>
				Pay · {selected?.name ?? 'Cash'}
				<span class="font-mono font-medium tabular-nums"
					>{formatMoney(figures.totals.total, format)}</span
				>
			</Closer>
		{/if}
	{/if}
{/snippet}

<main class="flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row md:gap-4 md:p-4 lg:px-6">
	{#if !ready || !figures || !format || !cart || !checkTotals}
		<p class="text-ink-2 m-auto">Loading the bill…</p>
	{:else}
		{@const money = format}
		<section
			aria-labelledby="pay-h"
			class="rounded-card border-line bg-raise shadow-flat flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border"
		>
			<div class="border-line-soft flex shrink-0 flex-wrap items-center gap-3 border-b p-3 md:p-4">
				{#if !sale}
					<a
						href={resolve('/pos/order')}
						class="min-h-touch-min flex items-center gap-2 px-4 {KEY}"
					>
						<Icon name="arrow-left" class="size-5" />
						Back to the check
					</a>
				{/if}
				<h1 id="pay-h" class="text-title">{sale ? 'Sale' : 'Amount due'}</h1>
				<p class="text-title ml-auto font-mono font-medium tabular-nums">
					{formatMoney(figures.totals.total, money)}
				</p>
			</div>

			<div class="relative min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
				<!-- Mounted before it has content, so the first outcome is announced. -->
				<div aria-live="polite" class="flex flex-col gap-3">
					{#if sale}
						{#if outcome === 'paid'}
							<TillBanner tone="ok">Paid</TillBanner>
							{#if print}
								<TillBanner tone={print.ok ? 'ok' : 'offline'} testid="print-line"
									>{print.text}</TillBanner
								>
							{/if}
							{#if drawerLine}
								<TillBanner tone="offline">{drawerLine}</TillBanner>
							{/if}
						{:else if outcome === 'pending'}
							<TillBanner tone="pending">Waiting for the server to confirm…</TillBanner>
							<TillBanner tone="pending" testid="print-line"
								>The receipt prints once the payment is confirmed</TillBanner
							>
							{#if waitingForNetwork}
								<TillBanner tone="offline">Waiting for a connection</TillBanner>
							{/if}
						{:else if outcome === 'review'}
							<TillBanner tone="offline"
								>Recorded for the owner's review — not confirmed as paid</TillBanner
							>
						{:else}
							<TillBanner tone="danger">Not recorded: {refusalReason}</TillBanner>
							{#if sale.kind === 'card'}
								<p class="text-ink-2">
									The card terminal's charge, if any, must be voided on the terminal
								</p>
							{:else if sale.kind === 'mobile'}
								<p class="text-ink-2">
									Any mobile money payment received must be sent back to the customer
								</p>
							{/if}
						{/if}
					{/if}
				</div>

				{#if sale}
					<div class="mt-4 flex flex-col gap-3">
						<p class="text-title font-mono font-medium">Invoice {sale.invoiceNumber}</p>
						<dl class="rounded-card border-line bg-raise-2 flex flex-col gap-2 border p-4">
							<div class="flex items-baseline justify-between gap-3">
								<dt class="text-ink-2">Total</dt>
								<dd class="font-mono tabular-nums">{formatMoney(sale.total, money)}</dd>
							</div>
							{#if sale.kind === 'cash' && sale.tendered !== null && sale.changeMinor !== null}
								<div class="flex items-baseline justify-between gap-3">
									<dt class="text-ink-2">Tendered</dt>
									<dd class="font-mono tabular-nums">{formatMoney(sale.tendered, money)}</dd>
								</div>
								<div class="border-line flex flex-col gap-1 border-t pt-3">
									<dt class="text-ink-2">Change</dt>
									<dd class="text-total text-right font-mono tabular-nums">
										{formatMoney(minor(sale.changeMinor), money)}
									</dd>
								</div>
							{/if}
						</dl>
						{#if outcome === 'pending'}
							<button
								type="button"
								class="min-h-touch-lg self-start px-6 {KEY}"
								onclick={cancelPending}>Cancel</button
							>
						{/if}
					</div>
				{:else}
					<div class="flex flex-col gap-5">
						<div class="flex flex-col gap-2">
							<p id="tender-l" class="font-semibold">Tender</p>
							<div role="radiogroup" aria-labelledby="tender-l" class="grid grid-cols-3 gap-3">
								{#each options as o, i (o.key)}
									{@const why = reasonFor(o)}
									{@const on = tender === o.key}
									<button
										bind:this={tenderRadios[i]}
										type="button"
										role="radio"
										aria-checked={on}
										tabindex={on ? 0 : -1}
										disabled={why !== null}
										aria-describedby={why !== null ? `why-${i}` : undefined}
										class="min-h-touch-lg flex flex-col items-center justify-center px-2 text-center {KEY} {KEY_CHOSEN}"
										onclick={() => (tender = o.key)}
										onkeydown={(event) => tenderKey(event, i)}
									>
										<span class="flex items-center gap-2">
											<Icon name={o.icon} class="hidden size-6 sm:block" />
											{o.name}
											{#if on}<Icon name="check-circle" class="size-6" />{/if}
										</span>
										{#if why}<span id="why-{i}" class="text-body font-normal">{why}</span>{/if}
									</button>
								{/each}
							</div>
						</div>

						{#if selected?.kind === 'cash'}
							<div class="grid gap-5 sm:grid-cols-2">
								<div class="flex flex-col gap-5">
									<div class="flex flex-col gap-2">
										<h2 class="text-pos font-sans font-semibold">Quick cash</h2>
										<div class="grid grid-cols-3 gap-2">
											{#each quick as value, i (value)}
												<button
													type="button"
													class="min-h-touch-lg px-2 {i === 0
														? ''
														: 'font-mono tabular-nums'} {KEY}"
													onclick={() => chooseQuick(value)}
												>
													{i === 0 ? 'Exact' : formatAmount(value, money)}
												</button>
											{/each}
										</div>
									</div>
									<dl class="rounded-card border-line bg-raise-2 flex flex-col gap-3 border p-4">
										<div class="flex items-baseline justify-between gap-3">
											<dt class="text-ink-2">Amount tendered</dt>
											<dd class="text-title font-mono font-medium tabular-nums">
												{formatMoney(cashTendered ?? minor(0n), money)}
											</dd>
										</div>
										{#if tendered === null}
											<p class="text-body text-ink-2" data-testid="exact-hint">
												Exact amount — key in what the guest gave to see the change
											</p>
										{/if}
										<div class="border-line flex flex-col gap-1 border-t pt-3">
											<dt class="text-ink-2">Change due</dt>
											<dd class="text-total text-right font-mono tabular-nums">
												{change !== null ? formatMoney(change, money) : '—'}
											</dd>
										</div>
									</dl>
								</div>
								<section aria-label="Amount tendered" class="flex flex-col gap-2">
									<p class="text-body text-ink-2">{keypadHint}</p>
									<Keypad label="Amount tendered keypad" onkey={press} />
								</section>
							</div>
						{:else if selected !== null}
							<div class="rounded-card border-line bg-raise-2 flex items-start gap-3 border p-4">
								<Icon name={selected.icon} class="text-accent size-6" />
								<div class="flex flex-col gap-2">
									{#if selected.kind === 'card'}
										<p>
											Charge {formatMoney(figures.totals.total, money)} on the card terminal, then press
											Pay once it is approved.
										</p>
										{#if selected.merchantNumber !== null}
											<p class="text-ink-2">
												Merchant number <span class="font-mono" data-testid="merchant-number"
													>{selected.merchantNumber}</span
												>
											</p>
										{/if}
									{:else if selected.kind === 'mobile'}
										<p>
											The customer sends {formatMoney(figures.totals.total, money)} by {selected.name}{#if selected.merchantNumber !== null}
												to <span class="font-mono" data-testid="merchant-number"
													>{selected.merchantNumber}</span
												>{/if}. Press Pay once the payment has arrived.
										</p>
									{/if}
								</div>
							</div>
						{/if}

						{#if failure}
							<TillBanner tone="danger" live="alert">{failure}</TillBanner>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Below md the check is hidden; the closer is pinned under the pane. -->
			<div class="border-line-soft flex shrink-0 gap-3 border-t p-3 md:hidden">
				{@render closers('bar')}
			</div>
		</section>

		<Check
			mode="bill"
			display="hidden md:flex"
			pill={checkPill}
			{caption}
			note={cart.note ?? null}
			lines={checkLines}
			totals={checkTotals}
			closer={closers}
		/>
	{/if}
</main>
