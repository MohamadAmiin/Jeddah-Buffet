<script lang="ts">
	// /pos/sales — this till's recent sales, and reprints marked COPY (spec 11;
	// menu-and-printing T-31).
	//
	// A REPRINT RECORDS NOTHING: no invoice number, no posting, no sync op
	// (invariant 2) — it is the same stored sale laid out again with a COPY
	// banner. It NEVER opens the drawer. Two rules gate each button, and a
	// disabled button always says why:
	//   - canPrint (T-18): a card or mobile sale the server has not confirmed
	//     has no receipt to copy — fail closed (invariant 5);
	//   - the `pos.print_receipt` permission (spec 8), checked HERE on the
	//     device, the only place printing exists (assumption 8).
	//
	// Every amount shown is the sale's STORED total through the money formatter;
	// this file adds nothing up and converts nothing (invariants 1, 7).
	import { getContext, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { minor } from '$lib/money';
	import { formatAmount, moneyFormatFor } from '$lib/money/format';
	import { hasPermission, RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';
	import type { Cart } from '$lib/pos/orders';
	import {
		listRecentSales,
		reprint,
		reprintRefusal,
		saleStatusMark,
		type PrintOutcome
	} from '$lib/pos/printing';
	import { formatDateTime, ORDER_TYPE_LABELS } from '$lib/pos/receipt';
	import { onFlushEvent } from '$lib/pos/queue';
	import { readBoundDeviceId, readCachedSetting, type LocalOrder } from '$lib/pos/store';
	import { KEY } from '$lib/components/pos/keys';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	type Kind = 'receipt' | 'kitchen';
	const TENDER_LABEL: Record<string, string> = {
		cash: 'Cash',
		card: 'Card',
		mobile: 'Mobile money'
	};

	let ready = $state(false);
	let deviceId = $state<string | null>(null);
	let timeZone = $state('UTC');
	// Raw: rows are plain stored objects, replaced wholesale on every reload.
	let sales = $state.raw<LocalOrder<Cart>[]>([]);
	let failure = $state('');
	// `${orderId}:${kind}` of the reprint in flight, and the last outcome per row.
	let inFlight = $state<string | null>(null);
	let outcomes = $state<Record<string, string>>({});

	const mayPrint = $derived(signedIn.current !== null && hasPermission('pos.print_receipt'));

	async function reload() {
		if (deviceId === null) return;
		try {
			sales = await listRecentSales(deviceId);
			failure = '';
		} catch {
			failure = '✕ This device could not read its sales — reload the till';
		}
	}

	onMount(() => {
		// A card sale confirmed while this screen is open changes its row.
		const stop = onFlushEvent(() => void reload());
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
			const zone = await readCachedSetting('timeZone').catch(() => null);
			if (typeof zone === 'string') timeZone = zone;
			await reload();
			ready = true;
		})();
		return stop;
	});

	function totalOf(order: LocalOrder<Cart>): string {
		if (!order.sale) return '—';
		const { totals, currencyCode } = order.sale.payload;
		try {
			return formatAmount(minor(BigInt(totals.totalMinor)), moneyFormatFor(currencyCode));
		} catch {
			return '—';
		}
	}

	function whenOf(order: LocalOrder<Cart>): string {
		const at = order.sale?.completedAt ?? order.completedAt;
		return at ? formatDateTime(at, timeZone) : '—';
	}

	function tenderOf(order: LocalOrder<Cart>): string {
		const method = order.sale?.payload.payments[0]?.method;
		return method ? (TENDER_LABEL[method] ?? method) : '—';
	}

	/** Why the reprint buttons of this row are disabled, or null when they are not. */
	function blockedBy(order: LocalOrder<Cart>): string | null {
		const refusal = reprintRefusal(order);
		if (refusal !== null) return refusal;
		if (!mayPrint) return 'Needs the print-receipt permission';
		return null;
	}

	function describe(kind: Kind, outcome: PrintOutcome): string {
		const what = kind === 'receipt' ? 'receipt' : 'kitchen ticket';
		if (outcome === 'queued' || outcome === 'duplicate' || outcome === 'already_printed') {
			return `● COPY of the ${what} sent to the printer`;
		}
		if ('skipped' in outcome) return `✕ Not printed — ${outcome.skipped.replaceAll('_', ' ')}`;
		switch (outcome.error) {
			case 'not_set_up':
				return '○ Not printed — the printer is not set up on this till';
			case 'blocked':
				return '✕ Not printed — printing is blocked by Chrome';
			case 'unauthorized':
				return '✕ Not printed — the printer pairing is wrong';
			case 'unreachable':
				return '◆ Not printed — the printer is unreachable';
			default:
				return `✕ Not printed — the agent refused the job (${outcome.error})`;
		}
	}

	async function copy(order: LocalOrder<Cart>, kind: Kind) {
		if (inFlight !== null || signedIn.current === null || blockedBy(order) !== null) return;
		const key = `${order.id}:${kind}`;
		inFlight = key;
		try {
			const outcome = await reprint(order.id, kind, signedIn.current.displayName);
			outcomes = { ...outcomes, [order.id]: describe(kind, outcome) };
		} catch {
			outcomes = { ...outcomes, [order.id]: '◆ Not printed — try again' };
		} finally {
			inFlight = null;
			await reload();
		}
	}

	const TONE: Record<'ok' | 'pending' | 'danger' | 'neutral', string> = {
		ok: 'bg-ok-bg text-ok',
		pending: 'bg-st-billed-bg text-st-billed',
		danger: 'bg-danger-bg text-danger',
		neutral: 'bg-raise-2 text-ink-2'
	};
	const action = `min-h-touch-lg px-4 ${KEY}`;
	const dead =
		'min-h-touch-lg border border-control-line rounded-control bg-disabled-bg text-disabled-ink px-4 font-semibold';
