<!--
	Plain landing page. It exists so `pnpm dev` serves something and the
	Playwright smoke test (T-09) has a stable <h1> to assert on. The two links
	are placeholders pointing at `/` until the route groups hold real pages.
-->
<main class="p-touch">
	<h1 class="text-3xl font-bold">matcami</h1>
	<p class="mt-2">Restaurant management and point of sale.</p>

	<nav class="mt-6 flex gap-4">
		<a class="underline" href="/">Dashboard</a>
		<a class="underline" href="/">POS</a>
	</nav>
</main>
