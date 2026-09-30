<script lang="ts" module>
	export type TillBarSession = {
		state: 'opening' | 'open' | 'closing' | 'closed';
		businessDate: string | null;
	};
	export type TillBarEmployee = { name: string; role: string; initials: string; isOwner: boolean };
	export type TillBarPrinter = {
		glyph: string;
		text: string;
		tone: 'ok' | 'offline' | 'danger' | 'neutral';
	};
</script>

<script lang="ts">
	// THE TILL BAR (docs/redesign Phase 1, section 6.2): one 64px row, rail-coloured.
	// Everything a cashier must always see lives here — connection, the unsynced
	// count (spec 6, invariant 5), who is signed in, the session — each as a glyph
	// AND a word. It takes its state as props; the layout reads the stores.
	//
	// HOW IT DEGRADES: only the restaurant block may shrink (it truncates). Every
	// other item is shrink-0 and appears by breakpoint, so the bar stays ONE row at
	// every width down to 390px, online and offline, with warnings showing.
	//
	// THE LIVE REGION is the connection and sync pills ONLY — never the controls,
	// never the clock. Every other warning merges into ONE chip, because one chip
	// per warning is what pushed the old bar past the screen edge.
	import { resolve } from '$app/paths';
	import Icon from '../ui/Icon.svelte';

	let {
		restaurantName,
		deviceCode,
		online,
		unsynced,
		warnings,
		printer,
		clockTime,
		today,
		session,
		employee,
		current
	}: {
		restaurantName: string | null;
		deviceCode: string | null;
		online: boolean;
		/** null = not read yet (nothing shown) or unreadable (named in `warnings`). */
		unsynced: { count: number } | { unreadable: true } | null;
		warnings: string[];
		printer: TillBarPrinter | null;
		clockTime: string;
		today: string;
		session: TillBarSession | null;
		employee: TillBarEmployee | null;
		current: 'order' | 'sales' | 'other';
	} = $props();

	const pending = $derived(
		unsynced !== null && 'count' in unsynced ? unsynced.count > 0 : unsynced !== null
	);
	const businessDate = $derived(session?.businessDate ?? 'pending sync');
	const sessionBusy = $derived(
		session?.state === 'opening' ? 'Opening…' : session?.state === 'closing' ? 'Closing…' : null
	);

	const PILL = 'inline-flex h-10 items-center gap-1.5 rounded-full px-2.5 text-body sm:px-3';
	const OFFLINE_PAIR = 'bg-st-offline-bg text-st-offline font-semibold';
	const PRINTER_TONE: Record<TillBarPrinter['tone'], string> = {
		ok: 'bg-ok-bg text-ok',
		offline: 'bg-st-offline-bg text-st-offline',
		danger: 'bg-danger-bg text-danger',
		neutral: 'border border-rail-line text-rail-ink-2'
	};

	/**
	 * A <details> menu that closes on Escape (focus back on its summary) and on a
	 * tap outside it. Native <details> does neither.
	 */
	function dismissable(node: HTMLDetailsElement) {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || !node.open) return;
			node.open = false;
			node.querySelector('summary')?.focus();
		};
		const onPointer = (event: PointerEvent) => {
			if (node.open && !node.contains(event.target as Node)) node.open = false;
		};
		node.addEventListener('keydown', onKey);
		document.addEventListener('pointerdown', onPointer);
		return {
			destroy() {
				node.removeEventListener('keydown', onKey);
				document.removeEventListener('pointerdown', onPointer);
			}
		};
	}

	const MENU_ITEM =
		'flex min-h-touch-min items-center gap-2 rounded-control px-3 text-ink hover:bg-raise-2';
	const PANEL =
		'absolute right-0 top-full z-50 mt-2 w-72 rounded-card border border-line bg-raise p-2 text-ink shadow-floating';
</script>

<header
	data-rail
	class="bg-rail h-touch text-rail-ink flex shrink-0 items-center gap-2 px-3 sm:gap-3 sm:px-4 lg:px-6"
