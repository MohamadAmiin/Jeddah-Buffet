<script lang="ts">
	// (pos) — the POS shell: PIN login, orders, payment, session open/close.
	//
	// MUST WORK OFFLINE. Two hard constraints for everything under this group:
	//
	//   1. Never import from $lib/server. SvelteKit build-blocks server modules
	//      from the browser, so such an import cannot work offline. Shared pure
	//      logic goes in an isomorphic module both sides import — never a copy
	//      (spec 17: one rounding rule, one function, used everywhere).
	//      eslint.config.js enforces this boundary.
	//
	//   2. No blocking server `load`. There is deliberately no
	//      +layout.server.ts and no +page.server.ts anywhere under (pos): a
	//      blocking server load is the seam that makes offline impossible, and
	//      a scaffold is where that pattern gets copied from.
	//
	//   3. Pages live under the INNER pos/ directory, so they serve at /pos/...
	//      A route group is not a URL segment: a page placed directly in this
	//      group serves at a top-level URL and silently escapes the service
	//      worker's /pos scope, the manifest's scope and the route guard's /pos
	//      opening. The POS shell is src/routes/(pos)/pos/+layout.svelte.
	let { children } = $props();
</script>

{@render children()}
