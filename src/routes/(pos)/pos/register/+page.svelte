<script lang="ts">
	// DEVICE REGISTRATION — /pos/register (spec 7: "Owner logs in on the POS device
	// (email + password) -> 'Register this device as POS1' -> Server issues a
	// long-lived device cookie (HttpOnly, Secure)").
	//
	// EMAIL AND PASSWORD, NEVER EMAIL ALONE. The first instinct is to ask for the
	// owner's email and nothing else, and it is wrong twice over: an email address is
	// PUBLIC — printed on receipts, on the restaurant's own signage — and a registered
	// device is exactly what spec 6 ships cached employee PIN hashes to, so that
	// employees can switch while the network is down. Email alone would let anyone
	// standing at the counter mint a till and walk away with the staff's PIN hashes.
	//
	// A fetch to POST /api/pos/register, never a native form post: there is no
	// +page.server.ts under (pos), and there must not be one. On success the server
	// has already set the long-lived device cookie AND destroyed the owner's
	// dashboard session on this device. Both cookies are HttpOnly: this page reads,
	// sets and clears neither, and stores nothing in localStorage or sessionStorage.
	// The password never leaves this function: never logged, never in a URL, and
	// cleared from memory when the request ends.
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	let email = $state('');
	let password = $state('');
	let label = $state('');
	let pending = $state(false);
	let message = $state<string | null>(null);

	/** One sentence a person at a counter can act on, per status T-18 returns. */
	function explain(status: number, retryAfterSeconds: number | null): string {
		switch (status) {
			case 403:
				return 'That email and password did not sign in as this restaurant’s owner.';
			case 409:
				return 'A till is already registered for this restaurant. Revoke it from the POS page of the dashboard first, then register this device.';
			case 429:
				return retryAfterSeconds
					? `Too many attempts. Wait ${Math.ceil(retryAfterSeconds / 60)} minute(s), then try again.`
					: 'Too many attempts. Wait a few minutes, then try again.';
			case 400:
				return 'Enter the owner’s email and password, and a name for this device.';
			default:
				return 'This device could not be registered. Try again.';
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (pending) return;
		pending = true;
		message = null;
		try {
			const response = await fetch('/api/pos/register', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email, password, label })
			});
			if (response.ok) {
				await goto(resolve('/pos'));
				return;
			}
			const retryAfter = Number(response.headers.get('retry-after'));
			message = explain(response.status, retryAfter > 0 ? retryAfter : null);
		} catch {
			message = 'No connection. Registering a till needs the internet — try again once online.';
		} finally {
			password = '';
			pending = false;
		}
	}

	// POS touch floors and tokens only. `Button` from $lib/components/ui is a
	// dashboard control on Tailwind's default spacing and must never take the POS
	// touch tokens, so the key is written here. A disabled control changes its FILL
	// and INK tokens and keeps its border — never `opacity`, which composites fill
	// and ink together and defeats every contrast pair tokens.css audits.
	const field =
		'min-h-touch bg-raise border border-control-line rounded-control text-pos text-ink px-3';
</script>

<svelte:head>
	<title>Register this till · matcami</title>
</svelte:head>

<main class="mx-auto flex max-w-md flex-col gap-4 px-4 py-8">
	<h1 class="text-title text-ink">Register this device as the till</h1>
	<p class="text-ink-2">
		Sign in once with the restaurant owner’s email and password. After that, staff sign in here with
		their PIN.
	</p>

	<form class="flex flex-col gap-2" onsubmit={submit}>
		<label for="register-email" class="text-ink">Owner email</label>
		<input
			id="register-email"
			type="email"
			autocomplete="username"
			inputmode="email"
			required
			bind:value={email}
			class={field}
		/>

		<label for="register-password" class="text-ink">Owner password</label>
		<input
			id="register-password"
			type="password"
			autocomplete="current-password"
			required
			bind:value={password}
			class={field}
		/>

		<label for="register-label" class="text-ink">Name for this device</label>
		<input
			id="register-label"
			type="text"
			required
			maxlength="60"
			placeholder="Counter tablet"
			bind:value={label}
			class={field}
		/>

		<!-- Said BEFORE the owner submits, in the form itself: an owner who discovers it
		     afterwards assumes the app broke. -->
		<p class="text-ink-2">
			Registering this device signs you out of the dashboard here. Use another computer for the
			dashboard — this tablet becomes the till.
		</p>

		{#if message}
			<p role="alert" class="bg-danger-bg text-danger rounded-control px-3 py-2">
				<span aria-hidden="true" class="font-mono">✕</span>
				{message}
			</p>
		{/if}

		<button
			type="submit"
			disabled={pending}
			class={`min-h-touch-lg border-control-line rounded-control text-pos border font-semibold ${
				pending ? 'bg-disabled-bg text-disabled-ink' : 'bg-accent text-accent-ink'
			}`}
		>
			{pending ? 'Registering…' : 'Register this device'}
		</button>
	</form>
</main>
