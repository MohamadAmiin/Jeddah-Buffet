<script lang="ts">
	// (dashboard) — the owner/admin surface: menu, purchases, expenses, reports.
	//
	// ONLINE ONLY. Server `load` functions and form actions are fine here, and
	// so is importing from $lib/server.
	//
	// Permissions are still enforced SERVER-side on every route, reads included
	// (invariant 8). Hiding a button in this layout is not security.
	let { children } = $props();
</script>

{@render children()}
