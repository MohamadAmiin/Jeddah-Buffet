<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { Alert, Button, Card, Field, PageHeader } from '$lib/components/ui';

	let { form } = $props();
	let submitting = $state(false);

	// Carried through so the hook's ?next= survives the POST.
	const next = $derived(page.url.searchParams.get('next') ?? '');
</script>

<svelte:head>
	<title>Sign in · matcami</title>
</svelte:head>

<!-- No bg-bg/text-ink here: the element base layer (src/lib/styles/base.css) sets
     the page ground and ink on `body`. The full-height centring stays. -->
<main class="flex min-h-screen items-center justify-center p-6">
	<Card class="w-full max-w-sm">
		<PageHeader level={1} title="Sign in" description="Management dashboard" />

		{#if form?.message}
			<!-- role="alert" so a screen reader announces the failure without the
			     user having to go looking for it. Alert carries that role. -->
			<div class="mt-4">
				<Alert tone="danger">
					{form.message}
					{#if form.retryAfterMs}
						Try again in {Math.ceil(form.retryAfterMs / 1000)} seconds.
					{/if}
				</Alert>
			</div>
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

			<Field
				id="email"
				name="email"
				type="email"
				label="Email"
				autocomplete="username"
				required
				value={form?.email ?? ''}
			/>

			<Field
				id="password"
				name="password"
				type="password"
				label="Password"
				autocomplete="current-password"
				required
			/>

			<Button type="submit" variant="primary" disabled={submitting}>
				{submitting ? 'Signing in…' : 'Sign in'}
			</Button>
		</form>
	</Card>
</main>
