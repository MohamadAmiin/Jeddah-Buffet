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
	import { tillImageUrl } from '$lib/menu-images';
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
	import PosIcon from '$lib/components/pos/PosIcon.svelte';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	type Segment = 'sit' | 'waiting' | 'takeaway';
	type Modifier = MenuGroup['modifiers'][number];

	// Photo cards (menu-and-printing T-16). A photo that fails to load — offline
	// with a cold HTTP cache — falls back to the initials tile and NEVER disables
	// the card: selling does not depend on a picture. The Set is replaced, not
	// mutated, so $state notices.
	let brokenPhotos = $state<ReadonlySet<string>>(new Set());
	function markBroken(imageId: string) {
		brokenPhotos = new Set([...brokenPhotos, imageId]);
	}
	const initials = (name: string) =>
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => word.charAt(0).toUpperCase())
			.join('');

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

	// Every pressable surface keeps a border-control-line edge (a white card on the
	// till ground is not a boundary on its own); the selected one takes the accent.
	const choiceClass = (on: boolean) =>
		`border rounded-card flex items-center gap-3 px-4 text-left font-semibold text-pos ${
			on ? 'bg-accent text-accent-ink border-accent' : 'bg-raise text-ink border-control-line'
		}`;
	const pillClass = (on: boolean) =>
		`min-h-touch-min border rounded-full px-5 font-semibold ${
			on ? 'bg-accent text-accent-ink border-accent' : 'bg-raise text-ink border-control-line'
		}`;
	const lineKey =
		'min-h-touch-min min-w-touch-min border border-control-line rounded-control bg-raise text-ink px-3 whitespace-nowrap';
	const segments: { id: Segment; label: string; icon: 'table' | 'clock' | 'bag' }[] = [
		{ id: 'sit', label: 'Sit now', icon: 'table' },
		{ id: 'waiting', label: 'Waiting for a table', icon: 'clock' },
		{ id: 'takeaway', label: 'Takeaway', icon: 'bag' }
	];
</script>

<svelte:head><title>Order · matcami</title></svelte:head>

<main
	class="text-pos flex flex-col gap-4 overflow-x-hidden p-4 md:flex-row md:items-stretch lg:px-6"
