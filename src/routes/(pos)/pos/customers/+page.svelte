<script lang="ts">
	// /pos/customers — who owes, and RECEIVING A PAYMENT (tasks/customer-credit T-20).
	//
	// Receiving a payment is a REQUEST: only the server knows what a customer
	// owes, so it needs a connection and an open shift, and the server may refuse
	// it. The till keeps its own record of every payment it sent
	// (customer-payments.ts) and this screen is driven from it:
	//   - a payment with no answer yet is PERMANENT on screen, with no Cancel —
	//     the server may already hold it — and that customer cannot pay again
	//     until it is answered;
	//   - the receipt prints, and for cash the drawer opens, only when the server
	//     confirms (printing.ts does both, from any screen);
	//   - a refused payment stays until the cashier says the money went back.
	//
	// WHO SEES IT: an employee holding pos.payment. Anyone else sees one sentence
	// and no customer data is fetched or shown (the server's 403 on the op is the
	// control; this is the courtesy).
	//
	// Every balance is the till's CACHED copy and says when it was fetched. This
	// file adds nothing up: what a customer owes comes from customers.ts, and
	// every amount goes through the money formatter (invariants 1, 7).
	import { getContext, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { minor, type Minor } from '$lib/money';
	import { formatMoney, moneyFormatFor, type MoneyFormat } from '$lib/money/format';
	import { hasPermission, RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';
	import {
		asOf,
		creditCheck,
		localChargesFor,
		readCustomers,
		readLocalOrders,
		refreshCustomersWithin,
		searchCustomers,
		type CachedCustomer,
		type CustomersCache
	} from '$lib/pos/customers';
	import {
		acknowledgeRefusal,
		listCustomerPayments,
		needsAttention,
		pendingFor,
		refusalWords,
		startCustomerPayment,
		type CustomerPaymentView
	} from '$lib/pos/customer-payments';
	import {
		onPaymentPrinted,
		reprintCustomerPayment,
		type PaymentPrintResult
	} from '$lib/pos/printing';
	import { formatDateTime } from '$lib/pos/receipt';
	import { flush, onFlushEvent } from '$lib/pos/queue';
	import { readLocalSession } from '$lib/pos/session';
	import { readPaymentMethods } from '$lib/pos/settings';
	import {
		readBoundDeviceId,
		readCachedSetting,
		readMenu,
		type LocalOrder,
		type LocalSession
	} from '$lib/pos/store';
	import { tenderOptions, tenderReason, type TenderOption } from '$lib/pos/tenders';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Keypad, { type KeypadKey } from '$lib/components/pos/Keypad.svelte';
	import TillBanner from '$lib/components/pos/TillBanner.svelte';
	import { KEY, KEY_CHOSEN, TILL_FIELD } from '$lib/components/pos/keys';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let ready = $state(false);
	let deviceId = $state<string | null>(null);
	let session = $state.raw<LocalSession | null>(null);
	let format = $state<MoneyFormat | null>(null);
	let timeZone = $state('UTC');
	let online = $state(true);
	// Raw: plain stored objects, only ever replaced whole.
	let cache = $state.raw<CustomersCache | null>(null);
	let localOrders = $state.raw<LocalOrder[]>([]);
	let payments = $state.raw<CustomerPaymentView[]>([]);
	// Cash, card and mobile only: a debt is never paid with credit.
	let tenders = $state.raw<TenderOption[]>([]);

	let query = $state('');
	let customerId = $state<string | null>(null);
	let digits = $state('');
	let tender = $state<string | null>(null);
	let busy = $state(false);
	let failure = $state('');
	// What printing said about the last confirmed payment. Words only.
	let printLine = $state<{ ok: boolean; text: string } | null>(null);
	let reprinting = $state<string | null>(null);
	let reprintLines = $state<Record<string, string>>({});

	const allowed = $derived(signedIn.current !== null && hasPermission('pos.payment'));
	const mayPrint = $derived(signedIn.current !== null && hasPermission('pos.print_receipt'));

	/** What a customer owes as far as this till knows — customers.ts adds it up. */
	function owedOf(customer: CachedCustomer): Minor {
		const money = format;
		return creditCheck({
			customer,
			billTotalMinor: minor(0n),
			localChargesMinor: localChargesFor(localOrders, customer.id, cache?.requestedAt ?? null),
			creditEnabled: true,
			format: (amount) => (money ? formatMoney(amount, money) : amount.toString())
		}).owedMinor;
	}

	// Those who owe first; within each group the cached (name) order stands.
	const listed = $derived.by(() => {
		const all = searchCustomers(cache?.customers ?? [], query).map((customer) => ({
			customer,
			owed: owedOf(customer)
		}));
		return [...all.filter((row) => row.owed > 0n), ...all.filter((row) => row.owed <= 0n)];
	});
	const chosen = $derived(listed.find((row) => row.customer.id === customerId) ?? null);
	const waiting = $derived(chosen ? pendingFor(payments, chosen.customer.id) : null);
	const attention = $derived(needsAttention(payments));
	const recent = $derived(payments.filter((p) => p.state === 'confirmed').slice(0, 20));
	const selectedTender = $derived(tenders.find((t) => t.key === tender) ?? null);

	// Nothing keyed means "everything they owe" — the common case, one tap.
	const amount = $derived<Minor | null>(
		digits === '' ? (chosen?.owed ?? null) : minor(BigInt(digits))
	);

	const blocked = $derived(
		busy
			? 'Recording…'
			: !online
				? '◆ Needs a connection'
				: session === null
					? 'Open a shift before receiving a payment'
					: chosen === null
						? 'Choose a customer'
						: waiting !== null
							? 'A payment from this customer is still waiting for the server'
							: chosen.owed <= 0n
								? 'This customer owes nothing'
								: amount === null || amount <= 0n
									? 'Enter the amount the customer is paying'
									: amount > chosen.owed
										? 'That is more than the customer owes'
										: selectedTender === null
											? 'Choose how the customer is paying'
											: tenderReason(selectedTender.kind, online)
	);

	async function reload() {
		payments = deviceId === null ? [] : await listCustomerPayments(deviceId).catch(() => []);
		cache = await readCustomers().catch(() => null);
		localOrders = await readLocalOrders().catch(() => []);
	}

	async function refresh() {
		const result = await refreshCustomersWithin(4000, { mayTakePayment: allowed, online });
		if (result === 'refreshed') await reload();
	}

	function describePrint(result: PaymentPrintResult) {
		const printed =
			result.receipt === 'queued' ||
			result.receipt === 'duplicate' ||
			result.receipt === 'already_printed';
		const drawer =
			result.drawer === 'too_late'
				? ' — the drawer did not open: put the cash in at the next cash sale'
				: result.drawer === 'printer_unreachable'
					? ' — the drawer did not open'
					: '';
		printLine = printed
			? { ok: drawer === '', text: `Payment receipt sent to the printer${drawer}` }
			: { ok: false, text: `Not printed — reprint it below${drawer}` };
	}

	onMount(() => {
		online = navigator.onLine;
		const up = () => {
			online = true;
			void refresh();
		};
		const down = () => (online = false);
		addEventListener('online', up);
		addEventListener('offline', down);
		// An answer changes a payment's state, and a confirmed one the balance.
		const stopFlush = onFlushEvent((event) => {
			if (event.type !== 'done' && event.type !== 'rejected') return;
			void reload().then(() => {
				if (event.kind === 'customer.payment') void refresh();
			});
		});
		const stopPrints = onPaymentPrinted((event) => {
			describePrint(event.result);
			void reload();
		});

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
			if (allowed) {
				session = await readLocalSession(deviceId).catch(() => null);
				const menu = await readMenu().catch(() => null);
				format = menu?.currency ? moneyFormatFor(menu.currency) : null;
				const zone = await readCachedSetting('timeZone').catch(() => null);
				if (typeof zone === 'string') timeZone = zone;
				tenders = tenderOptions(await readPaymentMethods().catch(() => [])).filter(
					(option) => option.kind !== 'credit'
				);
				tender = tenders[0]?.key ?? null;
				await reload();
				void refresh();
			}
			ready = true;
		})();

		return () => {
			removeEventListener('online', up);
			removeEventListener('offline', down);
			stopFlush();
			stopPrints();
		};
	});

	function choose(id: string) {
		customerId = id;
		digits = '';
		failure = '';
		printLine = null;
	}

	function press(key: KeypadKey) {
		if (key === 'back') digits = digits.slice(0, -1);
		else if (key === 'clear') digits = '';
		else if (digits.length < 12) digits = digits + key;
	}

	async function receive() {
		if (
			blocked !== null ||
			chosen === null ||
			amount === null ||
			selectedTender === null ||
			selectedTender.kind === 'credit' ||
			deviceId === null ||
			signedIn.current === null
		) {
			return;
		}
		busy = true;
		failure = '';
		printLine = null;
		try {
			// Cash is taken exactly: the customer hands over what they are paying.
			const cash = selectedTender.kind === 'cash';
			const result = await startCustomerPayment({
				deviceId,
				employeeId: signedIn.current.id,
				cashierName: signedIn.current.displayName,
				posSessionId: session?.posSessionId ?? null,
				online,
				customer: {
					id: chosen.customer.id,
					name: chosen.customer.name,
					phone: chosen.customer.phone
				},
				method: selectedTender.kind,
				paymentMethodId: selectedTender.id,
				methodName: selectedTender.name,
				amountMinor: amount,
				tenderedMinor: cash ? amount : null,
				changeMinor: cash ? minor(0n) : null,
				now: new Date()
			});
			if (!result.ok) {
				failure = result.words;
				return;
			}
			digits = '';
			await reload();
			void flush().catch(() => {});
		} catch (err) {
			failure = err instanceof Error ? err.message : 'The payment could not be recorded';
		} finally {
			busy = false;
		}
	}

	async function acknowledge(payment: CustomerPaymentView) {
		await acknowledgeRefusal(payment.clientOpId).catch(() => {});
		await reload();
	}

	async function reprint(payment: CustomerPaymentView) {
		if (!mayPrint || signedIn.current === null || reprinting !== null) return;
		reprinting = payment.clientOpId;
		try {
			const outcome = await reprintCustomerPayment(
				payment.clientOpId,
				signedIn.current.displayName
			);
			const sent = outcome === 'queued' || outcome === 'duplicate';
			reprintLines = {
				...reprintLines,
				[payment.clientOpId]: sent ? '● Copy sent to the printer' : '◆ Not printed — try again'
			};
		} catch {
			reprintLines = { ...reprintLines, [payment.clientOpId]: '◆ Not printed — try again' };
		} finally {
			reprinting = null;
			await reload();
		}
	}

	const show = (value: string | Minor) =>
		format
			? formatMoney(typeof value === 'string' ? minor(BigInt(value)) : value, format)
			: String(value);
