<script lang="ts">
	// THE NAVIGATION DRAWER (docs/redesign Phase 5) — a native modal <dialog>. The
	// dialog itself is the full-screen scrim and the rail panel sits inside it, which
	// avoids ::backdrop (it does not inherit custom properties before Safari 17.4)
	// and makes "tap outside" a click whose target is the dialog. showModal() gives
	// the focus trap, Escape, and focus return to the menu button; `onclose` keeps
	// `open` in sync when Escape closes it, or the next "Open navigation" would do
	// nothing. m-0 / max-h-none / max-w-none / border-0 / p-0 undo the browser's
	// modal-dialog margin, size caps, border and padding.
	import type { Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';

	let { open = $bindable(false), children }: { open?: boolean; children: Snippet } = $props();
	let dialog = $state<HTMLDialogElement>();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});
	afterNavigate(() => (open = false));
</script>

<dialog
	bind:this={dialog}
	id="nav-drawer"
	aria-label="Navigation"
	onclose={() => (open = false)}
	onclick={(event) => {
		if (event.target === dialog) dialog?.close();
	}}
	class="bg-scrim m-0 h-dvh max-h-none w-full max-w-none border-0 p-0 backdrop:bg-transparent"
>
	<div data-rail class="bg-rail text-rail-ink shadow-floating flex h-full w-72 max-w-full flex-col">
		{#if open}{@render children()}{/if}
	</div>
</dialog>
