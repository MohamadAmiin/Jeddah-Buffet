<script lang="ts">
	// T-34: /pos/pay — the tender step. Cash always on; card and mobile from
	// the cached settings; offline disables card/mobile with the reason shown.

	import { onMount, getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { readBoundDeviceId, readCachedSetting, type LocalSession } from '$lib/pos/store';
	import { cartTotals, clearCart, completeSale, readCart, type Cart } from '$lib/pos/orders';
	import { readLocalSession } from '$lib/pos/session';
	import { flush } from '$lib/pos/queue';
	import { RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';
	import { changeDue } from '$lib/money/change';
	import { minor } from '$lib/money';
	import type { TaxMode } from '$lib/money/tax';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let deviceId = $state<string | null>(null);
	let deviceCode = $state<string | null>(null);
	let session = $state<LocalSession | null>(null);
	let cart = $state<Cart | null>(null);
	let taxMode = $state<TaxMode>('exclusive');
	let currencyCode = $state('USD');
	let menuVersion = $state(1);
	let acceptsCard = $state<boolean | null>(null);
	let acceptsMobile = $state<boolean | null>(null);
	let online = $state(true);
	let method = $state<'cash' | 'card' | 'mobile'>('cash');
	let tendered = $state('');
	let message = $state('');
	let submitting = $state(false);
	let done = $state<{ invoiceNumber: string; changeMinor: bigint | null } | null>(null);

	const totals = $derived.by(() => (cart ? cartTotals(cart, taxMode) : null));

	const change = $derived.by(() => {
		if (!totals || method !== 'cash') return null;
		const m = /^\d+(\.\d{0,2})?$/.test(tendered)
			? BigInt(tendered.split('.')[0]) * 100n +
				BigInt(((tendered.split('.')[1] ?? '') + '00').slice(0, 2))
			: null;
		if (m === null) return null;
		try {
			return changeDue(minor(m), totals.total);
		} catch {
			return null;
		}
	});

	async function boot() {
		try {
			const id = await readBoundDeviceId();
			deviceId = id;
			session = id ? await readLocalSession(id) : null;
			cart = id ? await readCart(id) : null;
			const code = await readCachedSetting('deviceCode');
			deviceCode = typeof code === 'string' ? code : null;
			const mode = await readCachedSetting('taxMode');
			taxMode = mode === 'inclusive' ? 'inclusive' : 'exclusive';
			const cur = await readCachedSetting('currencyCode');
			currencyCode = typeof cur === 'string' ? cur : 'USD';
			const mv = await readCachedSetting('menuVersion');
			menuVersion = typeof mv === 'number' ? mv : 1;
			const ac = await readCachedSetting('acceptsCard');
			acceptsCard = typeof ac === 'boolean' ? ac : null;
			const am = await readCachedSetting('acceptsMobile');
			acceptsMobile = typeof am === 'boolean' ? am : null;
			online = typeof navigator === 'undefined' ? true : navigator.onLine;
		} catch (err) {
			message = err instanceof Error ? err.message : 'Could not load payment context.';
		}
	}

	onMount(async () => {
		await restored;
		if (!signedIn.current) {
			void goto(resolve('/pos'));
			return;
		}
		await boot();
		if (!cart || cart.lines.length === 0) {
			void goto(resolve('/pos/order'));
		}
	});

	function tenderedMinor(): bigint | null {
		if (!/^\d+(\.\d{0,2})?$/.test(tendered)) return null;
		const [d, c = ''] = tendered.split('.');
		return BigInt(d) * 100n + BigInt((c + '00').slice(0, 2));
	}

	async function pay() {
		if (!cart || !deviceId || !deviceCode || !session || !signedIn.current) return;
		if (method === 'card' && !(acceptsCard === true && online)) {
			message =
				acceptsCard !== true ? 'Card is not enabled by the owner.' : 'Card needs a connection.';
			return;
		}
		if (method === 'mobile' && !(acceptsMobile === true && online)) {
			message =
				acceptsMobile !== true
					? 'Mobile money is not enabled by the owner.'
					: 'Mobile needs a connection.';
			return;
		}
		message = '';
		submitting = true;
		try {
			const cashTendered = method === 'cash' ? tenderedMinor() : null;
			if (method === 'cash' && cashTendered === null) {
				message = 'Enter tendered as dollars and cents.';
				submitting = false;
				return;
			}
			const result = await completeSale({
				cart,
				payment: { method, tenderedMinor: cashTendered },
				employeeId: signedIn.current.id,
				deviceId,
				deviceCode,
				posSessionId: session.posSessionId,
				taxMode,
				currencyCode,
				menuVersion,
				now: new Date()
			});
			done = {
				invoiceNumber: result.invoiceNumber,
				changeMinor: result.changeMinor
			};
			await clearCart(deviceId);
			void flush().catch(() => {});
		} catch (err) {
			message = err instanceof Error ? err.message : 'Could not complete the sale.';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto flex max-w-lg flex-col gap-4 p-6">
	{#if done}
		<h2 class="text-ink text-xl font-semibold">Paid · {done.invoiceNumber}</h2>
		{#if done.changeMinor !== null}
			<p class="font-mono">Change: {Number(done.changeMinor) / 100}</p>
		{/if}
		<a
			class="bg-accent text-ink rounded-md p-3 text-center font-semibold"
			href={resolve('/pos/order')}>Next sale</a
		>
		<a class="text-ink-2 text-center underline" href={resolve('/pos')}>Sign out</a>
	{:else}
		<h2 class="text-ink text-xl font-semibold">Pay</h2>
		{#if totals}
			<p class="font-mono">Total: {Number(totals.total) / 100}</p>
		{/if}
		<div class="flex gap-2">
			<button
				type="button"
				class="border-control-line rounded-md border px-3 py-2"
				class:bg-accent-soft={method === 'cash'}
				onclick={() => (method = 'cash')}
			>
				Cash
			</button>
			<button
				type="button"
				class="border-control-line rounded-md border px-3 py-2"
				class:bg-accent-soft={method === 'card'}
				disabled={acceptsCard !== true || !online}
				onclick={() => (method = 'card')}
			>
				Card{acceptsCard !== true ? ' (not enabled)' : !online ? ' (offline)' : ''}
			</button>
			<button
				type="button"
				class="border-control-line rounded-md border px-3 py-2"
				class:bg-accent-soft={method === 'mobile'}
				disabled={acceptsMobile !== true || !online}
				onclick={() => (method = 'mobile')}
			>
				Mobile{acceptsMobile !== true ? ' (not enabled)' : !online ? ' (offline)' : ''}
			</button>
		</div>
		{#if method === 'cash'}
			<label class="flex flex-col gap-1">
				<span class="text-ink font-semibold">Tendered</span>
				<input
					type="text"
					inputmode="decimal"
					bind:value={tendered}
					class="border-control-line rounded-md border p-2 font-mono"
					placeholder="20.00"
				/>
			</label>
			{#if change !== null}
				<p class="font-mono">Change: {Number(change) / 100}</p>
			{/if}
		{/if}
		{#if message}<p class="text-danger">{message}</p>{/if}
		<button
			type="button"
			class="bg-accent text-ink min-h-touch-xl rounded-md p-3 font-semibold"
			onclick={pay}
			disabled={submitting}
		>
			{submitting ? 'Recording…' : 'Complete sale'}
		</button>
		<a class="text-ink-2 text-center underline" href={resolve('/pos/order')}>Back to cart</a>
	{/if}
</div>
