<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	// Imported once here so the stylesheet loads for every route.
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
