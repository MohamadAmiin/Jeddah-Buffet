<script lang="ts">
	// T-33: /pos/order — the split screen. Menu on the left, guest check on the
	// right. Add items, pick a table label or takeaway, hand off to /pos/pay.
	//
	// Money renders through the money module: computeOrderTotals gives the four
	// integers; nothing here adds or multiplies.

	import { onMount, getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		readBoundDeviceId,
		readCachedSetting,
		readMenu,
		type LocalMenu,
		type LocalSession
	} from '$lib/pos/store';
	import { readLocalSession } from '$lib/pos/session';
	import {
		addLine,
		cartTotals,
		clearCart,
		newCart,
		readCart,
		removeLine,
		saveCart,
		type Cart,
		type MenuItemForCart
	} from '$lib/pos/orders';
	import { RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';
	type LocalMenuItem = LocalMenu['items'][number];
	import type { TaxMode } from '$lib/money/tax';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let deviceId = $state<string | null>(null);
	let session = $state<LocalSession | null>(null);
	let menu = $state<LocalMenu | null>(null);
	let taxRateBp = $state<number | null>(null);
	let taxMode = $state<TaxMode>('exclusive');
	let categoryId = $state<string | null>(null);
	let cart = $state<Cart | null>(null);
	let message = $state('');

	const items = $derived.by(() => {
		if (!menu || !categoryId) return [];
		return menu.items.filter((i) => i.categoryId === categoryId);
	});

	const totals = $derived.by(() => {
		if (!cart) return null;
		try {
			return cartTotals(cart, taxMode);
		} catch {
			return null;
		}
	});

	async function loadCache() {
		try {
			const id = await readBoundDeviceId();
			deviceId = id;
			session = id ? await readLocalSession(id) : null;
			menu = await readMenu();
			if (menu) categoryId = menu.categories[0]?.id ?? null;
			const rate = await readCachedSetting('taxRateBp');
			taxRateBp = typeof rate === 'number' ? rate : null;
			const mode = await readCachedSetting('taxMode');
			taxMode = mode === 'inclusive' ? 'inclusive' : 'exclusive';
			const existing = id ? await readCart(id) : null;
			cart = existing ?? (id ? newCart(id, 'takeaway') : null);
		} catch (err) {
			message = err instanceof Error ? err.message : 'Could not load the till.';
		}
	}

	onMount(async () => {
		await restored;
		if (!signedIn.current) {
			void goto(resolve('/pos'));
			return;
		}
		await loadCache();
		if (!session) void goto(resolve('/pos/session'));
	});

	async function addItem(item: LocalMenuItem) {
		if (!cart) return;
		const asItem: MenuItemForCart = {
			id: item.id,
			name: item.name,
			priceMinor: item.priceMinor,
			taxRateBp: item.taxRateBp
		};
		const rate = asItem.taxRateBp ?? taxRateBp;
		if (rate === null) {
			message = 'No tax rate is set. The owner sets one on /settings.';
			return;
		}
		try {
			cart = addLine(cart, asItem, taxRateBp, []);
			await saveCart(cart);
			message = '';
		} catch (err) {
			message = err instanceof Error ? err.message : 'Could not add the item.';
		}
	}

	async function drop(lineId: string) {
		if (!cart) return;
		cart = removeLine(cart, lineId);
		await saveCart(cart);
	}

	async function proceed() {
		if (!cart || cart.lines.length === 0) return;
		await saveCart(cart);
		void goto(resolve('/pos/pay'));
	}

	async function clear() {
		if (!deviceId) return;
		await clearCart(deviceId);
		cart = newCart(deviceId, 'takeaway');
	}
</script>

<div class="grid grid-cols-12 gap-4 p-4">
	<div class="col-span-8 flex flex-col gap-3">
		<h2 class="text-ink text-xl font-semibold">Menu</h2>
		{#if menu === null}
			<p class="text-ink-2">Loading menu…</p>
		{:else}
			<div class="flex flex-wrap gap-2">
				{#each menu.categories as cat (cat.id)}
					<button
						type="button"
						class="border-control-line min-h-touch rounded-md border px-3"
						class:bg-accent-soft={cat.id === categoryId}
						onclick={() => (categoryId = cat.id)}
					>
						{cat.name}
					</button>
				{/each}
			</div>
			<div class="grid grid-cols-3 gap-2">
				{#each items as item (item.id)}
					<button
						type="button"
						class="border-control-line bg-raise text-ink rounded-md border p-3 text-left"
						onclick={() => addItem(item)}
					>
						<div class="font-semibold">{item.name}</div>
						<div class="font-mono text-sm">{Number(item.priceMinor) / 100}</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="border-control-line col-span-4 flex flex-col gap-3 rounded-md border p-3">
		<h2 class="text-ink text-xl font-semibold">Guest check</h2>
		{#if cart !== null}
			<div class="flex flex-col gap-1">
				<label>
					<input
						type="radio"
						name="orderType"
						value="dine_in"
						checked={cart.orderType === 'dine_in'}
						onchange={() => cart && (cart = { ...cart, orderType: 'dine_in' })}
					/>
					Dine-in
				</label>
				<label>
					<input
						type="radio"
						name="orderType"
						value="takeaway"
						checked={cart.orderType === 'takeaway'}
						onchange={() => cart && (cart = { ...cart, orderType: 'takeaway' })}
					/>
					Takeaway
				</label>
			</div>
			<ul class="flex flex-col gap-2">
				{#each cart.lines as line (line.lineId)}
					<li class="flex justify-between items-center">
						<span>{line.itemName}</span>
						<span class="font-mono">{Number(line.unitPriceMinor) / 100}</span>
						<button type="button" class="text-danger" onclick={() => drop(line.lineId)}>×</button>
					</li>
				{/each}
			</ul>
			{#if totals}
				<div class="font-mono text-right">
					Subtotal {Number(totals.subtotal) / 100} · Tax {Number(totals.tax) / 100} · Total
					{Number(totals.total) / 100}
				</div>
			{/if}
			{#if message}<p class="text-danger">{message}</p>{/if}
			<button
				type="button"
				class="bg-accent text-ink min-h-touch-xl rounded-md p-3 font-semibold"
				onclick={proceed}
				disabled={cart.lines.length === 0}
			>
				Pay
			</button>
			<button type="button" class="text-ink-2 underline" onclick={clear}>Clear cart</button>
		{/if}
	</div>
</div>
