<script lang="ts">
	// /pos/order — the split screen: order entry on the left, the permanent
	// guest check on the right. The key grid is generated from the cached menu
	// snapshot; every total comes from cartTotals (computeOrderTotals) and every
	// line amount from lineAmounts; this file does no money arithmetic.
	import { getContext, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { minor } from '$lib/money';
	import { formatAmount, formatMoney, moneyFormatFor, type MoneyFormat } from '$lib/money/format';
	import { TAX_MODES, type TaxMode } from '$lib/money/tax';
	import { RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';
	import { readLocalSession } from '$lib/pos/session';
	import { readBoundDeviceId, readMenu, syncMenu, type LocalMenu } from '$lib/pos/store';
	import {
		addLine,
		cartTotals,
		changeQuantity,
		clearCart,
		lineAmounts,
		newCart,
		readCart,
		removeLine,
		saveCart,
		setOrderType,
		type Cart
	} from '$lib/pos/orders';
	import {
		formatTaxRate,
		itemsByCategory,
		modifierGroupsFor,
		type MenuGroup,
		type MenuItem
	} from '$lib/pos/menu-view';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	type Segment = 'sit' | 'waiting' | 'takeaway';
	type Modifier = MenuGroup['modifiers'][number];

	let deviceId = $state<string | null>(null);
	// Raw, not deep: the cart and menu are replaced whole, and IndexedDB's
	// structured clone rejects a $state proxy nested inside a stored cart.
	let menu = $state.raw<LocalMenu | null>(null);
	let menuState = $state<'loading' | 'missing' | 'unset' | 'ready'>('loading');
	let format = $state<MoneyFormat | null>(null);
	let taxMode = $state<TaxMode>('exclusive');
	let cart = $state.raw<Cart | null>(null);
	let segment = $state<Segment>('waiting');
	let tableInput = $state('');
	let selectedTab = $state<string | null>(null);
	let error = $state('');
	let gridDisabled = $state(false);
	let confirmingClear = $state(false);

	let panelItem = $state.raw<MenuItem | null>(null);
	let panelGroups = $state.raw<MenuGroup[]>([]);
	let chosen = $state<Record<string, string[]>>({});

	const tabs = $derived(menu ? itemsByCategory(menu) : []);
	const activeTab = $derived(tabs.find((t) => t.id === selectedTab) ?? tabs[0] ?? null);
	const figures = $derived.by(() =>
		cart ? { totals: cartTotals(cart, taxMode), amounts: lineAmounts(cart) } : null
	);
	const heading = $derived(
		cart === null
			? 'Order'
			: cart.orderType === 'takeaway'
				? 'Takeaway'
				: segment === 'sit'
					? cart.tableLabel
						? `Sit now · Table ${cart.tableLabel}`
						: 'Sit now'
					: 'Waiting for a table'
	);
	const unmetGroup = $derived(
		panelGroups.find((g) => {
			const n = (chosen[g.id] ?? []).length;
			return n < g.minSelect || n > g.maxSelect;
		}) ?? null
	);

	async function loadMenu() {
		menu = await readMenu().catch(() => null);
		if (menu === null) {
			menuState = 'missing';
			return;
		}
		const mode = menu.taxMode;
		if (
			menu.currency === null ||
			mode === null ||
			!(TAX_MODES as readonly string[]).includes(mode)
		) {
			menuState = 'unset';
			return;
		}
		try {
			format = moneyFormatFor(menu.currency);
		} catch {
			menuState = 'unset';
			return;
		}
		taxMode = mode as TaxMode;
		menuState = 'ready';
	}

	async function retryMenu() {
		await syncMenu().catch(() => undefined);
		await loadMenu();
	}

	async function commit(next: Cart) {
		await saveCart(next);
		cart = next;
	}

	onMount(() => {
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
			const session = await readLocalSession(deviceId).catch(() => null);
			if (session === null) {
				void goto(resolve('/pos/session'));
				return;
			}
			await loadMenu();
			try {
				const stored = await readCart(deviceId);
				if (stored) {
					cart = stored;
				} else {
					const fresh = newCart(deviceId, 'dine_in', null);
					await commit(fresh);
				}
			} catch (err) {
				error = `✕ ${err instanceof Error ? err.message : 'The check could not be loaded'}`;
				gridDisabled = true;
				return;
			}
			if (cart) {
				segment =
					cart.orderType === 'takeaway' ? 'takeaway' : cart.tableLabel !== null ? 'sit' : 'waiting';
				tableInput = cart.tableLabel ?? '';
			}
		})();
	});

	async function chooseSegment(next: Segment) {
		if (!cart) return;
		segment = next;
		try {
			if (next === 'takeaway') await commit(setOrderType(cart, 'takeaway', null));
			else if (next === 'waiting') await commit(setOrderType(cart, 'dine_in', null));
			else await commit(setOrderType(cart, 'dine_in', tableInput));
		} catch (err) {
			error = `✕ ${err instanceof Error ? err.message : 'The order type could not be saved'}`;
		}
	}

	async function tableChanged() {
		if (!cart || segment !== 'sit') return;
		try {
			await commit(setOrderType(cart, 'dine_in', tableInput));
			error = '';
		} catch (err) {
			error = `✕ ${err instanceof Error ? err.message : 'The table could not be saved'}`;
		}
	}

	async function tapItem(item: MenuItem) {
		if (!cart || !menu) return;
		error = '';
		if (item.modifierGroupIds.length === 0) {
			try {
				await commit(addLine(cart, item, menu.taxRateBp));
			} catch (err) {
				error = `✕ ${err instanceof Error ? err.message : 'The item could not be added'}`;
			}
			return;
		}
		try {
			panelGroups = modifierGroupsFor(item, menu);
			chosen = {};
			panelItem = item;
		} catch (err) {
			error = `✕ ${err instanceof Error ? err.message : 'The item options could not be read'}`;
		}
	}

	function toggleModifier(group: MenuGroup, modifier: Modifier) {
		const current = chosen[group.id] ?? [];
		let next: string[];
		if (current.includes(modifier.id)) next = current.filter((id) => id !== modifier.id);
		else if (group.maxSelect === 1) next = [modifier.id];
		else if (current.length >= group.maxSelect) return;
		else next = [...current, modifier.id];
		chosen = { ...chosen, [group.id]: next };
	}

	async function addFromPanel() {
		if (!cart || !menu || !panelItem || unmetGroup) return;
		const picked = panelGroups.flatMap((g) =>
			g.modifiers.filter((m) => (chosen[g.id] ?? []).includes(m.id))
		);
		try {
			await commit(addLine(cart, panelItem, menu.taxRateBp, picked));
			panelItem = null;
		} catch (err) {
			error = `✕ ${err instanceof Error ? err.message : 'The item could not be added'}`;
		}
	}

	async function fewer(lineId: string, quantity: number) {
		if (!cart) return;
		await commit(
			quantity > 1 ? changeQuantity(cart, lineId, quantity - 1) : removeLine(cart, lineId)
		);
	}

	async function more(lineId: string, quantity: number) {
		if (!cart) return;
		await commit(changeQuantity(cart, lineId, quantity + 1));
	}

	async function remove(lineId: string) {
		if (!cart) return;
		await commit(removeLine(cart, lineId));
	}

	async function clearAll() {
		if (!cart || deviceId === null) return;
		await clearCart(deviceId);
		await commit(newCart(deviceId, cart.orderType, cart.tableLabel));
		confirmingClear = false;
	}

	function pay() {
		if (!cart || cart.lines.length === 0) return;
		void goto(resolve('/pos/pay'));
	}

	const segmentClass = (on: boolean) =>
		`min-h-touch-min border border-control-line rounded-control px-4 text-pos ${
			on ? 'bg-accent text-accent-ink' : 'bg-raise text-ink'
		}`;
	const lineKey =
		'min-h-touch-min min-w-touch-min border border-control-line rounded-control bg-raise text-ink px-3';
