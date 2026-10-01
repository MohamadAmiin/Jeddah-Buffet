<script lang="ts">
	// /pos/order — the split screen (docs/redesign Phase 2): the entry pane on the
	// left, the permanent guest check on the right. The DOCUMENT never scrolls:
	// the item grid scrolls inside the entry pane, the lines scroll inside the
	// check, and Pay is pinned to the bottom-right of the check, always on screen.
	// Below md the check becomes a pinned bar with Pay that opens the full check as
	// a sheet. The key grid is generated from the cached menu snapshot; every total
	// comes from cartTotals (computeOrderTotals) and every line amount from
	// lineAmounts; this file does no money arithmetic.
	import { getContext, onMount, tick } from 'svelte';
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
		setNote,
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
	import Icon, { type IconName } from '$lib/components/ui/Icon.svelte';
	import Check from '$lib/components/pos/Check.svelte';
	import Closer from '$lib/components/pos/Closer.svelte';
	import type { CheckLineView } from '$lib/components/pos/CheckLine.svelte';
	import { KEY, KEY_CHOSEN, TILL_FIELD } from '$lib/components/pos/keys';
	import type { OrderType } from '$lib/sync-ops';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	// The three order types ARE the wire contract's values (menu-and-printing
	// T-17): Dine in is the default when the cashier chooses nothing, with an
	// optional table (no table = waiting for one); Takeaway and Delivery carry no
	// table. Delivery is a tag paid at the till — CLAUDE.md decision (a). The brief
	// predates these three and shows "Sit now / Waiting for a table / Takeaway";
	// the owner chose to keep PR #18's model (2026-09-30).
	type Modifier = MenuGroup['modifiers'][number];

	// Photo keys (menu-and-printing T-16). A photo that fails to load — offline
	// with a cold HTTP cache — falls back to the initials tile and NEVER disables
	// the key: selling does not depend on a picture. The Set is replaced, not
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
	let segment = $state<OrderType>('dine_in');
	let tableInput = $state('');
	// The kitchen note (T-22): saved through setNote on change, shown on the check.
	let noteInput = $state('');
	let selectedTab = $state<string | null>(null);
	let error = $state('');
	let gridDisabled = $state(false);
	let confirmingClear = $state(false);
	// The line whose keys are showing. The newest line is selected after every add;
	// tapping a line selects it; tapping the selected line collapses it.
	let selectedLine = $state<string | null>(null);
	// The phone check sheet (below md).
	let sheetOpen = $state(false);
	let sheet = $state<HTMLDialogElement>();

	let panelItem = $state.raw<MenuItem | null>(null);
	let panelGroups = $state.raw<MenuGroup[]>([]);
	let chosen = $state<Record<string, string[]>>({});
	let panelHeading = $state<HTMLHeadingElement>();

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
				: cart.orderType === 'delivery'
					? 'Delivery'
					: cart.tableLabel
						? `Dine in · Table ${cart.tableLabel}`
						: 'Dine in'
	);
	const unmetGroup = $derived(
		panelGroups.find((g) => {
			const n = (chosen[g.id] ?? []).length;
			return n < g.minSelect || n > g.maxSelect;
		}) ?? null
	);

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
			taxRate: formatTaxRate(line.taxRateBp),
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
				segment = cart.orderType;
				tableInput = cart.tableLabel ?? '';
				noteInput = cart.note ?? '';
				selectedLine = cart.lines.at(-1)?.lineId ?? null;
			}
		})();
	});

	async function noteChanged() {
		if (!cart) return;
		try {
			await commit(setNote(cart, noteInput));
			noteInput = cart.note ?? '';
			error = '';
		} catch (err) {
			error = `✕ ${err instanceof Error ? err.message : 'The note could not be saved'}`;
		}
	}

	async function chooseSegment(next: OrderType) {
		if (!cart) return;
		segment = next;
		try {
			if (next === 'dine_in') await commit(setOrderType(cart, 'dine_in', tableInput));
			else await commit(setOrderType(cart, next, null));
		} catch (err) {
			error = `✕ ${err instanceof Error ? err.message : 'The order type could not be saved'}`;
		}
	}

	async function tableChanged() {
		if (!cart || segment !== 'dine_in') return;
		try {
			await commit(setOrderType(cart, 'dine_in', tableInput));
			error = '';
		} catch (err) {
			error = `✕ ${err instanceof Error ? err.message : 'The table could not be saved'}`;
		}
	}

	async function added(next: Cart) {
		await commit(next);
		selectedLine = next.lines.at(-1)?.lineId ?? null;
	}

	async function tapItem(item: MenuItem) {
		if (!cart || !menu) return;
		error = '';
		if (item.modifierGroupIds.length === 0) {
			try {
				await added(addLine(cart, item, menu.taxRateBp));
			} catch (err) {
				error = `✕ ${err instanceof Error ? err.message : 'The item could not be added'}`;
			}
			return;
		}
		try {
			panelGroups = modifierGroupsFor(item, menu);
			chosen = {};
			panelItem = item;
			await tick();
			panelHeading?.focus();
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
			await added(addLine(cart, panelItem, menu.taxRateBp, picked));
			panelItem = null;
		} catch (err) {
			error = `✕ ${err instanceof Error ? err.message : 'The item could not be added'}`;
		}
	}

	function lineOf(lineId: string) {
		return cart?.lines.find((l) => l.lineId === lineId) ?? null;
	}

	function select(lineId: string) {
		selectedLine = selectedLine === lineId ? null : lineId;
	}

	async function fewer(lineId: string) {
		const line = lineOf(lineId);
		if (!cart || !line) return;
		if (line.quantity > 1) {
			await commit(changeQuantity(cart, lineId, line.quantity - 1));
		} else {
			await commit(removeLine(cart, lineId));
			selectedLine = null;
		}
	}

	async function more(lineId: string) {
		const line = lineOf(lineId);
		if (!cart || !line) return;
		await commit(changeQuantity(cart, lineId, line.quantity + 1));
	}

	async function remove(lineId: string) {
		if (!cart) return;
		await commit(removeLine(cart, lineId));
		if (selectedLine === lineId) selectedLine = null;
	}

	async function clearAll() {
		if (!cart || deviceId === null) return;
		await clearCart(deviceId);
		await commit(newCart(deviceId, cart.orderType, cart.tableLabel));
		confirmingClear = false;
		selectedLine = null;
	}

	// The order-type radio group: only the checked radio is in the tab order, and
	// the arrow keys move the choice (the ARIA radio group pattern).
	const ORDER_TYPES: { id: OrderType; label: string; icon: IconName }[] = [
		{ id: 'dine_in', label: 'Dine in', icon: 'table' },
		{ id: 'takeaway', label: 'Takeaway', icon: 'bag' },
		{ id: 'delivery', label: 'Delivery', icon: 'delivery' }
	];
	let typeRadios = $state<HTMLButtonElement[]>([]);
	function radioKey(event: KeyboardEvent, index: number) {
		const step =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? -1
					: 0;
		if (step === 0) return;
		event.preventDefault();
		const next = (index + step + ORDER_TYPES.length) % ORDER_TYPES.length;
		void chooseSegment(ORDER_TYPES[next].id);
		typeRadios[next]?.focus();
	}

	// The category tabs: a roving tabindex, Left/Right for the neighbours and
	// Home/End for the ends (the ARIA tabs pattern).
	let tabButtons = $state<HTMLButtonElement[]>([]);
	function tabKey(event: KeyboardEvent, index: number) {
		const last = tabs.length - 1;
		const next =
			event.key === 'ArrowRight'
				? index === last
					? 0
					: index + 1
				: event.key === 'ArrowLeft'
					? index === 0
						? last
						: index - 1
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? last
							: -1;
		if (next < 0) return;
		event.preventDefault();
		selectedTab = tabs[next].id;
		panelItem = null;
		tabButtons[next]?.focus();
	}

	// The phone sheet: a native modal <dialog> that IS the full-screen scrim, with
	// the check inside it (the recipe of docs/redesign section 10).
	$effect(() => {
		if (!sheet) return;
		if (sheetOpen && !sheet.open) sheet.showModal();
		if (!sheetOpen && sheet.open) sheet.close();
	});

	const payReason = 'Add an item first';
