<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Alert, AuthSplit, Button, Field } from '$lib/components/ui';

	let { form } = $props();
	let submitting = $state(false);

	// Carried through so the hook's ?next= survives the POST.
	const next = $derived(page.url.searchParams.get('next') ?? '');
</script>

<svelte:head>
	<title>Sign in · matcami</title>
</svelte:head>

<!-- The two halves are declared as TOP-LEVEL snippets and handed to AuthSplit as
     attributes, never written as children named `form` and `brand` inside its block.
     A snippet named `form` there would shadow this page's `form` prop — the action
     result — throughout its own body, and every `form?.message` below would silently
     read the snippet instead. -->
{#snippet formPanel()}
	{#if form?.message}
		<!-- role="alert" so a screen reader announces the failure without the
		     user having to go looking for it. Alert carries that role. -->
		<Alert tone="danger">
			{form.message}
			{#if form.retryAfterMs}
				Try again in {Math.ceil(form.retryAfterMs / 1000)} seconds.
			{/if}
		</Alert>
	{/if}

	<form
		method="POST"
		class="flex flex-col gap-4"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
	>
		<input type="hidden" name="next" value={next} />

		<Field
			id="email"
			name="email"
			type="email"
			label="Email"
			autocomplete="username"
			required
			value={form?.email ?? ''}
		/>

		<Field
			id="password"
			name="password"
			type="password"
			label="Password"
			autocomplete="current-password"
			required
		/>

		<!-- The button is a stretched flex child, so it fills the form measure without
		     a width class — Button applies its own class last and a caller's would be
		     dropped. While the request is in flight it is disabled and its LABEL says
		     why, which is what keeps a disabled control from sitting dead. -->
		<Button type="submit" variant="primary" disabled={submitting}>
			{submitting ? 'Signing in…' : 'Sign in'}
		</Button>
	</form>
{/snippet}

<!-- NO MONEY FIGURE ON A DASHBOARD SURFACE. Nothing in this product states the
     restaurant's revenue, today's takings or any other computed figure — not even a
     zero, because the money module does not exist yet and a zero is
     indistinguishable from a broken query.

     The slip below carries NO money at all, which is what makes it legal here. It
     is a KITCHEN TICKET, not a guest check: spec 11 says a kitchen ticket prints
     the order number, table, waiter, items, modifiers and notes — and no prices,
     because the kitchen cooks and the till charges. An earlier draft drew a guest
     check with typed-in prices and a "Tax 5%" line; that broke the rule above and
     silently answered spec 33 open decision 3 (tax mode, rate and rounding), which
     is still open. The caption says outright that it is a specimen. -->
{#snippet brandPanel()}
	<div class="bg-raise text-ink rounded-card shadow-floating w-full p-4 font-mono">
		<div class="border-line flex flex-col gap-0.5 border-b border-dashed pb-2">
			<p class="text-caption font-semibold tracking-widest uppercase">Matcami Suugo · KITCHEN</p>
			<p class="text-ink-3 text-eyebrow uppercase">Table 4 · Dine-in · Order #1042 · Amina</p>
		</div>

		<ul class="text-caption flex list-none flex-col gap-1 p-0 pt-2">
			<li class="flex gap-3">
				<span class="text-ink-3 w-9 shrink-0 tabular-nums">1×</span>
				<span class="min-w-0 break-words">Baasto Suugo</span>
			</li>
			<li class="text-ink-2 flex gap-3 pl-12">
				<span class="min-w-0 break-words">+ Extra suqaar</span>
			</li>
			<li class="flex gap-3">
				<span class="text-ink-3 w-9 shrink-0 tabular-nums">2×</span>
				<span class="min-w-0 break-words">Bariis Iskukaris</span>
			</li>
			<li class="flex gap-3">
				<span class="text-ink-3 w-9 shrink-0 tabular-nums">1×</span>
				<span class="min-w-0 break-words">Hilib Ari</span>
			</li>
		</ul>

		<p class="border-line text-ink-2 text-eyebrow mt-2 border-t border-dashed pt-2 uppercase">
			Note: hilib well done
		</p>
	</div>

	<p class="text-caption">
		A specimen kitchen ticket, not live data. A kitchen ticket carries the order, the table, the
		waiter, the items and their modifiers — and <strong>no prices</strong>: the kitchen cooks, the
		till charges.
	</p>
{/snippet}

<AuthSplit
	title="Sign in"
	caption="Management dashboard"
	eyebrow="Restaurant management · point of sale"
	statement="Every sale, every shift, every number that has to tie out."
	form={formPanel}
	brand={brandPanel}
/>
