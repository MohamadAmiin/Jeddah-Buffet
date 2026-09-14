<script lang="ts">
	// A dashboard panel. CARDS DO NOT NEST INSIDE CARDS — an inset region inside one
	// is `bg-raise-2` with `rounded-control`, not a second Card
	// (docs/design-system.md section 7b).

	let {
		children,
		class: className = '',
		...rest
	}: {
		children: import('svelte').Snippet;
		class?: string;
		[key: string]: unknown;
	} = $props();
</script>

<!-- border-line is correct here: a card edge is DECORATIVE. Contrast Button and
     Field, where a control edge must be border-control-line. className is appended
     last so a caller can add layout classes (max-w-sm, mt-4) without fighting the
     token-built base. -->
<div {...rest} class={`bg-raise border-line shadow-card rounded-card border p-6 ${className}`}>
	{@render children()}
</div>
