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
</script>

<main class="p-touch">
	<h1 class="text-3xl font-bold">matcami</h1>
	<p class="mt-2">Restaurant management and point of sale.</p>

	<nav class="mt-6 flex gap-4">
		<a class="underline" href={resolve('/dashboard')}>Dashboard</a>
		<a class="underline" href={resolve('/login')}>Sign in</a>
	</nav>
</main>
