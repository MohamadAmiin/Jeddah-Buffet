<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';

	let { form } = $props();
	let submitting = $state(false);

	// Carried through so the hook's ?next= survives the POST.
	const next = $derived(page.url.searchParams.get('next') ?? '');
</script>

<svelte:head>
	<title>Sign in · matcami</title>
</svelte:head>

<main class="bg-bg text-ink flex min-h-screen items-center justify-center p-6">
	<div class="bg-raise border-line shadow-card w-full max-w-sm rounded-lg border p-6">
		<h1 class="font-display text-2xl font-bold">Sign in</h1>
		<p class="text-ink-2 mt-1 text-sm">Management dashboard</p>

		{#if form?.message}
			<!-- role="alert" so a screen reader announces the failure without the
			     user having to go looking for it. -->
			<p role="alert" class="border-line bg-bg-2 text-danger mt-4 rounded border px-3 py-2 text-sm">
				{form.message}
				{#if form.retryAfterMs}
					Try again in {Math.ceil(form.retryAfterMs / 1000)} seconds.
				{/if}
			</p>
		{/if}

		<form
			method="POST"
			class="mt-4 flex flex-col gap-4"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<input type="hidden" name="next" value={next} />

			<div class="flex flex-col gap-1">
				<label for="email" class="text-ink-2 text-sm font-medium">Email</label>
				<input
					id="email"
					name="email"
					type="email"
					autocomplete="username"
					required
					value={form?.email ?? ''}
					class="border-line bg-bg text-ink rounded border px-3 py-2"
				/>
			</div>

			<div class="flex flex-col gap-1">
				<label for="password" class="text-ink-2 text-sm font-medium">Password</label>
				<input
					id="password"
					name="password"
					type="password"
					autocomplete="current-password"
					required
					class="border-line bg-bg text-ink rounded border px-3 py-2"
				/>
			</div>

			<button
				type="submit"
				disabled={submitting}
				class="bg-accent text-accent-ink rounded px-3 py-2 font-medium disabled:opacity-60"
			>
				{submitting ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	</div>
</main>