</script>

<svelte:head><title>Customers · matcami</title></svelte:head>

<main class="text-pos relative flex min-h-0 flex-1 overflow-y-auto p-3 md:p-4 lg:p-6">
	<div class="mx-auto flex w-full max-w-5xl flex-col gap-4">
		<h1 class="text-title text-ink">Customers on credit</h1>

		{#if !ready}
			<p class="text-ink-2">Loading the customers…</p>
		{:else if !allowed}
			<p class="bg-raise-2 text-ink-2 rounded-control px-3 py-2" data-testid="customers-denied">
				○ Customer credit needs the take-payment permission — ask the owner
			</p>
		{:else}
			<!-- PERMANENT while anything is unanswered or refused: never a toast. -->
			{#each attention as payment (payment.clientOpId)}
				{#if payment.state === 'pending'}
					<TillBanner tone="pending" live="status" testid="payment-pending">
						Payment of {show(payment.amountMinor)} from {payment.customerName} — waiting for the server.
						Keep the money aside; do not take it again.
					</TillBanner>
				{:else}
					<TillBanner tone="danger" live="alert" testid="payment-refused">
						<p>
							Payment of {show(payment.amountMinor)} from {payment.customerName} was NOT recorded:
							{refusalWords(payment.refusal)}. Give the money back.
						</p>
						<button
							type="button"
							class="min-h-touch-min mt-2 px-4 {KEY} text-ink"
							onclick={() => acknowledge(payment)}>OK, I gave the money back</button
						>
					</TillBanner>
				{/if}
			{/each}
			{#if printLine}
				<TillBanner tone={printLine.ok ? 'ok' : 'offline'} testid="payment-print-line"
					>{printLine.text}</TillBanner
				>
			{/if}
			{#if !online}
				<TillBanner tone="offline"
					>Offline — balances may be out of date, and payments need a connection</TillBanner
				>
			{/if}

			<div class="grid gap-4 lg:grid-cols-2">
				<section aria-labelledby="list-h" class="flex min-w-0 flex-col gap-3">
					<h2 id="list-h" class="text-pos font-sans font-semibold">Who owes</h2>
					<label class="flex flex-col gap-2">
						<span class="text-ink-2">Search by name or phone</span>
						<input
							type="search"
							class={TILL_FIELD}
							bind:value={query}
							autocomplete="off"
							data-testid="customers-search"
						/>
					</label>
					<p class="text-body text-ink-2" data-testid="customers-as-of">
						Balances {asOf(cache, timeZone)}
					</p>
					{#if listed.length === 0}
						<p class="text-ink-2">
							{cache === null
								? 'No customers on this till yet — they load when the till is online'
								: 'No customer matches'}
						</p>
					{:else}
						<ul class="flex flex-col gap-2">
							{#each listed as row (row.customer.id)}
								{@const on = customerId === row.customer.id}
								<li>
									<button
										type="button"
										aria-pressed={on}
										class="min-h-touch flex w-full flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-left {KEY} {KEY_CHOSEN}"
										onclick={() => choose(row.customer.id)}
										data-testid="customer-row"
									>
										<span class="min-w-0">
											{row.customer.name}
											<span class="text-body font-mono font-normal">{row.customer.phone}</span>
											{#if row.customer.payOnly}
												<span class="text-body font-normal"
													><span aria-hidden="true" class="font-mono">◐</span> archived — payment only</span
												>
											{/if}
										</span>
										<span class="font-mono font-normal tabular-nums">
											{row.owed > 0n ? `owes ${show(row.owed)}` : 'owes nothing'}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<section aria-labelledby="pay-h" class="flex min-w-0 flex-col gap-3">
					<h2 id="pay-h" class="text-pos font-sans font-semibold">Receive a payment</h2>
					{#if chosen === null}
						<p class="text-ink-2">Choose a customer from the list</p>
					{:else}
						<dl class="rounded-card border-line bg-raise-2 flex flex-col gap-2 border p-4">
							<div class="flex items-baseline justify-between gap-3">
								<dt class="text-ink-2">{chosen.customer.name} owes</dt>
								<dd class="font-mono tabular-nums" data-testid="customer-owes">
									{show(chosen.owed)}
								</dd>
							</div>
							<div class="border-line flex flex-col gap-1 border-t pt-3">
								<dt class="text-ink-2">Paying now</dt>
								<dd class="text-total text-right font-mono tabular-nums" data-testid="paying-now">
									{amount === null ? '—' : show(amount)}
								</dd>
							</div>
							{#if digits === ''}
								<p class="text-body text-ink-2">The full amount — key in less for a part payment</p>
							{/if}
						</dl>

						<div class="flex flex-col gap-2">
							<h3 id="tender-l" class="text-ink-2">Paid by</h3>
							<div role="radiogroup" aria-labelledby="tender-l" class="grid grid-cols-3 gap-3">
								{#each tenders as option (option.key)}
									{@const why = tenderReason(option.kind, online)}
									{@const on = tender === option.key}
									<button
										type="button"
										role="radio"
										aria-checked={on}
										disabled={why !== null}
										class="min-h-touch-lg flex flex-col items-center justify-center px-2 text-center {KEY} {KEY_CHOSEN}"
										onclick={() => (tender = option.key)}
									>
										<span class="flex items-center gap-2">
											<Icon name={option.icon} class="hidden size-6 sm:block" />
											{option.name}
											{#if on}<Icon name="check-circle" class="size-6" />{/if}
										</span>
										{#if why}<span class="text-body font-normal">{why}</span>{/if}
									</button>
								{/each}
							</div>
						</div>

						<Keypad label="Amount paid keypad" onkey={press} />

						{#if failure}
							<TillBanner tone="danger" live="alert">{failure}</TillBanner>
						{/if}
						{#if blocked !== null}
							<p id="receive-why" class="text-ink-2" data-testid="receive-blocked">{blocked}</p>
						{/if}
						<button
							type="button"
							class="min-h-touch-xl px-6 {KEY}"
							disabled={blocked !== null}
							aria-describedby={blocked !== null ? 'receive-why' : undefined}
							onclick={receive}
							data-testid="receive-payment"
						>
							Receive payment{amount !== null && selectedTender
								? ` · ${selectedTender.name} ${show(amount)}`
								: ''}
						</button>
					{/if}
				</section>
			</div>

			{#if recent.length > 0}
				<section aria-labelledby="recent-h" class="flex flex-col gap-3">
					<h2 id="recent-h" class="text-pos font-sans font-semibold">
						Payments received on this till
					</h2>
					<ul class="flex flex-col gap-2">
						{#each recent as payment (payment.clientOpId)}
							<li
								class="bg-raise border-line rounded-card flex flex-wrap items-center justify-between gap-3 border p-3"
								data-testid="payment-row"
							>
								<span class="min-w-0">
									<span aria-hidden="true" class="font-mono">●</span>
									{payment.customerName} · {payment.methodName}
									<span class="text-body text-ink-2"
										>{formatDateTime(payment.tappedAt, timeZone)}</span
									>
								</span>
								<span class="font-mono tabular-nums">
									{show(payment.amountMinor)}
									{#if payment.balanceAfterMinor !== null}
										<span class="text-body text-ink-2 font-sans">
											· still owed {show(payment.balanceAfterMinor)}</span
										>
									{/if}
								</span>
								<span class="flex flex-col items-end gap-1">
									<button
										type="button"
										class="min-h-touch-min px-4 {KEY}"
										disabled={!mayPrint || reprinting !== null}
										onclick={() => reprint(payment)}>Reprint</button
									>
									{#if !mayPrint}
										<span class="text-body text-ink-2">Needs the print-receipt permission</span>
									{:else if reprintLines[payment.clientOpId]}
										<span class="text-body text-ink-2">{reprintLines[payment.clientOpId]}</span>
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/if}
	</div>
</main>
