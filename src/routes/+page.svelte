<!--
	Plain landing page. It exists so `pnpm dev` serves something and the
	Playwright smoke test (T-09) has a stable <h1> to assert on.

	The hrefs go through resolve() because svelte/no-navigation-without-resolve
	requires it for internal navigation.

	The <h1> text is asserted by e2e/smoke.spec.ts — do not change it without
	changing that test.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui';
</script>

<!-- Tailwind's default spacing. This element previously carried the 64px POS touch
     token, on a page that is not
     the POS; design-system section 5 reserves the touch scale for the POS surface and
     says the dashboard "uses Tailwind's default spacing; it is seated, mouse-driven
     work". The page ground comes from the base layer on `body`. -->
<main class="mx-auto max-w-page p-8">
	<h1 class="font-display text-3xl font-bold">matcami</h1>
	<p class="text-ink-2 mt-2">Restaurant management and point of sale.</p>

	<!-- Button's href form renders an <a> carrying the variant classes. An <a> has
	     the LINK role, not button, which is correct here — no getByRole('button', …)
	     assertion applies to this page. Never navigate from a <button> with a click
	     handler: that is not a link to a keyboard or a screen reader. -->
	<nav class="mt-6 flex flex-wrap gap-3">
		<Button variant="secondary" href={resolve('/dashboard')}>Dashboard</Button>
		<Button variant="secondary" href={resolve('/login')}>Sign in</Button>
	</nav>
</main>
