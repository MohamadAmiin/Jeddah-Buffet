<script lang="ts" module>
	import type { IconName } from '../ui/Icon.svelte';
	export type PosIconName = IconName;
</script>

<script lang="ts">
	// Kept so existing till imports keep working: the drawings live in the one
	// icon set, src/lib/components/ui/Icon.svelte (docs/redesign Phase 0).
	import Icon from '../ui/Icon.svelte';
	let { name, class: className = 'size-5' }: { name: PosIconName; class?: string } = $props();
</script>

<Icon {name} class={className} />
