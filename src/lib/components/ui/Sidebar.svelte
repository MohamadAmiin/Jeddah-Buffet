<script lang="ts">
	// THE OWNER'S RAIL — brand, grouped navigation, and who is signed in.
	//
	// A ui/ primitive: every fact it renders arrives as a PROP. It reads no store and
	// no session, which is why `pathname` is passed in rather than read from the
	// router — the layout owns that, and this file stays testable and portable.
	//
	// The rail is a COLOURED OBJECT (bg-rail), not a page surface. It has its own
	// small token family — rail / rail-active / rail-ink / rail-ink-2 / rail-line —
	// because a saturated block has to hold white text, a selected row, muted labels
	// and a visible edge, and the page tokens have no legal value for any of those on
	// its ground. Every pair is measured in tokens.css. It is data-rail, so its focus
	// ring is --c-rail-ring (base.css).
	//
	// TWO VARIANTS (docs/redesign Phase 5). `rail`: the full-height, sticky column
	// from lg up, collapsible. `drawer`: the same content inside the navigation
	// drawer below lg, with a Close navigation button instead of the collapse
	// chevron and the restaurant name as a <p> (the phone bar holds the page's h1).
	// The component renders twice on every page, so every id carries the variant.
	import { resolve } from '$app/paths';
	import { RAIL_COOKIE, RAIL_MAX_AGE_SECONDS } from '$lib/rail';
	import Icon from './Icon.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	type IconName =
		| 'overview'
		| 'menu'
		| 'inventory'
		| 'purchases'
		| 'expenses'
		| 'reports'
		| 'employees'
		| 'pos'
		| 'settings';

	type NavItem = {
		label: string;
		href:
			| '/dashboard'
			| '/settings'
			| '/device'
			| '/employees'
			| '/menu'
			| '/inventory'
			| '/purchases'
			| '/reports'
			| null;
		icon: IconName;
	};
	type NavGroup = { id: string; label: string | null; items: NavItem[] };

	let {
		restaurantName,
		displayName,
		role,
		pathname,
		collapsed = false,
		variant = 'rail',
		onclose
	}: {
		restaurantName: string | null;
		displayName: string;
		role: string;
		pathname: string;
		/**
		 * Rendered by the server from the matcami_rail cookie, so the rail arrives in
		 * its final width on the first frame rather than snapping shut after
		 * hydration. Only the toggle below writes it.
		 */
		collapsed?: boolean;
		variant?: 'rail' | 'drawer';
		/** The drawer's Close navigation button. */
		onclose?: () => void;
	} = $props();

	// An OVERRIDE, not a copy. `let x = $state(collapsed)` would capture the prop
	// once and then ignore it. Until the owner touches the control, the server's
	// value governs; after that, theirs does. The drawer is never collapsed.
	let override = $state<boolean | null>(null);
	const isCollapsed = $derived(variant === 'rail' && (override ?? collapsed));

	function toggleRail() {
		override = !isCollapsed;
		try {
			const value = override ? 'collapsed' : 'expanded';
			const secure = location.protocol === 'https:' ? '; secure' : '';
			document.cookie = `${RAIL_COOKIE}=${value}; path=/; max-age=${RAIL_MAX_AGE_SECONDS}; samesite=lax${secure}`;
		} catch {
			// A blocked cookie write must not break the control. The rail still
			// collapses for this page view; it simply will not be remembered.
		}
	}

	// One entry per dashboard permission key, in the order an owner sets the
	// restaurant up. Rows with an href have routes; the rest render as visibly
	// disabled WITH A REASON rather than as dead links that 404.
	//
	// ONE NAME PER SECTION (docs/redesign Phase 5): the row is called what its page
	// is called — "Deliveries" for /purchases, "POS device" for /device. /device, not
	// /pos: the till's service worker is scoped to /pos by STRING prefix, so no
	// dashboard URL may begin with the characters "pos".
	const groups: NavGroup[] = [
		{
			id: 'workspace',
			label: null,
			items: [{ label: 'Overview', href: '/dashboard', icon: 'overview' }]
		},
		{
			id: 'catalogue',
			label: 'Catalogue',
			items: [
				{ label: 'Menu', href: '/menu', icon: 'menu' },
				{ label: 'Inventory', href: '/inventory', icon: 'inventory' }
			]
		},
		{
			id: 'money',
			label: 'Money',
			items: [
				{ label: 'Deliveries', href: '/purchases', icon: 'purchases' },
				{ label: 'Expenses', href: null, icon: 'expenses' },
				{ label: 'Reports', href: '/reports', icon: 'reports' }
			]
		},
		{
			id: 'setup',
			label: 'Setup',
			items: [
				{ label: 'Employees', href: '/employees', icon: 'employees' },
				{ label: 'POS device', href: '/device', icon: 'pos' },
				{ label: 'Settings', href: '/settings', icon: 'settings' }
			]
		}
	];

	// "You are here" BY PREFIX: /inventory/recipes keeps Inventory lit. The row gets
	// data-current; aria-current="page" goes to the EXACT page only.
	const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

	// ONE row geometry for all nine, links and non-links alike. border-l-4 is carried
	// by EVERY row and painted in the rail's own colour when the row is not current,
	// so the bar costs no reflow when it moves. The current row carries three
	// signals — the bar, the fill and the weight — plus aria-current: colour never
	// carries meaning alone (WCAG 1.4.1).
	const row = $derived(
		'relative flex min-h-10 items-center gap-2.5 rounded-control border-l-4 border-rail px-2.5 text-caption whitespace-nowrap' +
			(isCollapsed ? ' justify-center gap-0 px-0' : '')
	);
	const link =
		'font-medium text-rail-ink hover:bg-rail-raise data-current:border-rail-ink data-current:bg-rail-active data-current:font-semibold';
	const soon = 'text-rail-ink-2';

	// Initials only, and aria-hidden — the name is written beside it.
	const initials = $derived(
		displayName
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => [...word][0]?.toUpperCase() ?? '')
			.join('')
	);

	// THE COLLAPSED RAIL'S TOOLTIP. A row collapsed to its icon still has its label
	// (sr-only) for assistive tech; sighted users get this tooltip on hover and
	// focus. It is drawn in the TOP LAYER (the Popover API), placed from the row's
	// box, because anything positioned inside the scrolling nav would be clipped.
	let tip = $state<HTMLDivElement>();
	let tipText = $state('');
	function showTip(event: Event, label: string) {
		if (!isCollapsed || !tip) return;
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		tipText = label;
		tip.style.top = `${box.top + box.height / 2}px`;
		tip.style.left = `${box.right + 8}px`;
		if (!tip.matches(':popover-open')) tip.showPopover();
	}
	function hideTip() {
		if (tip?.matches(':popover-open')) tip.hidePopover();
	}
