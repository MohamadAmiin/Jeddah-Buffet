<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Settings · matcami</title>
</svelte:head>

<h2 class="font-display text-xl font-bold">Restaurant settings</h2>

{#if form?.message}
	<p role="alert" class="border-line bg-raise text-ink mt-4 rounded border px-3 py-2 text-sm">
		{form.message}
	</p>
{/if}

<form
	method="POST"
	class="bg-raise border-line shadow-card mt-4 flex max-w-lg flex-col gap-4 rounded border p-4"
	use:enhance={() => {
		submitting = true;
		return async ({ update }) => {
			await update();
			submitting = false;
		};
	}}
>
	<div class="flex flex-col gap-1">
		<label for="name" class="text-ink-2 text-sm font-medium">Restaurant name</label>
		<input
			id="name"
			name="name"
			required
			value={data.name}
			class="border-line bg-bg text-ink rounded border px-3 py-2"
		/>
	</div>

	<div class="flex flex-col gap-1">
		<label for="timeZone" class="text-ink-2 text-sm font-medium">Time zone</label>
		<!-- Free text with a datalist, not a select: the owner must be able to enter
		     a zone the suggestion list omits. -->
		<input
			id="timeZone"
			name="timeZone"
			list="time-zones"
			required
			value={data.timeZone}
			class="border-line bg-bg text-ink rounded border px-3 py-2"
		/>
		<datalist id="time-zones">
			{#each data.timeZones as tz (tz)}
				<option value={tz}></option>
			{/each}
		</datalist>
		<p class="text-ink-3 text-xs">
			This decides which business day a sale belongs to — a sale at 01:30 counts toward the previous
			evening. Changing it is allowed and is recorded with the old and new values; it does not
			rewrite anything already recorded.
		</p>
	</div>

	<!--
		NO fields for tax mode, tax rate, currency, approval limits or idle-lock
		timing — not even disabled ones. Spec 33 open decisions 3, 4 and 6 are
		unresolved, and a greyed-out field showing a plausible default is how an
		unmade decision becomes a remembered fact.
	-->

	<div>
		<button
			type="submit"
			disabled={submitting}
			class="bg-accent text-accent-ink rounded px-3 py-2 text-sm font-medium disabled:opacity-60"
		>
			{submitting ? 'Saving…' : 'Save settings'}
		</button>
	</div>
</form>
