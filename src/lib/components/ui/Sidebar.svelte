<script lang="ts">
	// THE OWNER'S RAIL — brand, grouped navigation, and who is signed in.
	//
	// A ui/ primitive: every fact it renders arrives as a PROP. It reads no store and
	// no session, which is why `pathname` is passed in rather than read from the
	// router — the layout owns that, and this file stays testable and portable.
	//
	// The rail is a SURFACE (bg-raise) with one decorative hairline against the page
	// ground, not a strip of links floating on the ground. Nine flat items are a
	// list; four groups are a structure.
	import { resolve } from '$app/paths';
	import ThemeToggle from './ThemeToggle.svelte';

	type IconName =
		| 'overview'
		| 'menu'
		| 'inventory'
		| 'purchases'
		| 'expenses'
		| 'reports'
		| 'employees'
		| 'devices'
		| 'settings';

	type NavItem = { label: string; href: '/dashboard' | '/settings' | null; icon: IconName };
	type NavGroup = { id: string; label: string | null; items: NavItem[] };

	let {
		restaurantName,
		displayName,
		role,
		pathname
	}: {
		restaurantName: string | null;
		displayName: string;
		role: string;
		pathname: string;
	} = $props();

	// One entry per dashboard permission key, in the order an owner sets the
	// restaurant up. Only Overview and Settings have routes; the other seven render
	// as visibly disabled WITH A REASON rather than as dead links that 404, or as
	// hidden items that leave the owner wondering whether the product has those
	// features at all.
	const groups: NavGroup[] = [
		{
			id: 'nav-workspace',
			label: null,
			items: [{ label: 'Overview', href: '/dashboard', icon: 'overview' }]
		},
		{
			id: 'nav-catalogue',
			label: 'Catalogue',
			items: [
				{ label: 'Menu', href: null, icon: 'menu' },
				{ label: 'Inventory', href: null, icon: 'inventory' }
			]
		},
		{
			id: 'nav-money',
			label: 'Money',
			items: [
				{ label: 'Purchases', href: null, icon: 'purchases' },
				{ label: 'Expenses', href: null, icon: 'expenses' },
				{ label: 'Reports', href: null, icon: 'reports' }
			]
		},
		{
			id: 'nav-setup',
			label: 'Setup',
			items: [
				{ label: 'Employees', href: null, icon: 'employees' },
				{ label: 'Devices', href: null, icon: 'devices' },
				{ label: 'Settings', href: '/settings', icon: 'settings' }
			]
		}
	];

	// ONE row geometry for all nine, links and non-links alike, so the rail reads as
	// a single list. border-l-4 is carried by EVERY row and painted in the rail's own
	// surface when the row is not current, so the accent bar costs no reflow when it
	// moves. (The sample draws that bar at 3px; no border-width token exists and an
	// arbitrary value is forbidden, so it is the 4px step here.)
	const row =
		'relative flex min-h-10 items-center gap-2.5 rounded-control border-l-4 px-2.5 text-caption whitespace-nowrap';

	// THE CURRENT ITEM CARRIES THREE SIGNALS, not one: the soft accent fill, accent
	// text and icon, and the bar — plus aria-current="page" for anyone who reads the
	// page rather than sees it. Colour never carries meaning alone (WCAG 1.4.1).
	const current = 'border-l-accent bg-accent-soft text-accent font-semibold';
	const link = 'border-l-raise text-ink font-medium hover:bg-bg-2';
	const soon = 'border-l-raise text-ink-2';

	// Initials only, and aria-hidden — the name is written beside it. Split on
	// whitespace so a one-word display name still yields one letter.
	const initials = $derived(
		displayName
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => [...word][0]?.toUpperCase() ?? '')
			.join('')
	);
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
		{:else if name === 'devices'}
			<rect x="6" y="2.5" width="12" height="19" rx="2.5" />
			<path d="M10.5 18.5h3" />
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

<!-- Full height and sticky from `lg` up; ABOVE the content below it, never hidden.
     A rail that vanishes on a phone takes with it the one screen that says which
     parts of the product are built. -->
<aside
	aria-label="Workspace"
	class="bg-raise border-line flex min-w-0 flex-col border-b lg:sticky lg:top-0 lg:h-screen lg:w-65 lg:shrink-0 lg:border-r lg:border-b-0"