</script>

<svelte:head><title>Sales · matcami</title></svelte:head>

<main class="text-pos relative flex min-h-0 flex-1 overflow-y-auto p-3 md:p-4 lg:p-6">
	<div class="mx-auto flex w-full max-w-4xl flex-col gap-4">
		<h1 class="text-title text-ink">Sales on this till</h1>
		{#if !ready}
			<p class="text-ink-2">Loading the sales…</p>
		{:else}
			{#if failure}
				<p class="bg-danger-bg text-danger rounded-control px-3 py-2" role="alert">{failure}</p>
			{/if}
			{#if !mayPrint}
				<p class="bg-raise-2 text-ink-2 rounded-control px-3 py-2">
					○ Reprinting needs the print-receipt permission — ask the owner
				</p>
			{/if}
			{#if sales.length === 0}
				<p class="text-ink-2">No sales on this till yet</p>
			{:else}
				<ul class="flex flex-col gap-3">
					{#each sales as order (order.id)}
						{@const mark = saleStatusMark(order)}
						{@const blocked = blockedBy(order)}
						<li
							class="bg-raise border-line rounded-card shadow-flat flex flex-col gap-3 border p-4"
							data-testid="sale-row"
						>
							<div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
								<span class="font-mono font-medium">{order.invoiceNumber ?? '—'}</span>
								<span class="text-right font-mono tabular-nums">{totalOf(order)}</span>
							</div>
							<div class="text-ink-2 flex flex-wrap items-center gap-x-4 gap-y-1">
								<span>{whenOf(order)}</span>
								{#if order.sale}
									<span>{ORDER_TYPE_LABELS[order.sale.payload.orderType]}</span>
								{/if}
								<span>{tenderOf(order)}</span>
								<span class="rounded-full px-3 py-1 font-semibold {TONE[mark.tone]}">
									<span aria-hidden="true" class="font-mono">{mark.glyph}</span>
									{mark.text}
								</span>
							</div>
							<div class="flex flex-wrap items-center gap-3">
								{#each ['receipt', 'kitchen'] as const as kind (kind)}
									{@const busy = inFlight === `${order.id}:${kind}`}
									<button
										type="button"
										class={blocked !== null || inFlight !== null ? dead : action}
										disabled={blocked !== null || inFlight !== null}
										aria-describedby={blocked !== null ? `why-${order.id}` : undefined}
										onclick={() => void copy(order, kind)}
									>
										{busy
											? 'Sending…'
											: kind === 'receipt'
												? 'Reprint receipt'
												: 'Reprint kitchen ticket'}
									</button>
								{/each}
								{#if blocked !== null}
									<span id="why-{order.id}" class="text-ink-2">{blocked}</span>
								{/if}
							</div>
							{#if outcomes[order.id]}
								<p
									aria-live="polite"
									class="rounded-control px-3 py-2 {outcomes[order.id].startsWith('●')
										? 'bg-ok-bg text-ok'
										: outcomes[order.id].startsWith('◆')
											? 'bg-st-offline-bg text-st-offline'
											: outcomes[order.id].startsWith('○')
												? 'bg-raise-2 text-ink-2'
												: 'bg-danger-bg text-danger'}"
								>
									{outcomes[order.id]}
								</p>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</main>
