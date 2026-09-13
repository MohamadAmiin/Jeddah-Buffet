<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let submitting = $state(false);

	// Pre-fill from the browser. This value may be a spelling that a
	// list-membership check would reject (Firefox reports Asia/Kolkata and
	// Europe/Kyiv), which is exactly why the server validates by construction.
	const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>

<svelte:head>
	<title>Set up matcami</title>
</svelte:head>

<main class="bg-bg text-ink flex min-h-screen items-center justify-center p-6">
	<div class="bg-raise border-line shadow-card w-full max-w-lg rounded-lg border p-6">
		<h1 class="font-display text-2xl font-bold">Set up your restaurant</h1>
		<p class="text-ink-2 mt-1 text-sm">
			This creates the restaurant and its owner account. It can only be done once.
		</p>

		{#if form?.message}
			<p role="alert" class="border-line bg-bg-2 text-danger mt-4 rounded border px-3 py-2 text-sm">
				{form.message}
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
			<div class="flex flex-col gap-1">
				<label for="restaurantName" class="text-ink-2 text-sm font-medium">Restaurant name</label>
				<input
					id="restaurantName"
					name="restaurantName"
					required
					value={form?.restaurantName ?? ''}
					class="border-line bg-bg text-ink rounded border px-3 py-2"
				/>
			</div>

			<div class="flex flex-col gap-1">
				<label for="timeZone" class="text-ink-2 text-sm font-medium">Time zone</label>
				<input
					id="timeZone"
					name="timeZone"
					list="time-zones"
					required
					value={form?.timeZone || browserTimeZone}
					class="border-line bg-bg text-ink rounded border px-3 py-2"
				/>
				<!-- A datalist, not a select: the owner must be able to type a zone the
				     suggestion list omits. -->
				<datalist id="time-zones">
					{#each data.timeZones as tz (tz)}
						<option value={tz}></option>
					{/each}
				</datalist>
				<p class="text-ink-3 text-xs">
					This decides which business day a sale belongs to — a sale at 01:30 counts toward the
					previous evening. You can change it later.
				</p>
			</div>

			<div class="flex flex-col gap-1">
				<label for="ownerDisplayName" class="text-ink-2 text-sm font-medium">Your name</label>
				<input
					id="ownerDisplayName"
					name="ownerDisplayName"
					required
					value={form?.ownerDisplayName ?? ''}
					class="border-line bg-bg text-ink rounded border px-3 py-2"
				/>
			</div>

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
					autocomplete="new-password"
					required
					minlength="8"
					class="border-line bg-bg text-ink rounded border px-3 py-2"
				/>
				<p class="text-ink-3 text-xs">At least 8 characters.</p>
			</div>

			<div class="flex flex-col gap-1">
				<label for="passwordConfirm" class="text-ink-2 text-sm font-medium">
					Confirm password
				</label>
				<input
					id="passwordConfirm"
					name="passwordConfirm"
					type="password"
					autocomplete="new-password"
					required
					class="border-line bg-bg text-ink rounded border px-3 py-2"
				/>
			</div>

			<div class="flex flex-col gap-1">
				<label for="setupToken" class="text-ink-2 text-sm font-medium">Setup token</label>
				<input
					id="setupToken"
					name="setupToken"
					required
					class="border-line bg-bg text-ink rounded border px-3 py-2"
				/>
				<p class="text-ink-3 text-xs">
					The one-time value from the server's <code>SETUP_TOKEN</code> environment variable. It is required
					only for the first restaurant, and should be unset afterwards.
				</p>
			</div>

			<button
				type="submit"
				disabled={submitting}
				class="bg-accent text-accent-ink rounded px-3 py-2 font-medium disabled:opacity-60"
			>
				{submitting ? 'Creating…' : 'Create restaurant'}
			</button>
		</form>
	</div>
</main>