>
	<!-- BRAND. The mark is one letter of the display face on an accent tile — type,
	     not an asset: nothing to commission, nothing to cache, and it re-colours with
	     the theme because it names roles rather than colours. aria-hidden, because
	     the restaurant name is written beside it. -->
	<div class="flex flex-none items-center gap-3 px-4 pt-5 pb-4">
		<span
			aria-hidden="true"
			class="bg-accent text-accent-ink font-display rounded-control shadow-flat grid size-10 flex-none place-items-center text-title"
		>
			m
		</span>
		<div class="flex min-w-0 flex-col">
			<!-- A REAL heading element, and the only h1 on every dashboard screen.
			     e2e/auth.spec.ts asserts getByRole('heading', { name: <restaurant> })
			     twice — after registration and again after the rename — so a styled div
			     breaks the journey even though it looks identical. -->
			<h1 class="text-section text-ink break-words">{restaurantName ?? 'matcami'}</h1>
			<p class="text-caption text-ink-2">Owner workspace</p>
		</div>
	</div>

	<!-- THE SCROLL CONTAINER. scroll-py reserves room for the 2px focus ring plus its
	     2px offset when a row is scrolled into view, and the spacer after the last
	     group makes that room real scrollable content — padding alone does not, and
	     the ring on the last row is then clipped away at the scrollport edge. -->
	<nav
		aria-label="Dashboard sections"
		class="flex min-w-0 flex-none scroll-py-1.5 flex-row items-center gap-1.5 overflow-x-auto overflow-y-hidden px-4 pt-1 pb-2 lg:min-h-0 lg:flex-1 lg:flex-col lg:items-stretch lg:gap-0 lg:overflow-x-hidden lg:overflow-y-auto lg:px-3 lg:pb-1.5"
	>
		{#each groups as group (group.id)}
			{#if group.label}
				<!-- ink-3, NOT accent: accent is reserved for the current item, and three
				     accent labels above it would drown the one signal that means "you are
				     here". Written in natural case and uppercased by CSS, so a screen
				     reader says "Catalogue" instead of spelling it. -->
				<p
					id={group.id}
					class="text-eyebrow text-ink-3 border-line-soft mx-0.5 flex-none border-l py-1 pl-3.5 uppercase lg:mx-0 lg:mt-4 lg:mb-1.5 lg:border-l-0 lg:py-0"
				>
					{group.label}
				</p>
			{/if}
			<ul
				aria-labelledby={group.label ? group.id : undefined}
				class="flex flex-none flex-row gap-1.5 lg:flex-col lg:gap-0.5"
			>
				{#each group.items as item (item.label)}
					<li>
						{#if item.href}
							<a
								href={resolve(item.href)}
								aria-current={pathname === item.href ? 'page' : undefined}
								class={`${row} ${pathname === item.href ? current : link}`}
							>
								{@render icon(item.icon, pathname === item.href ? 'text-accent' : 'text-ink-2')}
								<span class="min-w-0">{item.label}</span>
							</a>
						{:else}
							<!--
								Genuinely non-interactive: aria-disabled and NO link target, so a
								keyboard user does not tab into a control that does nothing. A
								disabled control must say why — that rule is from the design system
								and applies here as much as on the POS; the Soon pill says it on the
								row and the note under the nav says when each one arrives.

								`relative` is not decoration. The pill carries an .sr-only span,
								which is absolutely positioned; with no positioned ancestor its
								containing block is the initial one, so it escapes this nav's
								overflow and the DOCUMENT scrolls sideways on a phone.
							-->
							<span aria-disabled="true" class={`${row} ${soon}`}>
								{@render icon(item.icon, 'text-ink-3')}
								<span class="min-w-0">{item.label}</span>
								<span
									class="text-eyebrow text-ink-3 bg-bg-2 ml-auto flex-none rounded-full px-1.5 py-0.5 font-mono uppercase"
								>
									Soon<span class="sr-only"> — not built yet</span>
								</span>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/each}
		<!-- Real scrollable content, so the focus ring on the last row has somewhere
		     to land. See the scroll-py note above. -->
		<div aria-hidden="true" class="h-1.5 flex-none"></div>
	</nav>

	<!-- The scroll cue is WRITTEN, not left to a scrollbar: an overlay scrollbar is
	     invisible until you have already guessed to swipe. lg:hidden takes it out of
	     the accessibility tree at desktop, where it would be a lie.

	     The paragraph that used to sit here — explaining that the seven greyed rows
	     are not built — has been removed. Each row already says "Soon" beside its own
	     label, which is where a reader looks; repeating it as a block of prose under
	     the nav made it the largest piece of text in the rail while saying the least. -->
	<p class="text-caption text-ink-2 flex-none px-4 pb-4 lg:hidden">
		The row above scrolls sideways; all nine sections are in it.
	</p>

	<div
		class="border-line-soft mt-auto flex flex-none flex-row flex-wrap items-center gap-3 border-t px-4 py-4 lg:flex-col lg:items-stretch"
	>
		<div class="flex min-w-0 items-center gap-2.5">
			<span
				aria-hidden="true"
				class="bg-accent-soft text-accent grid size-9 flex-none place-items-center rounded-full font-mono text-caption font-semibold"
			>
				{initials}
			</span>
			<div class="flex min-w-0 flex-col">
				<span class="text-caption text-ink font-medium break-words">{displayName}</span>
				<!-- The role is a fact about the signed-in person, not a decoration: it is
				     what decides which of these sections will ever be reachable. -->
				<span class="text-eyebrow text-ink-2 uppercase">{role}</span>
			</div>
		</div>

		<ThemeToggle />

		<!--
			A FORM, never an anchor. /logout refuses GET (its load returns 405), so a
			link would be triggerable by any image tag on any page. The design carries
			that: "Sign out" is a submit button and it looks like one.
		-->
		<form method="POST" action="/logout" class="ml-auto lg:ml-0">
			<button
				type="submit"
				class="border-control-line text-ink hover:bg-raise-2 rounded-control text-caption flex items-center justify-center gap-2 border px-3 py-2 font-medium lg:w-full"
			>
				<svg
					class="size-4 flex-none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					fill="none"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M15 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2.5" />
					<path d="M11 12h9" />
					<path d="m17.5 8.5 3.5 3.5-3.5 3.5" />
				</svg>
				<span>Sign out</span>
			</button>
		</form>
	</div>
</aside>
