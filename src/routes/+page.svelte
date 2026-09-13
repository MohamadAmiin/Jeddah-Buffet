<!--
	Plain landing page. It exists so `pnpm dev` serves something and the
	Playwright smoke test (T-09) has a stable <h1> to assert on. The two links
	are placeholders pointing at `/` until the route groups hold real pages.

	The hrefs go through resolve() because svelte/no-navigation-without-resolve
	requires it for internal navigation. The targets are still `/`; repointing
	them at real routes belongs to the plan that creates those routes.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<main class="p-touch">
	<h1 class="text-3xl font-bold">matcami</h1>
	<p class="mt-2">Restaurant management and point of sale.</p>

	<nav class="mt-6 flex gap-4">
		<a class="underline" href={resolve('/')}>Dashboard</a>
		<a class="underline" href={resolve('/')}>POS</a>
	</nav>
</main>
