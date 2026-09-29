<script lang="ts">
	let {
		id,
		name,
		value,
		label,
		checked = false,
		hint = '',
		disabled = false,
		disabledReason = ''
	}: {
		id: string;
		name: string;
		value: string;
		label: string;
		checked?: boolean;
		hint?: string;
		disabled?: boolean;
		disabledReason?: string;
	} = $props();

	const uid = $props.id();
	const hintId = uid + '-hint';
	const reasonId = uid + '-reason';

	const describedBy = $derived(
		[hint ? hintId : null, disabled && disabledReason ? reasonId : null]
			.filter(Boolean)
			.join(' ') || undefined
	);
</script>

<div class="flex flex-col gap-1">
	<label for={id} class="text-ink-2 text-sm font-medium">
		<input
			type="checkbox"
			{id}
			{name}
			{value}
			{checked}
			{disabled}
			aria-describedby={describedBy}
			class="accent-accent"
		/>
		{label}
	</label>

	{#if hint}
		<span id={hintId} class="text-ink-3 text-xs">
			{hint}
		</span>
	{/if}

	{#if disabled && disabledReason}
		<span id={reasonId} class="text-ink-2 text-xs">
			{disabledReason}
		</span>
	{/if}
</div>
