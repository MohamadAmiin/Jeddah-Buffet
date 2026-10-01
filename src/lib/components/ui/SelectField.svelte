<script lang="ts">
	let {
		id,
		name,
		label,
		value = '',
		required = false,
		hint = '',
		error = '',
		placeholder = '',
		options,
		disabled = false,
		disabledReason = ''
	}: {
		id: string;
		name: string;
		label: string;
		value?: string;
		required?: boolean;
		hint?: string;
		error?: string;
		placeholder?: string;
		options: { value: string; label: string; disabled?: boolean }[];
		disabled?: boolean;
		disabledReason?: string;
	} = $props();

	const uid = $props.id();
	const hintId = uid + '-hint';
	const errorId = uid + '-err';
	const reasonId = uid + '-reason';

	const describedBy = $derived(
		[hint ? hintId : null, error ? errorId : null, disabled && disabledReason ? reasonId : null]
			.filter(Boolean)
			.join(' ') || undefined
	);

	// A disabled select takes the disabled PAIR, never opacity (docs/redesign Phase 6).
	const controlClass =
		'border-control-line bg-bg text-ink rounded-control border px-3 py-2 disabled:cursor-not-allowed disabled:bg-disabled-bg disabled:text-disabled-ink';
</script>

<div class="flex flex-col gap-1">
	<label for={id} class="text-ink-2 text-sm font-medium">{label}</label>

	<select
		{id}
		{name}
		{value}
		{required}
		{disabled}
		aria-describedby={describedBy}
		aria-invalid={error ? 'true' : undefined}
		class={controlClass}
	>
		{#if placeholder && !value}
			<option value="" disabled>{placeholder}</option>
		{/if}

		{#each options as option (option.value)}
			<option value={option.value} disabled={option.disabled}>{option.label}</option>
		{/each}
	</select>

	{#if hint}
		<p id={hintId} class="text-ink-3 text-xs">{hint}</p>
	{/if}

	{#if error}
		<p id={errorId} class="text-danger text-sm">{error}</p>
	{/if}

	{#if disabled && disabledReason}
		<span id={reasonId} class="text-ink-2 text-xs">{disabledReason}</span>
	{/if}
</div>
