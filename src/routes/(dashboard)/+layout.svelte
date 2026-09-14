<script lang="ts">
	// (dashboard) — the owner/admin surface: menu, purchases, expenses, reports.
	//
	// ONLINE ONLY. Server `load` functions and form actions are fine here, and
	// so is importing from $lib/server.
	//
	// Permissions are still enforced SERVER-side on every route, reads included
	// (invariant 8). Hiding a button in this layout is not security.
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { ThemeToggle } from '$lib/components/ui';

	let { data, children } = $props();

	// One entry per dashboard permission key from
	// src/lib/server/permissions/keys.ts, in the order an owner sets the restaurant
	// up. Only the first two have routes; the rest render as visibly disabled with
	// a reason rather than as dead links that 404 or as hidden items that make the
	// owner wonder whether the product has those features.
	const nav = [
		{ label: 'Overview', href: '/dashboard' },
		{ label: 'Settings', href: '/settings' },
		{ label: 'Employees', href: null },
		{ label: 'Menu', href: null },
		{ label: 'Inventory', href: null },
		{ label: 'Purchases', href: null },
		{ label: 'Expenses', href: null },
		{ label: 'Reports', href: null },
		{ label: 'Devices', href: null }
	];
</script>

<!-- No bg-bg/text-ink: the element base layer sets the page ground and ink on
     `body` (src/lib/styles/base.css). -->
<div class="min-h-screen">
	<!-- Chrome, separated from the content by a border-line bottom edge. Wraps
	     gracefully at narrow widths. -->
	<header class="bg-raise border-line flex flex-wrap items-center gap-4 border-b px-4 py-3">
		<!-- A REAL heading element. e2e/auth.spec.ts asserts
		     getByRole('heading', { name: <the restaurant name> }) twice — after
		     registration and again after the rename — so a styled div breaks the
		     journey even though it looks identical. -->
		<h1 class="font-display text-lg font-bold">
			{data.restaurantName ?? 'matcami'}
		</h1>

		<!-- The trailing group: theme control, display name, sign-out. -->
		<div class="ml-auto flex flex-wrap items-center gap-3">
			<ThemeToggle />
			<span class="text-ink-2 text-sm">{data.displayName}</span>
			<!--
				A FORM, never an anchor. /logout refuses GET, and a link would be
				triggerable by any image tag on any page.
			-->
			<form method="POST" action="/logout">
				<button
					type="submit"
					class="border-control-line text-ink hover:bg-raise-2 rounded-control border px-3 py-1 text-sm"
				>
					Sign out
				</button>
			</form>
		</div>
	</header>

	<div class="mx-auto flex max-w-page flex-col gap-6 p-4 md:flex-row">
		<!-- Collapses above the content on narrow screens: the owner may open this
		     on a phone, and nothing here should scroll horizontally.

		     CONTRAST REPAIR, and it changes no colour value. The disabled entries and
		     their `coming soon` labels use text-ink-3, which measures only 4.35:1 on
		     the bg-bg page ground — below the 4.5:1 floor CLAUDE.md calls
		     non-negotiable. The fix is WHICH SURFACE they sit on: this nav is a
		     bg-raise panel, where text-ink-3 is 5.13:1 in light and 4.87:1 in dark,
		     legal in both themes. Do not "tidy" this panel away and leave the ink-3
		     entries on the page ground. -->
		<nav
			aria-label="Dashboard"
			class="bg-raise border-line rounded-card border p-2 md:w-56 md:shrink-0"
		>
			<ul class="flex flex-col gap-1">
				{#each nav as item (item.label)}
					<li>
						{#if item.href}
							<a
								href={resolve(item.href as '/dashboard' | '/settings')}
								aria-current={page.url.pathname === item.href ? 'page' : undefined}
								class="hover:bg-raise-2 aria-[current=page]:bg-raise-2 aria-[current=page]:text-ink text-ink-2 rounded-control block px-3 py-2 text-sm"
							>
								{item.label}
							</a>
						{:else}
							<!--
								Genuinely non-interactive: aria-disabled and NO link target, so a
								keyboard user does not tab into a control that does nothing. A
								disabled control must say why — that rule is from the design
								system and applies here as much as on the POS.
							-->
							<span
								aria-disabled="true"
								class="text-ink-3 rounded-control flex items-center justify-between gap-2 px-3 py-2 text-sm"
							>
								{item.label}
								<span class="text-ink-3 text-xs">coming soon</span>
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		</nav>

		<main class="min-w-0 flex-1">
			{@render children()}
		</main>
	</div>
</div>
