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

<div class="bg-bg text-ink min-h-screen">
	<header class="bg-raise border-line flex flex-wrap items-center gap-4 border-b px-4 py-3">
		<h1 class="font-display text-lg font-bold">
			{data.restaurantName ?? 'matcami'}
		</h1>

		<div class="ml-auto flex items-center gap-3">
			<span class="text-ink-2 text-sm">{data.displayName}</span>
			<!--
				A FORM, never an anchor. /logout refuses GET, and a link would be
				triggerable by any image tag on any page.
			-->
			<form method="POST" action="/logout">
				<button
					type="submit"
					class="border-line text-ink-2 hover:text-ink rounded border px-3 py-1 text-sm"
				>
					Sign out
				</button>
			</form>
		</div>
	</header>

	<div class="flex flex-col gap-6 p-4 md:flex-row">
		<!-- Collapses above the content on narrow screens: the owner may open this
		     on a phone, and nothing here should scroll horizontally. -->
		<nav aria-label="Dashboard" class="md:w-56 md:shrink-0">
			<ul class="flex flex-col gap-1">
				{#each nav as item (item.label)}
					<li>
						{#if item.href}
							<a
								href={resolve(item.href as '/dashboard' | '/settings')}
								aria-current={page.url.pathname === item.href ? 'page' : undefined}
								class="hover:bg-raise aria-[current=page]:bg-raise aria-[current=page]:text-ink text-ink-2 block rounded px-3 py-2 text-sm"
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
								class="text-ink-3 flex items-center justify-between rounded px-3 py-2 text-sm"
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
