<script lang="ts" module>
	export type KeypadKey =
		'0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'clear' | 'back';
</script>

<script lang="ts">
	// THE KEYPAD — one component for the PIN, pay and session screens (docs/redesign
	// Phase 3), where there were three drifting copies. Digits in mono at weight 500
	// (IBM Plex Mono ships 400 and 500 only); Clear in the body face; ⌫ as an icon
	// with a spoken name. It only reports keys — each page keeps its own digit limit
	// and its own meaning for them, and does its own formatting.
	import Icon from '../ui/Icon.svelte';
	import { KEY } from './keys';

	let {
		label,
		disabled = false,
		reason,
		onkey
	}: {
		/** The group's accessible name, e.g. "Amount tendered". */
		label: string;
		disabled?: boolean;
		/** The id of the line that says why the keypad is disabled. */
		reason?: string;
		onkey: (key: KeypadKey) => void;
	} = $props();

	const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
	const describedBy = $derived(disabled && reason ? reason : undefined);
</script>

<div role="group" aria-label={label} class="grid grid-cols-3 gap-2">
	{#each DIGITS as digit (digit)}
		<button
			type="button"
			{disabled}
			aria-describedby={describedBy}
			class="min-h-touch-lg text-title font-mono font-medium tabular-nums {KEY}"
			onclick={() => onkey(digit)}>{digit}</button
		>
	{/each}
	<button
		type="button"
		{disabled}
		aria-describedby={describedBy}
		class="min-h-touch-lg {KEY}"
		onclick={() => onkey('clear')}>Clear</button
	>
	<button
		type="button"
		{disabled}
		aria-describedby={describedBy}
		class="min-h-touch-lg text-title font-mono font-medium tabular-nums {KEY}"
		onclick={() => onkey('0')}>0</button
	>
	<button
		type="button"
		{disabled}
		aria-describedby={describedBy}
		class="min-h-touch-lg grid place-items-center {KEY}"
		onclick={() => onkey('back')}
	>
		<span class="sr-only">Delete the last digit</span>
		<Icon name="backspace" class="size-7" />
	</button>
</div>
