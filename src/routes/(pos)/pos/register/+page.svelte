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
	import Icon from '$lib/components/ui/Icon.svelte';
	import TillBanner from '$lib/components/pos/TillBanner.svelte';
	import { TILL_FIELD } from '$lib/components/pos/keys';

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
				// The ONE 409 left: this browser already carries a live till's cookie —
				// its own restaurant's or another's. A second till for the same
				// restaurant is an ordinary registration and never answers 409.
				return 'This device is already registered as a till. To register it afresh, revoke it first from the POS page of its restaurant’s dashboard.';
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
	// touch tokens, so the field and key are the till's own (keys.ts). A disabled
	// control changes its FILL and INK tokens and keeps its border — never `opacity`.
</script>

<svelte:head>
	<title>Register this till · matcami</title>
</svelte:head>

<!-- A two-column screen, vertically centred, that always fits (docs/redesign
     Phase 4): the context on the left, the form card on the right with any error
     at its top and Register this device as its last element. -->
<main class="relative flex min-h-0 flex-1 overflow-y-auto p-3 md:p-4 lg:p-6">
	<div class="m-auto grid w-full max-w-5xl items-center gap-6 md:grid-cols-2 lg:gap-12">
		<div class="flex flex-col gap-4">
			<p class="text-eyebrow text-ink-3 uppercase">One time, on each device</p>
			<h1 class="text-display">Register this device as the till</h1>
			<p class="text-ink-2">
				Sign in once with the restaurant owner’s email and password. After that, staff sign in here
				with their PIN. Every counter device is registered this way; each becomes its own till —
				POS1, POS2, and so on — with its own invoice numbers and its own shift.
			</p>
			<!-- Said BEFORE the owner submits: an owner who discovers it afterwards
			     assumes the app broke. -->
			<p
				class="rounded-control border-line bg-raise text-ink-2 flex items-start gap-3 border px-4 py-3"
			>
				<Icon name="info" class="size-5" />
				<span
					>Registering this device signs you out of the dashboard here. Use another computer for the
					dashboard — this tablet becomes the till.</span
				>
			</p>
		</div>

		<form
			class="rounded-card border-line bg-raise shadow-raised flex flex-col gap-3 border p-4"
			onsubmit={submit}
		>
			{#if message}
				<TillBanner tone="danger" live="alert">{message}</TillBanner>
			{/if}
			<div class="flex flex-col gap-1">
				<label for="register-email" class="font-semibold">Owner email</label>
				<input
					id="register-email"
					type="email"
					autocomplete="username"
					inputmode="email"
					required
					bind:value={email}
					class={TILL_FIELD}
				/>
			</div>
			<div class="flex flex-col gap-1">
				<label for="register-password" class="font-semibold">Owner password</label>
				<input
					id="register-password"
					type="password"
					autocomplete="current-password"
					required
					bind:value={password}
					class={TILL_FIELD}
				/>
			</div>
			<div class="flex flex-col gap-1">
				<label for="register-label" class="font-semibold">Name for this device</label>
				<input
					id="register-label"
					type="text"
					required
					maxlength="60"
					placeholder="Counter tablet"
					bind:value={label}
					class={TILL_FIELD}
				/>
			</div>
			{#if pending}
				<p id="why-register" class="text-body text-ink-2">Registering this device…</p>
			{/if}
			<button
				type="submit"
				disabled={pending}
				aria-describedby={pending ? 'why-register' : undefined}
				class="min-h-touch-lg rounded-control border-control-line w-full border font-semibold {pending
					? 'bg-disabled-bg text-disabled-ink'
					: 'bg-accent text-accent-ink'}"
			>
				Register this device
			</button>
		</form>
	</div>
</main>