>
	<nav aria-label="Till" class="flex shrink-0 items-center gap-3">
		<!-- Below sm the brand tile IS the POS link, so the register and PIN screens
		     keep a way back on a phone; from sm the tile is decorative. -->
		<a
			href={employee !== null ? resolve('/pos/order') : resolve('/pos')}
			aria-label="POS"
			aria-current={current === 'order' ? 'page' : undefined}
			class="rounded-control bg-rail-ink font-display text-title text-rail grid size-10 shrink-0 place-items-center font-bold sm:hidden"
			>m</a
		>
		<span
			aria-hidden="true"
			class="rounded-control bg-rail-ink font-display text-title text-rail hidden size-10 shrink-0 place-items-center font-bold sm:grid"
			>m</span
		>
		<a
			href={employee !== null ? resolve('/pos/order') : resolve('/pos')}
			aria-current={current === 'order' ? 'page' : undefined}
			class="min-h-touch-min border-rail-line hidden items-center gap-2 rounded-full border px-5 font-semibold sm:flex {current ===
			'sales'
				? ''
				: 'bg-rail-active'}"
		>
			<Icon name="bag" />
			POS
		</a>
		{#if employee !== null}
			<!-- Recent sales and reprints (menu-and-printing T-31). A tab from 2xl; below
			     that it is in the employee menu (it is not in the brief's width budget). -->
			<a
				href={resolve('/pos/sales')}
				aria-current={current === 'sales' ? 'page' : undefined}
				class="min-h-touch-min border-rail-line hidden items-center gap-2 rounded-full border px-5 font-semibold 2xl:flex {current ===
				'sales'
					? 'bg-rail-active'
					: ''}"
			>
				<Icon name="clipboard" />
				Sales
			</a>
		{/if}
	</nav>

	<div class="hidden min-w-0 flex-col lg:flex">
		<span class="truncate leading-tight font-semibold">{restaurantName ?? 'Restaurant'}</span>
		<span class="text-body text-rail-ink-2 truncate leading-tight"
			>{deviceCode ? `Till ${deviceCode}` : 'Till not registered'}</span
		>
	</div>

	<div
		role="status"
		aria-label="Connection and sync"
		class="ml-auto flex shrink-0 items-center gap-2"
	>
		<span class="{PILL} {online ? 'bg-ok-bg text-ok font-semibold' : OFFLINE_PAIR}"
			><span aria-hidden="true" class="font-mono">{online ? '●' : '◆'}</span>{online
				? 'Online'
				: 'Offline'}</span
		>
		{#if unsynced !== null}
			<span class="{PILL} {pending ? OFFLINE_PAIR : 'border-rail-line text-rail-ink-2 border'}">
				{#if pending}
					<span aria-hidden="true" class="font-mono">◆</span>
				{:else}
					<Icon name="refresh" class="size-4 sm:hidden" />
				{/if}
				<!-- The word's leading space is a no-break space, so no formatter or
				     whitespace rule can swallow it: the pill must read "3 unsynced". -->
				{#if 'count' in unsynced}{unsynced.count}<span class="sr-only sm:not-sr-only"
						>&nbsp;unsynced</span
					>{:else}—<span class="sr-only sm:not-sr-only">&nbsp;unsynced count unavailable</span>{/if}
			</span>
		{/if}
	</div>

	{#if printer !== null}
		<!-- The printer chip (menu-and-printing T-29). Compact: the icon and the glyph;
		     the words are for assistive tech and the test, and a printer problem is
		     also written out in the warnings panel. -->
		<span
			data-testid="printer-chip"
			title={printer.text}
			class="{PRINTER_TONE[
				printer.tone
			]} text-body hidden h-10 shrink-0 items-center gap-1.5 rounded-full px-3 font-semibold xl:inline-flex"
		>
			<Icon name="printer" class="size-5" />
			<span aria-hidden="true" class="font-mono">{printer.glyph}</span>
			<span class="sr-only">{printer.text}</span>
		</span>
	{/if}

	{#if warnings.length > 0}
		<details use:dismissable class="relative shrink-0">
			<summary class="{PILL} {OFFLINE_PAIR} cursor-pointer">
				<span aria-hidden="true" class="font-mono">◆</span>{warnings.length}<span
					class="sr-only sm:not-sr-only"
					>&nbsp;{warnings.length === 1 ? 'warning' : 'warnings'}</span
				>
			</summary>
			<div data-panel class={PANEL}>
				<ul class="flex flex-col gap-1">
					{#each warnings as warning (warning)}
						<li class="text-body flex items-start gap-2 px-3 py-2">
							<span aria-hidden="true" class="text-st-offline font-mono">◆</span>{warning}
						</li>
					{/each}
				</ul>
			</div>
		</details>
	{/if}

	<p aria-live="off" class="hidden shrink-0 flex-col items-end xl:flex">
		<span class="leading-tight font-semibold tabular-nums">{clockTime}</span>
		<span class="text-body text-rail-ink-2 leading-tight">{today}</span>
	</p>

	{#if session === null}
		<p class="hidden shrink-0 flex-col leading-tight md:flex">
			<span class="font-semibold"
				><span aria-hidden="true" class="font-mono">○</span> No session</span
			>
			<span class="text-body text-rail-ink-2 hidden xl:block">Open one to start selling</span>
		</p>
	{:else if employee !== null}
		<a
			href={resolve('/pos/session')}
			aria-label={sessionBusy
				? `Session · ${sessionBusy}`
				: `Session · business date ${businessDate} · Close session`}
			class="min-h-touch-min min-w-touch-min rounded-control border-rail-line bg-rail-raise hidden shrink-0 items-center justify-center gap-2 border px-3 font-semibold sm:flex"
		>
			<Icon name="lock" class="text-rail-ink-2 size-5" />
			<span class="hidden flex-col leading-tight md:flex">
				{#if sessionBusy}
					<span><span aria-hidden="true" class="font-mono">◐</span> {sessionBusy}</span>
				{:else}
					<span><span aria-hidden="true" class="font-mono">●</span> Session</span>
					<span class="text-body text-rail-ink-2 hidden font-normal xl:block">Close session</span>
				{/if}
			</span>
			<Icon name="chevron-right" class="text-rail-ink-2 hidden size-4 md:block" />
		</a>
	{:else}
		<p class="hidden shrink-0 flex-col leading-tight md:flex">
			<span class="font-semibold"><span aria-hidden="true" class="font-mono">●</span> Session</span>
			<span class="text-body text-rail-ink-2 hidden xl:block">Business date {businessDate}</span>
		</p>
	{/if}

	{#if employee !== null}
		<details use:dismissable class="relative shrink-0">
			<summary
				data-testid="till-employee"
				class="min-h-touch-min rounded-control border-rail-line bg-rail-raise flex cursor-pointer items-center gap-2 border p-1 sm:pr-3"
			>
				<span
					aria-hidden="true"
					class="bg-rail-active text-body grid size-10 place-items-center rounded-full font-semibold"
					>{employee.initials}</span
				>
				<span class="hidden flex-col text-left leading-tight md:flex">
					<span class="font-semibold">{employee.name}</span>
					<span class="text-body text-rail-ink-2 hidden xl:block">{employee.role}</span>
				</span>
				<span class="sr-only md:hidden">{`${employee.name} · ${employee.role}`}</span>
				<Icon name="chevron-down" class="text-rail-ink-2 hidden size-4 sm:block" />
			</summary>
			<div data-panel class={PANEL}>
				<a href={resolve('/pos')} class={MENU_ITEM}>
					<Icon name="user-plus" class="text-ink-2 size-5" />
					Switch employee
				</a>
				{#if session !== null}
					<a href={resolve('/pos/session')} class={MENU_ITEM}>
						<Icon name="lock" class="text-ink-2 size-5" />
						Close session…
					</a>
				{/if}
				<a href={resolve('/pos/sales')} class="{MENU_ITEM} 2xl:hidden">
					<Icon name="clipboard" class="text-ink-2 size-5" />
					Sales
				</a>
				{#if employee.isOwner}
					<!-- Setup is owner-only, and enforced on the device (T-29). -->
					<a href={resolve('/pos/printer')} class={MENU_ITEM}>
						<Icon name="printer" class="text-ink-2 size-5" />
						Printer
					</a>
				{/if}
			</div>
		</details>
	{:else}
		<span data-testid="till-employee" class="text-rail-ink-2 shrink-0">Nobody signed in</span>
	{/if}
</header>