>
	<section
		aria-label="Order entry"
		class="bg-raise border-line rounded-card shadow-flat flex min-w-0 flex-1 flex-col gap-6 border p-5"
	>
		<div class="flex flex-col gap-3">
			<h3 id="ordertype-label" class="text-section text-ink flex items-center gap-3">
				<PosIcon name="grid" class="text-accent size-6" />
				Order type
			</h3>
			<div role="group" aria-labelledby="ordertype-label" class="grid gap-3 sm:grid-cols-3">
				{#each segments as seg (seg.id)}
					{@const on = segment === seg.id}
					<button
						type="button"
						aria-pressed={on}
						class="min-h-touch-lg {choiceClass(on)}"
						onclick={() => chooseSegment(seg.id)}
					>
						<PosIcon name={seg.icon} class="size-6" />
						<span>{seg.label}</span>
						{#if on}<PosIcon name="check-circle" class="ml-auto size-6" />{/if}
					</button>
				{/each}
			</div>
		</div>

		{#if segment === 'sit'}
			<label class="flex flex-col gap-3">
				<span class="text-section text-ink flex items-center gap-3">
					<PosIcon name="table" class="text-accent size-6" />
					Table
				</span>
				<span class="relative block">
					<PosIcon
						name="search"
						class="text-ink-2 pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2"
					/>
					<input
						type="text"
						maxlength="32"
						placeholder="Table number or name, e.g. 4"
						bind:value={tableInput}
						onchange={tableChanged}
						class="border-control-line rounded-card min-h-touch bg-raise text-ink placeholder:text-ink-2 w-full border pr-4 pl-12"
					/>
				</span>
			</label>
		{/if}

		{#if error}
			<p class="bg-danger-bg text-danger rounded-control px-3 py-2">{error}</p>
		{/if}

		<div class="flex flex-col gap-3">
			<h3 class="text-section text-ink flex items-center gap-3">
				<PosIcon name="utensils" class="text-accent size-6" />
				Menu
				{#if menu}
					<span class="text-caption text-ink-2 ml-auto font-normal"
						>snapshot v{menu.version} · {menu.items.length} items</span
					>
				{/if}
			</h3>

			{#if menuState === 'loading'}
				<p class="text-ink-2">Loading the menu…</p>
			{:else if menuState === 'missing'}
				<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
					◆ No menu on this device yet — connect once so the till can download it
				</p>
				<button
					type="button"
					class="min-h-touch-lg border-control-line rounded-control bg-raise text-ink self-start border px-4"
					onclick={retryMenu}>Retry</button
				>
			{:else if menuState === 'unset'}
				<p class="bg-danger-bg text-danger rounded-control px-3 py-2">
					✕ The restaurant's currency or tax mode is not set yet — the owner sets both on the
					dashboard Settings page
				</p>
			{:else if menu && format}
				<!-- One tab (or none) is not a choice: no tablist, just the grid. -->
				{#if tabs.length > 1}
					<nav aria-label="Menu categories">
						<div role="tablist" class="flex flex-wrap gap-2">
							{#each tabs as tab (tab.id)}
								<button
									type="button"
									role="tab"
									id="tab-{tab.id}"
									aria-selected={activeTab?.id === tab.id}
									aria-controls="grid-{tab.id}"
									class={pillClass(activeTab?.id === tab.id)}
									onclick={() => {
										selectedTab = tab.id;
										panelItem = null;
									}}>{tab.name}</button
								>
							{/each}
						</div>
					</nav>
				{/if}

				{#if panelItem}
					<section
						aria-label="{panelItem.name} options"
						class="bg-raise-2 border-line rounded-card flex flex-col gap-4 border p-4"
					>
						<h4 class="text-section text-ink">{panelItem.name} — options</h4>
						{#each panelGroups as group (group.id)}
							{@const picked = chosen[group.id] ?? []}
							{@const full = group.maxSelect > 1 && picked.length >= group.maxSelect}
							<fieldset class="flex flex-col gap-2">
								<legend class="text-ink mb-2 font-semibold">
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
											class="min-h-touch-lg rounded-card flex flex-col items-start justify-center border px-3 py-2 text-left {on
												? 'bg-accent text-accent-ink border-accent'
												: blocked
													? 'bg-disabled-bg text-disabled-ink border-control-line'
													: 'bg-raise text-ink border-control-line'}"
											onclick={() => toggleModifier(group, m)}
										>
											<span class="font-semibold">{m.name}</span>
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
								class="min-h-touch-lg border-control-line rounded-control flex-1 border px-4 font-semibold {unmetGroup
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
					{#snippet itemCards(items: MenuItem[], money: MoneyFormat)}
						{#each items as item (item.id)}
							{@const usable = item.isAvailable && !gridDisabled}
							{@const photo = item.imageId}
							<button
								type="button"
								disabled={!usable}
								class="min-h-touch-lg rounded-card border-control-line flex flex-col items-stretch gap-2 border p-3 text-left {usable
									? 'bg-raise text-ink'
									: 'bg-disabled-bg text-disabled-ink'}"
								onclick={() => tapItem(item)}
							>
								{#if photo && !brokenPhotos.has(photo)}
									<img
										src={tillImageUrl(photo)}
										alt=""
										loading="lazy"
										decoding="async"
										class="rounded-control aspect-video w-full object-cover {usable
											? ''
											: 'opacity-50'}"
										onerror={() => markBroken(photo)}
									/>
								{:else}
									<span
										aria-hidden="true"
										class="bg-raise-2 text-ink-2 rounded-control text-title flex aspect-video w-full items-center justify-center font-semibold"
										>{initials(item.name)}</span
									>
								{/if}
								<span class="text-pos font-semibold">{item.name}</span>
								<span class="font-mono tabular-nums {usable ? 'text-accent' : ''}"
									>{formatAmount(minor(item.priceMinor), money)}</span
								>
								{#if !item.isAvailable}<span>Unavailable</span>{/if}
							</button>
						{:else}
							<p class="text-ink-2">No items</p>
						{/each}
					{/snippet}
					{#if tabs.length <= 1}
						<div
							role="region"
							aria-label="Menu items"
							class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
						>
							{@render itemCards(activeTab.items, format)}
						</div>
					{:else}
						<div
							role="tabpanel"
							id="grid-{activeTab.id}"
							aria-labelledby="tab-{activeTab.id}"
							class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
						>
							{@render itemCards(activeTab.items, format)}
						</div>
					{/if}
				{/if}
			{/if}
		</div>
	</section>

	<section
		aria-labelledby="check-h"
		class="bg-raise border-line rounded-card shadow-raised flex w-full flex-col overflow-hidden border md:w-96 md:shrink-0 xl:w-md"
	>
		<div class="bg-accent text-accent-ink flex items-center gap-3 px-5 py-4">
			<PosIcon name="clipboard" class="size-7" />
			<div class="flex min-w-0 flex-col">
				<h2 id="check-h" class="text-title">Current Order</h2>
				<p class="text-caption">{heading}</p>
			</div>
			<span
				class="border-accent-ink text-caption ml-auto rounded-full border px-3 py-1 font-semibold"
				>○ OPEN</span
			>
		</div>

		<div class="flex flex-col gap-4 p-5">
			{#if cart && figures && format}
				{#if cart.lines.length === 0}
					<div class="flex flex-col items-center gap-3 py-6 text-center">
						<span
							class="bg-accent-soft text-accent inline-flex size-28 items-center justify-center rounded-full"
						>
							<svg
								viewBox="0 0 64 64"
								fill="none"
								stroke="currentColor"
								stroke-width="2.4"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
								class="size-16"
							>
								<path d="M8 47h48" />
								<path d="M13 43h38" />
								<path d="M15 43a17 17 0 0 1 34 0" />
								<path d="M32 26v-3" />
								<circle cx="32" cy="20.5" r="2.5" />
								<path d="M22 37a10 10 0 0 1 6-6" />
								<path d="M47 13l1.5-3M52 18l3-1.5M44 9l-.5-2.5" />
							</svg>
						</span>
						<p class="text-section text-ink">Ready to take an order?</p>
						<p class="text-ink-2">Choose an order type, then tap an item to add it.</p>
					</div>
				{:else}
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
									<tr class="border-line border-b align-top last:border-b-0">
										<td class="py-3 pr-2">
											<span
												class="bg-st-new-bg text-st-new text-caption rounded-full px-2 py-0.5 whitespace-nowrap"
												>◇ NEW</span
											>
										</td>
										<td class="py-3">
											<span class="font-mono">{line.quantity}×</span>
											<span class="text-ink font-semibold">{line.itemName}</span>
											{#each line.modifiers as m (m.modifierId)}
												<div class="text-ink-2 pl-4">
													+ {m.modifierName}
													<span
														class="font-mono tabular-nums {m.priceDeltaMinor < 0n
															? 'text-danger'
															: ''}">{formatAmount(minor(m.priceDeltaMinor), format)}</span
													>
												</div>
											{/each}
											<div class="text-caption text-ink-2">
												@ {formatAmount(minor(line.unitPriceMinor), format)} · tax {formatTaxRate(
													line.taxRateBp
												)}
											</div>
											<div class="mt-2 flex gap-2">
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
										<td class="py-3 text-right font-mono tabular-nums"
											>{formatAmount(figures.amounts[i], format)}</td
										>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}

				<dl class="flex flex-col gap-2">
					<div class="flex items-baseline justify-between gap-4">
						<dt class="text-ink-2">Subtotal</dt>
						<dd class="text-ink-2 text-right font-mono tabular-nums">
							{formatMoney(figures.totals.subtotal, format)}
						</dd>
					</div>
					{#if figures.totals.discount !== 0n}
						<div class="flex items-baseline justify-between gap-4">
							<dt class="text-ink-2">Discount</dt>
							<dd class="text-ink-2 text-right font-mono tabular-nums">
								{formatMoney(figures.totals.discount, format)}
							</dd>
						</div>
					{/if}
					<div class="flex items-baseline justify-between gap-4">
						<dt class="text-ink-2">Tax</dt>
						<dd class="text-ink-2 text-right font-mono tabular-nums">
							{formatMoney(figures.totals.tax, format)}
						</dd>
					</div>
					<div
						class="border-line mt-2 flex flex-wrap items-baseline justify-between gap-x-4 border-t pt-4"
					>
						<dt class="text-title text-ink">Total</dt>
						<dd class="text-title text-accent text-right font-mono font-bold tabular-nums">
							{formatMoney(figures.totals.total, format)}
						</dd>
					</div>
				</dl>

				<p
					class="bg-raise-2 text-ink-2 text-caption rounded-control flex items-center gap-3 px-4 py-3"
				>
					<PosIcon name="info" />
					Tax {taxMode} at the rate stored on each line
				</p>

				<button
					type="button"
					disabled={cart.lines.length === 0}
					class="min-h-touch-xl border-control-line rounded-card text-pos flex w-full items-center justify-center gap-3 border font-semibold {cart
						.lines.length === 0
						? 'bg-disabled-bg text-disabled-ink'
						: 'bg-accent text-accent-ink'}"
					onclick={pay}
				>
					{#if cart.lines.length === 0}
						<PosIcon name="plus-circle" class="size-6" />
						Add an item first
					{:else}
						Pay {formatMoney(figures.totals.total, format)}
					{/if}
				</button>

				{#if confirmingClear}
					<div class="flex flex-col gap-2">
						<p class="text-ink">Clear all {cart.lines.length} lines?</p>
						<div class="flex gap-2">
							<button type="button" class="{lineKey} flex-1" onclick={clearAll}>Yes, clear</button>
							<button
								type="button"
								class="{lineKey} flex-1"
								onclick={() => (confirmingClear = false)}>Keep</button
							>
						</div>
					</div>
				{:else}
					<button
						type="button"
						disabled={cart.lines.length === 0}
						class="min-h-touch border-control-line rounded-card flex w-full items-center justify-center gap-2 border font-semibold {cart
							.lines.length === 0
							? 'bg-disabled-bg text-disabled-ink'
							: 'bg-raise text-ink'}"
						onclick={() => (confirmingClear = true)}
					>
						<PosIcon name="trash" />
						Clear
					</button>
				{/if}
			{:else}
				<p class="text-ink-2">The check appears once the menu and the order are loaded.</p>
			{/if}
		</div>
	</section>
</main>
