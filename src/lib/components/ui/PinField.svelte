<script lang="ts">
	import { Button } from '$lib/components/ui';
	import { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from '$lib/pin';

	let {
		id,
		name,
		label,
		hint = '4 to 6 digits.',
		error = '',
		required = false
	}: {
		id: string;
		name: string;
		label: string;
		hint?: string;
		error?: string;
		required?: boolean;
	} = $props();

	let value = $state('');
	let revealed = $state(false);

	const uid = $props.id();
	const hintId = uid + '-hint';
	const errorId = uid + '-err';

	const describedBy = $derived(
		[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
	);

	const controlClass = 'border-control-line bg-bg text-ink rounded-control border px-3 py-2';
</script>

<div class="flex flex-col gap-1">
	<label for={id} class="text-ink-2 text-sm font-medium">{label}</label>

	<div class="flex gap-2">
		<input
			{id}
			{name}
			type={revealed ? 'text' : 'password'}
			inputmode="numeric"
			pattern="[0-9]*"
			maxlength={PIN_MAX_DIGITS}
			minlength={PIN_MIN_DIGITS}
			autocomplete="off"
			{required}
			aria-describedby={describedBy}
			aria-invalid={error ? 'true' : undefined}
			class={`${controlClass} min-w-0 flex-1`}
			{value}
			oninput={(event) => {
				const target = event.currentTarget as HTMLInputElement;
				const digits = target.value.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS);
				target.value = digits;
				value = digits;
			}}
		/>

		<Button
			variant="ghost"
			type="button"
			aria-pressed={revealed}
			onclick={() => (revealed = !revealed)}
		>
			{revealed ? 'Hide PIN' : 'Show PIN'}
		</Button>
	</div>

	{#if hint}
		<p id={hintId} class="text-ink-3 text-xs">{hint}</p>
	{/if}

	{#if error}
		<p id={errorId} class="text-danger text-sm">{error}</p>
	{/if}
</div>