</script>

<svelte:head><title>Order · matcami</title></svelte:head>

<main class="text-pos flex flex-col gap-4 overflow-x-hidden px-4 py-4 md:flex-row md:items-start">
	<section aria-label="Order entry" class="flex min-w-0 flex-1 flex-col gap-4">
		<div class="flex flex-col gap-2">
			<h3 id="ordertype-label" class="text-section text-ink">Order type</h3>
			<div role="group" aria-labelledby="ordertype-label" class="flex flex-wrap gap-2">
				<button
					type="button"
					aria-pressed={segment === 'sit'}
					class={segmentClass(segment === 'sit')}
					onclick={() => chooseSegment('sit')}>Sit now</button
				>
				<button
					type="button"
					aria-pressed={segment === 'waiting'}
					class={segmentClass(segment === 'waiting')}
					onclick={() => chooseSegment('waiting')}>Waiting for a table</button
				>
				<button
					type="button"
					aria-pressed={segment === 'takeaway'}
					class={segmentClass(segment === 'takeaway')}
					onclick={() => chooseSegment('takeaway')}>Takeaway</button
				>
			</div>
			{#if segment === 'sit'}
				<label class="flex flex-col gap-1">
					<span class="text-ink">Table</span>
					<input
						type="text"
						maxlength="32"
						bind:value={tableInput}
						onchange={tableChanged}
						class="border-control-line rounded-control min-h-touch bg-raise text-ink border px-3"
					/>
				</label>
			{/if}
		</div>

		{#if error}
			<p class="bg-danger-bg text-danger rounded-control px-3 py-2">{error}</p>
		{/if}

		{#if menuState === 'loading'}
			<p class="text-ink-2">Loading the menu…</p>
		{:else if menuState === 'missing'}
			<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
				◆ No menu on this device yet — connect once so the till can download it
			</p>
			<button
				type="button"
				class="min-h-touch-lg border-control-line rounded-control bg-raise text-ink border px-4"
				onclick={retryMenu}>Retry</button
			>
		{:else if menuState === 'unset'}
			<p class="bg-danger-bg text-danger rounded-control px-3 py-2">
				✕ The restaurant's currency or tax mode is not set yet — the owner sets both on the
				dashboard Settings page
			</p>
		{:else if menu && format}
			<nav aria-label="Menu categories">
				<div role="tablist" class="flex flex-wrap gap-2">
					{#each tabs as tab (tab.id)}
						<button
							type="button"
							role="tab"
							id="tab-{tab.id}"
							aria-selected={activeTab?.id === tab.id}
							aria-controls="grid-{tab.id}"
							class={segmentClass(activeTab?.id === tab.id)}
							onclick={() => {
								selectedTab = tab.id;
								panelItem = null;
							}}>{tab.name}</button
						>
					{/each}
				</div>
			</nav>
			<p class="text-caption text-ink-2">snapshot v{menu.version} · {menu.items.length} items</p>

			{#if panelItem}
				<section aria-label="{panelItem.name} options" class="flex flex-col gap-3">
					<h3 class="text-section text-ink">{panelItem.name} — options</h3>
					{#each panelGroups as group (group.id)}
						{@const picked = chosen[group.id] ?? []}
						{@const full = group.maxSelect > 1 && picked.length >= group.maxSelect}
						<fieldset class="flex flex-col gap-2">
							<legend class="text-ink">
								{group.name} ·
								{#if group.minSelect === 1 && group.maxSelect === 1}choose exactly 1{:else if group.minSelect === 0}optional,
									up to {group.maxSelect}{:else}choose {group.minSelect}–{group.maxSelect}{/if}
							</legend>
							<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
								{#each group.modifiers as m (m.id)}
									{@const on = picked.includes(m.id)}
									{@const blocked = full && !on}
									<button
										type="button"
										aria-pressed={on}
										disabled={blocked}
										class="min-h-touch-lg border-control-line rounded-control flex flex-col items-start border px-3 py-2 text-left {on
											? 'bg-accent text-accent-ink'
											: blocked
												? 'bg-disabled-bg text-disabled-ink'
												: 'bg-raise text-ink'}"
										onclick={() => toggleModifier(group, m)}
									>
										<span>{m.name}</span>
										<span
											class="font-mono tabular-nums {m.priceDeltaMinor < 0n && !on
												? 'text-danger'
												: ''}">{formatAmount(minor(m.priceDeltaMinor), format)}</span
										>
									</button>
								{/each}
							</div>
							{#if full}
								<p class="text-caption text-ink-2">Choose up to {group.maxSelect}</p>
							{/if}
						</fieldset>
					{/each}
					<div class="flex gap-2">
						<button
							type="button"
							disabled={unmetGroup !== null}
							aria-describedby={unmetGroup ? 'why-add' : undefined}
							class="min-h-touch-lg border-control-line rounded-control flex-1 border px-4 {unmetGroup
								? 'bg-disabled-bg text-disabled-ink'
								: 'bg-accent text-accent-ink'}"
							onclick={addFromPanel}>Add</button
						>
						<button
							type="button"
							class="min-h-touch-lg border-control-line rounded-control bg-raise text-ink border px-4"
							onclick={() => (panelItem = null)}>Cancel</button
						>
					</div>
					{#if unmetGroup}
						<p id="why-add" class="text-ink-2">
							Choose at least {unmetGroup.minSelect} in {unmetGroup.name}
						</p>
					{/if}
				</section>
			{:else if activeTab}
				<div
					role="tabpanel"
					id="grid-{activeTab.id}"
					aria-labelledby="tab-{activeTab.id}"
					class="grid grid-cols-2 gap-2 sm:grid-cols-3"
				>
					{#each activeTab.items as item (item.id)}
						<button
							type="button"
							disabled={!item.isAvailable || gridDisabled}
							class="min-h-touch-lg border-control-line rounded-control flex flex-col items-start justify-center border px-3 py-2 text-left {item.isAvailable &&
							!gridDisabled
								? 'bg-raise text-ink'
								: 'bg-disabled-bg text-disabled-ink'}"
							onclick={() => tapItem(item)}
						>
							<span class="text-caption">{activeTab.name}</span>
							<span class="text-pos font-semibold">{item.name}</span>
							<span class="font-mono tabular-nums"
								>{formatAmount(minor(item.priceMinor), format)}</span
							>
							{#if !item.isAvailable}<span>Unavailable</span>{/if}
						</button>
					{:else}
						<p class="text-ink-2">No items</p>
					{/each}
				</div>
			{/if}
		{/if}
	</section>

	<section
		aria-labelledby="check-h"
		class="bg-raise border-line rounded-card flex w-full flex-col gap-3 border p-4 md:w-96 md:shrink-0"
	>
		<div class="flex items-center justify-between gap-2">
			<h2 id="check-h" class="text-title text-ink">{heading}</h2>
			<span class="bg-st-new-bg text-st-new rounded-control px-2">○ OPEN</span>
		</div>

		{#if cart && figures && format}
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full">
					<thead class="sr-only">
						<tr>
							<th>Status</th>
							<th>Item</th>
							<th>Amount ({format.code})</th>
						</tr>
					</thead>
					<tbody>
						{#each cart.lines as line, i (line.lineId)}
							<tr class="border-line border-t align-top">
								<td class="py-2 pr-2">
									<span class="bg-st-new-bg text-st-new rounded-control px-1">◇ NEW</span>
								</td>
								<td class="py-2">
									<span class="font-mono">{line.quantity}×</span>
									<span class="text-ink">{line.itemName}</span>
									{#each line.modifiers as m (m.modifierId)}
										<div class="pl-4">
											+ {m.modifierName}
											<span
												class="font-mono tabular-nums {m.priceDeltaMinor < 0n ? 'text-danger' : ''}"
												>{formatAmount(minor(m.priceDeltaMinor), format)}</span
											>
										</div>
									{/each}
									<div class="text-caption text-ink-2">
										@ {formatAmount(minor(line.unitPriceMinor), format)} · tax {formatTaxRate(
											line.taxRateBp
										)}
									</div>
									<div class="mt-1 flex gap-2">
										<button
											type="button"
											class={lineKey}
											onclick={() => fewer(line.lineId, line.quantity)}
											><span aria-hidden="true">−</span><span class="sr-only">One fewer</span
											></button
										>
										<button
											type="button"
											class={lineKey}
											onclick={() => more(line.lineId, line.quantity)}
											><span aria-hidden="true">+</span><span class="sr-only">One more</span
											></button
										>
										<button type="button" class={lineKey} onclick={() => remove(line.lineId)}
											>✕ Remove</button
										>
									</div>
								</td>
								<td class="py-2 text-right font-mono tabular-nums"
									>{formatAmount(figures.amounts[i], format)}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<dl class="grid grid-cols-2 gap-y-1 text-right font-mono tabular-nums">
				<dt class="text-ink-2 text-left">Subtotal</dt>
				<dd class="text-ink-2">{formatMoney(figures.totals.subtotal, format)}</dd>
				{#if figures.totals.discount !== 0n}
					<dt class="text-ink-2 text-left">Discount</dt>
					<dd class="text-ink-2">{formatMoney(figures.totals.discount, format)}</dd>
				{/if}
				<dt class="text-ink-2 text-left">Tax</dt>
				<dd class="text-ink-2">{formatMoney(figures.totals.tax, format)}</dd>
				<dt class="text-ink text-left">Total</dt>
				<dd class="text-total text-ink">{formatMoney(figures.totals.total, format)}</dd>
			</dl>
			<p class="text-caption text-ink-2">tax {taxMode} at the rate stored on each line</p>

			<button
				type="button"
				disabled={cart.lines.length === 0}
				class="min-h-touch-xl border-control-line rounded-control text-pos w-full border font-semibold {cart
					.lines.length === 0
					? 'bg-disabled-bg text-disabled-ink'
					: 'bg-accent text-accent-ink'}"
				onclick={pay}
			>
				{#if cart.lines.length === 0}Add an item first{:else}Pay {formatMoney(
						figures.totals.total,
						format
					)}{/if}
			</button>

			{#if confirmingClear}
				<p class="text-ink">Clear all {cart.lines.length} lines?</p>
				<div class="flex gap-2">
					<button type="button" class={lineKey} onclick={clearAll}>Yes, clear</button>
					<button type="button" class={lineKey} onclick={() => (confirmingClear = false)}
						>Keep</button
					>
				</div>
			{:else}
				<button
					type="button"
					disabled={cart.lines.length === 0}
					class="min-h-touch-min border-control-line rounded-control border px-3 {cart.lines
						.length === 0
						? 'bg-disabled-bg text-disabled-ink'
						: 'bg-raise text-ink'}"
					onclick={() => (confirmingClear = true)}>Clear</button
				>
			{/if}
		{:else}
			<p class="text-ink-2">The check appears once the menu and the order are loaded.</p>
		{/if}
	</section>
</main>
