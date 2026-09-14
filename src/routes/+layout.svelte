<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	// Imported once here so the stylesheet loads for every route.
	import '../app.css';
	// Self-hosted, bundled by Vite and served from matcami's own origin — never a
	// third-party origin in a till's critical path, which fails with no network.
	// `wght.css` is the WEIGHT axis only; the variable packages also ship a width
	// axis the design system never asks for. Each file declares one @font-face per
	// unicode subset with a unicode-range, so a browser downloads only what it uses.
	import '@fontsource-variable/archivo/wght.css';
	import '@fontsource-variable/ibm-plex-sans/wght.css';
	import '@fontsource/ibm-plex-mono/400.css';
	import '@fontsource/ibm-plex-mono/500.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