</script>

{#snippet icon(name: IconName, tone: string)}
	<!-- Inline SVG, stroke-only, aria-hidden, and NEVER the carrier of meaning: every
	     row keeps its written label beside it. An icon has no accessible name to
	     begin with, and a rail of pictograms is a memory test. -->
	<svg
		class={`size-5 shrink-0 ${tone}`}
		viewBox="0 0 24 24"
		stroke="currentColor"
		fill="none"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		{#if name === 'overview'}
			<rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
			<rect x="13.5" y="3" width="7.5" height="5" rx="1.5" />
			<rect x="13.5" y="11" width="7.5" height="10" rx="1.5" />
			<rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
		{:else if name === 'menu'}
			<path
				d="M12 6.5C10.6 5.2 8.8 4.5 7 4.5H3.5v13H7c1.8 0 3.6.7 5 2 1.4-1.3 3.2-2 5-2h3.5v-13H17c-1.8 0-3.6.7-5 2Z"
			/>
			<path d="M12 6.5v13" />
		{:else if name === 'inventory'}
			<path d="M20.5 7.5 12 3.5 3.5 7.5v9L12 20.5l8.5-4v-9Z" />
			<path d="m3.5 7.5 8.5 4 8.5-4" />
			<path d="M12 11.5v9" />
		{:else if name === 'purchases'}
			<circle cx="9.5" cy="19.5" r="1.4" />
			<circle cx="17.5" cy="19.5" r="1.4" />
			<path d="M2.5 3.5h2.2l2.3 11.1a1.6 1.6 0 0 0 1.6 1.3h8.7a1.6 1.6 0 0 0 1.6-1.3l1.4-7.1H5.6" />
		{:else if name === 'expenses'}
			<path d="M6 3.5h12v17l-2.4-1.7-2.4 1.7-2.4-1.7L8.4 20.5 6 18.8V3.5Z" />
			<path d="M9 8.5h6" />
			<path d="M9 12.5h4" />
		{:else if name === 'reports'}
			<path d="M3.5 20.5h17" />
			<path d="M7 20.5v-5.5" />
			<path d="M12 20.5v-11" />
			<path d="M17 20.5v-8" />
		{:else if name === 'employees'}
			<circle cx="9" cy="8" r="3.5" />
			<path d="M2.75 20a6.25 6.25 0 0 1 12.5 0" />
			<path d="M16.5 4.8a3.5 3.5 0 0 1 0 6.4" />
			<path d="M17.8 14.2A6.25 6.25 0 0 1 21.25 20" />
		{:else if name === 'pos'}
			<rect x="3.5" y="9.5" width="17" height="11" rx="2" />
			<path d="M7.5 9.5V5A1.5 1.5 0 0 1 9 3.5h6A1.5 1.5 0 0 1 16.5 5v4.5" />
			<path d="M7.5 13.5h5" />
			<path d="M7.5 17h5" />
			<path d="M16 15.5h.5" />
		{:else if name === 'settings'}
			<path d="M4 7h10" />
			<path d="M18 7h2" />
			<circle cx="16" cy="7" r="2" />
			<path d="M4 17h2" />
			<path d="M10 17h10" />
			<circle cx="8" cy="17" r="2" />
		{/if}
	</svg>
{/snippet}

<aside
	data-rail
	aria-label="Workspace"
	class="bg-rail text-rail-ink flex min-w-0 flex-col {variant === 'rail'
		? `border-rail-line sticky top-0 hidden h-dvh shrink-0 border-r lg:flex ${isCollapsed ? 'w-18' : 'w-65'}`
		: 'h-full w-full'}"
>
	<!-- BRAND. One letter of the display face on a tile — type, not an asset. -->
	<div
		class="flex flex-none items-center gap-3 pt-5 pb-4 {isCollapsed
			? 'flex-col gap-2 px-2'
			: 'px-4'}"
	>
		<span
			aria-hidden="true"
			class="bg-rail-ink text-rail font-display rounded-control text-title grid size-10 flex-none place-items-center"
		>
			m
		</span>
		<!-- The rail's name is THE h1 at lg and up (e2e/auth.spec.ts asserts it as a
		     heading). Collapsed, it is sr-only, never removed. In the drawer it is a
		     <p>: below lg the phone bar holds the page's h1. -->
		<div class="flex min-w-0 flex-col {isCollapsed ? 'sr-only' : ''}">
			{#if variant === 'rail'}
				<h1 class="text-section text-rail-ink break-words">{restaurantName ?? 'matcami'}</h1>
			{:else}
				<p class="text-section font-display text-rail-ink break-words">
					{restaurantName ?? 'matcami'}
				</p>
			{/if}
			<p class="text-caption text-rail-ink-2">Owner workspace</p>
		</div>

		{#if variant === 'rail'}
			<!-- Its name says what will HAPPEN; aria-expanded carries the state. -->
			<button
				type="button"
				onclick={toggleRail}
				aria-expanded={!isCollapsed}
				aria-controls="rail-nav"
				class="border-rail-line text-rail-ink-2 hover:text-rail-ink hover:border-rail-ink-2 rounded-control grid size-8 flex-none place-items-center border {isCollapsed
					? ''
					: 'ml-auto'}"
			>
				<span class="sr-only">{isCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}</span>
				<Icon name={isCollapsed ? 'chevron-right' : 'chevron-left'} class="size-4" stroke={1.6} />
			</button>
		{:else}
			<button
				type="button"
				onclick={() => onclose?.()}
				class="border-rail-line text-rail-ink rounded-control ml-auto grid size-10 flex-none place-items-center border"
			>
				<span class="sr-only">Close navigation</span>
				<Icon name="x" class="size-5" stroke={1.6} />
			</button>
		{/if}
	</div>

	<!-- THE SCROLL CONTAINER. scroll-py leaves room for the focus ring when a row is
	     scrolled into view; the spacer after the last group makes that room real. -->
	<nav
		id="{variant}-nav"
		aria-label="Dashboard sections"
		class="flex min-h-0 flex-1 scroll-py-1.5 flex-col gap-5 overflow-y-auto px-3 pt-1 pb-4"
	>
		{#each groups as group (group.id)}
			<div class="flex flex-col gap-1.5">
				{#if group.label}
					<!-- Written in natural case, uppercased by CSS, so a screen reader says
					     "Catalogue" rather than spelling it. -->
					<p
						id="{variant}-nav-{group.id}"
						class="text-eyebrow text-rail-ink-2 px-2.5 uppercase {isCollapsed ? 'sr-only' : ''}"
					>
						{group.label}
					</p>
				{/if}
				<ul
					aria-labelledby={group.label ? `${variant}-nav-${group.id}` : undefined}
					class="flex flex-col gap-0.5"
				>
					{#each group.items as item (item.label)}
						<li>
							{#if item.href}
								{@const here = isCurrent(item.href)}
								<a
									href={resolve(item.href)}
									data-current={here ? '' : undefined}
									aria-current={pathname === item.href ? 'page' : undefined}
									class="{row} {link}"
									onmouseenter={(event) => showTip(event, item.label)}
									onmouseleave={hideTip}
									onfocus={(event) => showTip(event, item.label)}
									onblur={hideTip}
								>
									{@render icon(item.icon, here ? 'text-rail-ink' : 'text-rail-ink-2')}
									<span class="min-w-0 {isCollapsed ? 'sr-only' : ''}">{item.label}</span>
								</a>
							{:else}
								<!-- Genuinely non-interactive: aria-disabled and NO link target. A
								     disabled control must say why — the Soon pill says it on the row. -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<span
									aria-disabled="true"
									class="{row} {soon}"
									onmouseenter={(event) => showTip(event, `${item.label} — soon`)}
									onmouseleave={hideTip}
								>
									{@render icon(item.icon, 'text-rail-ink-2')}
									<span class="min-w-0 {isCollapsed ? 'sr-only' : ''}">{item.label}</span>
									<span
										class="text-eyebrow text-rail-ink-2 border-rail-line ml-auto flex-none rounded-full border px-1.5 py-0.5 font-mono uppercase {isCollapsed
											? 'sr-only'
											: ''}"
									>
										Soon<span class="sr-only"> — not built yet</span>
									</span>
								</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
		<div aria-hidden="true" class="h-1.5 flex-none"></div>
	</nav>

	<!-- WHO IS SIGNED IN, Sign out beside it, and the theme below. -->
	<div
		class="border-rail-line flex flex-none flex-col gap-3 border-t py-4 {isCollapsed
			? 'items-center px-2'
			: 'px-4'}"
	>
		<div class="flex min-w-0 items-center gap-2.5 {isCollapsed ? 'flex-col' : ''}">
			<span
				aria-hidden="true"
				class="bg-rail-active text-rail-ink text-caption grid size-9 flex-none place-items-center rounded-full font-mono font-medium"
			>
				{initials}
			</span>
			<!-- sr-only when collapsed, never removed: collapsing is a visual choice. -->
			<div class="flex min-w-0 flex-1 flex-col {isCollapsed ? 'sr-only' : ''}">
				<span class="text-caption text-rail-ink font-medium break-words">{displayName}</span>
				<span class="text-eyebrow text-rail-ink-2 uppercase">{role}</span>
			</div>
			<!-- A FORM, never an anchor: /logout refuses GET, so a link would be
			     triggerable by any image tag on any page. -->
			<form method="POST" action="/logout">
				<button
					type="submit"
					class="border-rail-line text-rail-ink hover:bg-rail-raise rounded-control text-caption flex min-h-9 items-center justify-center gap-2 border font-medium {isCollapsed
						? 'size-10'
						: 'px-3'}"
				>
					<Icon name="log-out" class="size-4" stroke={1.6} />
					<span class={isCollapsed ? 'sr-only' : ''}>Sign out</span>
				</button>
			</form>
		</div>
		<ThemeToggle compact={isCollapsed} />
	</div>
</aside>

{#if variant === 'rail'}
	<div
		bind:this={tip}
		popover="manual"
		aria-hidden="true"
		class="rounded-control border-line bg-raise text-caption text-ink shadow-floating inset-auto m-0 -translate-y-1/2 border px-2 py-1"
	>
		{tipText}
	</div>
{/if}