</script>

<svelte:head><title>Order · matcami</title></svelte:head>

{#snippet closers(uid: string)}
	{#if cart && checkTotals}
		{@const empty = cart.lines.length === 0}
		{#if confirmingClear}
			<!-- The confirmation replaces the closer row at the same height, so nothing moves. -->
			<div class="min-h-touch-xl flex min-w-0 flex-1 flex-col justify-center gap-2">
				<p class="text-ink font-semibold">Clear all {cart.lines.length} lines?</p>
				<div class="flex gap-2">
					<button type="button" class="min-h-touch-min flex-1 px-3 {KEY}" onclick={clearAll}
						>Yes, clear</button
					>
					<button
						type="button"
						class="min-h-touch-min flex-1 px-3 {KEY}"
						onclick={() => (confirmingClear = false)}>Keep</button
					>
				</div>
			</div>
		{:else}
			<button
				type="button"
				disabled={empty}
				aria-describedby={empty ? `${uid}-why-pay` : undefined}
				class="min-h-touch-xl rounded-card border-control-line flex w-28 shrink-0 flex-col items-center justify-center gap-1 border font-semibold {empty
					? 'bg-disabled-bg text-disabled-ink'
					: 'bg-raise text-ink'}"
				onclick={() => (confirmingClear = true)}
			>
				<Icon name="trash" class="size-6" />
				Clear
			</button>
			<Closer
				href={resolve('/pos/pay')}
				disabled={empty}
				reason={payReason}
				reasonId="{uid}-why-pay"
			>
				Pay
				{#if !empty}<span class="font-mono font-medium tabular-nums">{checkTotals.total}</span>{/if}
			</Closer>
		{/if}
	{/if}
{/snippet}

{#snippet emptyCheck()}
	<div class="m-auto flex flex-col items-center gap-2 px-6 py-8 text-center">
		<span
			class="bg-accent-soft text-accent inline-flex size-16 items-center justify-center rounded-full"
		>
			<Icon name="clipboard" class="size-8" />
		</span>
		<p class="text-section text-ink">Ready to take an order?</p>
		<p class="text-body text-ink-2">Choose an order type, then tap an item to add it.</p>
	</div>
{/snippet}

<main class="flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row md:gap-4 md:p-4 lg:px-6">
	<section
		aria-labelledby="entry-h"
		class="rounded-card border-line bg-raise shadow-flat flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border"
	>
		<h1 id="entry-h" class="sr-only">Ring up an order</h1>

		<div class="border-line-soft flex shrink-0 flex-wrap items-center gap-3 border-b p-3 md:p-4">
			<div
				role="radiogroup"
				aria-label="Order type"
				class="grid min-w-0 flex-1 basis-96 grid-cols-3 gap-2"
			>
				{#each ORDER_TYPES as type, i (type.id)}
					{@const on = segment === type.id}
					<button
						bind:this={typeRadios[i]}
						type="button"
						role="radio"
						aria-checked={on}
						tabindex={on ? 0 : -1}
						class="min-h-touch text-body sm:text-pos flex min-w-0 items-center gap-2 px-2 text-left leading-tight sm:px-3 {KEY} {KEY_CHOSEN}"
						onclick={() => chooseSegment(type.id)}
						onkeydown={(event) => radioKey(event, i)}
					>
						<Icon name={type.icon} class="hidden size-6 sm:block" />
						<span class="min-w-0 flex-1">{type.label}</span>
						{#if on}<Icon name="check-circle" class="size-6" />{/if}
					</button>
				{/each}
			</div>

			{#if segment === 'dine_in'}
				<div class="flex shrink-0 items-center gap-2">
					<label for="table-input" class="font-semibold">Table</label>
					<input
						id="table-input"
						type="text"
						maxlength="32"
						placeholder="Table number or name, e.g. 4"
						bind:value={tableInput}
						onchange={tableChanged}
						class="text-title placeholder:text-body w-32 font-mono font-medium placeholder:font-sans {TILL_FIELD}"
					/>
				</div>
			{/if}

			<!-- T-22: an optional note for the kitchen ticket (spec 11). -->
			<div class="flex min-w-0 flex-1 basis-72 items-center gap-2">
				<label for="note-input" class="shrink-0 font-semibold">Note for the kitchen</label>
				<input
					id="note-input"
					type="text"
					maxlength="140"
					placeholder="Optional — e.g. no onions"
					bind:value={noteInput}
					onchange={noteChanged}
					class="min-w-0 flex-1 {TILL_FIELD}"
				/>
			</div>

			{#if error}
				<p class="bg-danger-bg text-danger rounded-control basis-full px-3 py-2">{error}</p>
			{/if}
		</div>

		{#if menuState === 'ready' && menu && format}
			<div class="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3 md:px-4 md:pt-4">
				<h2 class="sr-only">Menu</h2>
				<!-- One tab (or none) is not a choice: no tablist, just the grid. -->
				{#if tabs.length > 1}
					<div role="tablist" aria-label="Menu categories" class="flex flex-wrap gap-2">
						{#each tabs as tab, i (tab.id)}
							{@const on = activeTab?.id === tab.id}
							<button
								bind:this={tabButtons[i]}
								type="button"
								role="tab"
								id="tab-{tab.id}"
								aria-selected={on}
								aria-controls="menu-grid"
								tabindex={on ? 0 : -1}
								class="min-h-touch-min border-control-line bg-raise aria-selected:border-accent aria-selected:bg-accent aria-selected:text-accent-ink flex items-center gap-2 rounded-full border px-5 font-semibold"
								onclick={() => {
									selectedTab = tab.id;
									panelItem = null;
								}}
								onkeydown={(event) => tabKey(event, i)}
							>
								{#if on}<Icon name="check" class="size-5" />{/if}
								{tab.name}
							</button>
						{/each}
					</div>
				{/if}
				<p class="text-body text-ink-2 ml-auto">
					snapshot v{menu.version} · {menu.items.length} items
				</p>
			</div>
		{/if}

		{#if panelItem && format}
			{@const money = format}
			<!-- The options panel replaces the grid (never a modal): a scrolling body and a
			     pinned footer with Add to order and Cancel. -->
			<section aria-label="{panelItem.name} options" class="flex min-h-0 flex-1 flex-col">
				<div class="relative min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
					<div class="rounded-card border-line bg-raise-2 flex flex-col gap-4 border p-4">
						<div class="flex items-baseline justify-between gap-3">
							<h3 bind:this={panelHeading} tabindex="-1" class="text-title">
								{panelItem.name} — options
							</h3>
							<p class="text-ink-2 font-mono tabular-nums">
								{formatAmount(minor(panelItem.priceMinor), money)}
							</p>
						</div>
						{#each panelGroups as group (group.id)}
							{@const picked = chosen[group.id] ?? []}
							{@const full = group.maxSelect > 1 && picked.length >= group.maxSelect}
							<fieldset class="flex flex-col gap-3">
								<legend class="mb-3 font-semibold">
									{group.name} ·
									{#if group.minSelect === 1 && group.maxSelect === 1}choose exactly 1{:else if group.minSelect === 0}optional,
										up to {group.maxSelect}{:else}choose {group.minSelect}–{group.maxSelect}{/if}
								</legend>
								<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
									{#each group.modifiers as m (m.id)}
										{@const on = picked.includes(m.id)}
										{@const blocked = full && !on}
										<button
											type="button"
											aria-pressed={on}
											disabled={blocked}
											aria-describedby={blocked ? `why-full-${group.id}` : undefined}
											class="min-h-touch-lg rounded-card border-control-line flex flex-col items-start justify-between gap-1 border px-3 py-2 text-left {blocked
												? 'bg-disabled-bg text-disabled-ink'
												: 'bg-raise'} {KEY_CHOSEN}"
											onclick={() => toggleModifier(group, m)}
										>
											<span class="flex w-full items-center justify-between gap-2 font-semibold">
												{m.name}
												{#if on}<Icon name="check-circle" class="size-5" />{/if}
											</span>
											<span
												class="font-mono tabular-nums {m.priceDeltaMinor < 0n && !on
													? 'text-danger'
													: ''}">{formatAmount(minor(m.priceDeltaMinor), money)}</span
											>
										</button>
									{/each}
								</div>
								{#if full}
									<p id="why-full-{group.id}" class="text-body text-ink-2">
										Choose up to {group.maxSelect} — tap a chosen one to free a slot.
									</p>
								{/if}
							</fieldset>
						{/each}
					</div>
				</div>
				<div class="border-line-soft flex shrink-0 flex-col gap-2 border-t p-3 md:p-4">
					{#if unmetGroup}
						<p id="why-add" class="text-body text-ink-2">
							Choose at least {unmetGroup.minSelect} in {unmetGroup.name}
						</p>
					{/if}
					<div class="flex gap-3">
						<button
							type="button"
							disabled={unmetGroup !== null}
							aria-describedby={unmetGroup ? 'why-add' : undefined}
							class="min-h-touch-lg rounded-control border-control-line text-title flex-1 border font-semibold {unmetGroup
								? 'bg-disabled-bg text-disabled-ink'
								: 'bg-accent text-accent-ink'}"
							onclick={addFromPanel}>Add to order</button
						>
						<button
							type="button"
							class="min-h-touch-lg w-40 {KEY}"
							onclick={() => (panelItem = null)}>Cancel</button
						>
					</div>
				</div>
			</section>
		{:else}
			<!-- The only part of the pane that scrolls. Its columns follow the PANE's
			     width (container queries), not the viewport's. -->
			<div
				role={tabs.length > 1 ? 'tabpanel' : 'region'}
				id="menu-grid"
				aria-labelledby={tabs.length > 1 && activeTab ? `tab-${activeTab.id}` : undefined}
				aria-label={tabs.length > 1 ? undefined : 'Menu items'}
				class="@container relative min-h-0 flex-1 overflow-y-auto p-3 md:p-4"
			>
				{#if menuState === 'loading'}
					<p class="text-ink-2">Loading the menu…</p>
				{:else if menuState === 'missing'}
					<div class="flex flex-col items-start gap-3">
						<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
							◆ No menu on this device yet — connect once so the till can download it
						</p>
						<button type="button" class="min-h-touch-lg px-4 {KEY}" onclick={retryMenu}
							>Retry</button
						>
					</div>
				{:else if menuState === 'unset'}
					<p class="bg-danger-bg text-danger rounded-control px-3 py-2">
						✕ The restaurant's currency or tax mode is not set yet — the owner sets both on the
						dashboard Settings page
					</p>
				{:else if activeTab && format}
					{@const money = format}
					<ul class="grid grid-cols-2 gap-3 @md:grid-cols-3 @2xl:grid-cols-4">
						{#each activeTab.items as item (item.id)}
							{@const usable = item.isAvailable && !gridDisabled}
							{@const photo = item.imageId}
							{@const hint = !item.isAvailable
								? 'Unavailable'
								: item.modifierGroupIds.length > 0
									? 'Options'
									: item.taxRateBp === 0
										? 'Tax 0%'
										: ''}
							<li>
								<button
									type="button"
									disabled={!usable}
									class="min-h-touch-xl rounded-card border-control-line flex h-full w-full flex-col justify-between gap-2 border p-3 text-left {usable
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
												: 'grayscale'}"
											onerror={() => markBroken(photo)}
										/>
									{:else}
										<span
											aria-hidden="true"
											class="bg-raise-2 text-ink-2 rounded-control text-title flex aspect-video w-full items-center justify-center font-semibold"
											>{initials(item.name)}</span
										>
									{/if}
									<span class="leading-snug font-semibold">{item.name}</span>
									<span class="flex items-end justify-between gap-2">
										<span class="text-body {usable ? 'text-ink-2' : ''}">{hint}</span>
										<span class="font-mono font-medium tabular-nums {usable ? 'text-accent' : ''}"
											>{formatAmount(minor(item.priceMinor), money)}</span
										>
									</span>
								</button>
							</li>
						{:else}
							<li class="text-ink-2">No items</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	</section>

	{#if cart && checkTotals}
		<Check
			mode="edit"
			display="hidden md:flex"
			pill={{ glyph: '○', word: 'OPEN' }}
			caption={heading}
			note={cart.note ?? null}
			lines={checkLines}
			totals={checkTotals}
			selectedId={selectedLine}
			onselect={select}
			onfewer={fewer}
			onmore={more}
			onremove={remove}
			empty={emptyCheck}
			closer={closers}
		/>

		<!-- Below md: the check is a pinned bar with Pay; its summary opens the whole
		     check as a sheet, so the cashier never navigates away to see it. -->
		<section
			aria-label="Current Order"
			class="rounded-card border-line bg-raise shadow-floating flex shrink-0 flex-col gap-2 border p-3 md:hidden"
		>
			<button
				type="button"
				aria-expanded={sheetOpen}
				aria-controls="check-sheet"
				class="min-h-touch-min rounded-control border-control-line bg-raise-2 flex w-full items-center gap-3 border px-3 text-left"
				onclick={() => (sheetOpen = true)}
			>
				<Icon name="clipboard" class="text-accent size-6" />
				<span class="flex min-w-0 flex-1 flex-col leading-tight">
					<span class="font-semibold"
						>Current Order · {cart.lines.length}
						{cart.lines.length === 1 ? 'line' : 'lines'}</span
					>
					<span class="text-body text-ink-2 truncate">{heading} · review the check</span>
				</span>
				<Icon name="chevron-up" class="text-ink-2 size-5" />
			</button>
			<div class="flex gap-3">{@render closers('bar')}</div>
		</section>
	{/if}
</main>

<dialog
	bind:this={sheet}
	id="check-sheet"
	aria-label="Current Order"
	onclose={() => (sheetOpen = false)}
	onclick={(event) => {
		if (event.target === sheet) sheet?.close();
	}}
	class="bg-scrim m-0 h-dvh max-h-none w-full max-w-none border-0 p-0 backdrop:bg-transparent md:hidden"
>
	{#if sheetOpen && cart && checkTotals}
		<div class="flex h-full flex-col gap-2 p-3">
			<button
				type="button"
				class="min-h-touch-min rounded-control border-control-line bg-raise flex items-center gap-2 self-end border px-4 font-semibold"
				onclick={() => sheet?.close()}
			>
				<Icon name="x" class="size-5" />
				Close the check
			</button>
			<Check
				mode="edit"
				sheet
				pill={{ glyph: '○', word: 'OPEN' }}
				caption={heading}
				note={cart.note ?? null}
				lines={checkLines}
				totals={checkTotals}
				selectedId={selectedLine}
				onselect={select}
				onfewer={fewer}
				onmore={more}
				onremove={remove}
				empty={emptyCheck}
				closer={closers}
			/>
		</div>
	{/if}
</dialog>
