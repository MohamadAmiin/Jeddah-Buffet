<script lang="ts">
	// PIN ENTRY — /pos/pin?employee=<id> (spec 7: 4–6 digit PINs; five wrong
	// attempts lock the employee for five minutes; the POS returns to employee
	// select after an idle period).
	//
	// THE SERVER OWNS THE COUNTER; THIS SCREEN RENDERS IT. Attempts are never counted
	// here as the source of truth — a reload would reset such a count, which is the
	// exact bypass the server-side counter exists to close.
	//
	// NEVER RENDER THE PIN. It is shown as dots, sent in the request BODY only (never
	// a URL, a query string or a header), never logged, and cleared from memory when
	// the attempt ends, on idle and when the page is left. It is never written to
	// localStorage, sessionStorage, IndexedDB, a store or a data attribute.
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from '$lib/pin';
	import { createIdleWatch } from '$lib/pos/idle';

	// An employee id is not a secret — it is already on the employee-select list.
	const employeeId = $derived(page.url.searchParams.get('employee'));

	let digits = $state('');
	let pending = $state(false);
	let message = $state<string | null>(null);
	let notRegistered = $state(false);
	let signedIn = $state<{ displayName: string; role: string } | null>(null);

	// The lockout countdown. The unlock moment is computed ONCE, when the 423
	// arrives, and the remaining time is always derived from it, so the countdown
	// cannot drift with the interval's own lateness.
	let unlockAt = $state<number | null>(null);
	let now = $state(Date.now());
	let ticker: ReturnType<typeof setInterval> | undefined;
	const remainingMs = $derived(unlockAt === null ? 0 : Math.max(0, unlockAt - now));
	const locked = $derived(remainingMs > 0);
	const countdown = $derived.by(() => {
		const seconds = Math.ceil(remainingMs / 1000);
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	});

	// THE IDLE TIMEOUT IS THE RESTAURANT SETTING pos_idle_lock_seconds, never a
	// number written here. It reaches the till through GET /api/pos/employees and
	// the device's IndexedDB cache — T-28 replaces this `null` with
	// readCachedIdleSeconds(). Until then, and whenever the owner has set no value,
	// `null` is the watch's defined INERT case, and the screen says so.
	const idleSeconds: number | null = null;

	function stopTicker() {
		if (ticker !== undefined) clearInterval(ticker);
		ticker = undefined;
	}

	function startLock(retryAfterMs: number) {
		stopTicker();
		now = Date.now();
		unlockAt = now + retryAfterMs;
		ticker = setInterval(() => {
			now = Date.now();
			if (unlockAt !== null && now >= unlockAt) {
				// At zero: stop ticking and give the keys back.
				stopTicker();
				unlockAt = null;
			}
		}, 1000);
	}

	function press(digit: string) {
		if (locked || pending) return;
		// Accept 4 to 6 digits: a press past the sixth is ignored.
		if (digits.length < PIN_MAX_DIGITS) digits += digit;
	}

	function backspace() {
		digits = digits.slice(0, -1);
	}

	function clear() {
		digits = '';
	}

	async function submit() {
		if (pending || locked || !employeeId || digits.length < PIN_MIN_DIGITS) return;
		// The idempotency key needs a secure context (https, or localhost). Without it
		// the attempt FAILS with a written reason — never a Math.random() stand-in,
		// which would let a retry write a second, permanent audit row.
		if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
			message = 'This device cannot sign in securely. Open the till over https.';
			digits = '';
			return;
		}
		// ONE key per attempt, generated before the first fetch and kept in this
		// function — never module scope, where the next employee would inherit it. A
		// retry of THIS attempt after a network failure reuses it, which is what makes
		// the server's replay a no-op instead of a second audit row.
		const clientOpId = crypto.randomUUID();
		pending = true;
		message = null;
		notRegistered = false;
		try {
			let response: Response | null = null;
			for (let tries = 0; tries < 2 && response === null; tries++) {
				try {
					response = await fetch('/api/pos/pin', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ employeeId, pin: digits, clientOpId })
					});
				} catch {
					// A thrown fetch is a network failure: retry once, with the SAME key.
				}
			}

			if (response === null) {
				// T-28 turns this branch into the offline fallback against the PIN hash
				// cached on this device.
				message = 'No connection. Check the network, then try again.';
				return;
			}

			if (response.status === 200) {
				const body = (await response.json()) as { displayName: string; role: string };
				signedIn = { displayName: body.displayName, role: body.role };
				return;
			}
			if (response.status === 423) {
				// retryAfterMs is a DURATION in milliseconds, not a timestamp.
				const body = (await response.json()) as { retryAfterMs: number };
				startLock(body.retryAfterMs);
				return;
			}
			if (response.status === 401) {
				// A wrong PIN and an unknown employee get the identical answer from the
				// server, deliberately; the screen does not try to tell them apart.
				message = 'That PIN is not right. Try again.';
				return;
			}
			if (response.status === 403) {
				notRegistered = true;
				message = 'This device is no longer registered as a till.';
				return;
			}
			message = 'The PIN could not be checked. Try again.';
		} finally {
			digits = '';
			pending = false;
		}
	}

	onMount(() => {
		// No employee chosen: back to the list rather than an anonymous keypad.
		if (!employeeId) {
			void goto(resolve('/pos'));
			return;
		}

		const watch = createIdleWatch({
			seconds: idleSeconds,
			onIdle: () => {
				digits = '';
				void goto(resolve('/pos'));
			}
		});
		const poke = () => watch.poke();
		addEventListener('pointerdown', poke);
		addEventListener('keydown', poke);

		return () => {
			removeEventListener('pointerdown', poke);
			removeEventListener('keydown', poke);
			watch.stop();
			digits = '';
		};
	});

	onDestroy(() => {
		stopTicker();
		digits = '';
	});

	// POS touch floors: keys are `touch-lg` (72px) square, every pressable surface
	// takes a `border-control-line` edge, and a disabled key changes its fill and
	// ink tokens and keeps that edge — never `opacity`.
	const key = (disabled: boolean) =>
		`min-h-touch-lg min-w-touch-lg border-control-line rounded-control text-title border font-mono ${
			disabled ? 'bg-disabled-bg text-disabled-ink' : 'bg-raise text-ink'
		}`;
</script>

<svelte:head>
	<title>Enter your PIN · matcami</title>
</svelte:head>

<main class="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-8">
	{#if signedIn}
		<!-- The order screen arrives with the sales plan. This plan's till can be
		     registered and signed into; it cannot sell, and no /pos/order route exists. -->
		<h1 class="text-title text-ink">Signed in as {signedIn.displayName} ({signedIn.role})</h1>
		<button
			type="button"
			onclick={() => goto(resolve('/pos'))}
			class="min-h-touch-lg bg-raise border-control-line rounded-control text-pos text-ink w-full border"
		>
			Back to employee select
		</button>
	{:else if employeeId}
		<h1 class="text-title text-ink">Enter your PIN</h1>

		<!-- The digits are never shown: one dot per digit, and a count for a screen reader. -->
		<p aria-hidden="true" class="text-title text-ink min-h-touch font-mono tracking-widest">
			{'●'.repeat(digits.length)}
		</p>
		<p aria-live="polite" class="sr-only">{digits.length} digits entered</p>

		{#if locked}
			<!-- A disabled keypad says WHY, beside the keys, rather than sitting dead. -->
			<p role="alert" class="bg-danger-bg text-danger rounded-control w-full px-3 py-2">
				<span aria-hidden="true" class="font-mono">✕</span>
				Locked after 5 wrong attempts. Try again in {countdown}.
			</p>
		{:else if message}
			<p role="alert" class="bg-danger-bg text-danger rounded-control w-full px-3 py-2">
				<span aria-hidden="true" class="font-mono">✕</span>
				{message}
				{#if notRegistered}
					<a href={resolve('/pos/register')} class="text-danger underline">Register it again</a>
				{/if}
			</p>
		{/if}

		<div class="grid grid-cols-3 gap-2">
			{#each ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as digit (digit)}
				<button
					type="button"
					disabled={locked || pending}
					onclick={() => press(digit)}
					class={key(locked || pending)}
				>
					{digit}
				</button>
			{/each}
			<button
				type="button"
				disabled={locked || pending}
				onclick={clear}
				class={`${key(locked || pending)} text-pos font-sans`}
			>
				Clear
			</button>
			<button
				type="button"
				disabled={locked || pending}
				onclick={() => press('0')}
				class={key(locked || pending)}
			>
				0
			</button>
			<button
				type="button"
				disabled={locked || pending}
				onclick={backspace}
				class={`${key(locked || pending)} text-pos font-sans`}
			>
				<span aria-hidden="true">⌫</span><span class="sr-only">Delete the last digit</span>
			</button>
		</div>

		{#if !locked && digits.length < PIN_MIN_DIGITS}
			<p class="text-ink-2">Enter at least {PIN_MIN_DIGITS} digits</p>
		{/if}

		<button
			type="button"
			disabled={locked || pending || digits.length < PIN_MIN_DIGITS}
			onclick={submit}
			class={`min-h-touch-lg border-control-line rounded-control text-pos w-full border font-semibold ${
				locked || pending || digits.length < PIN_MIN_DIGITS
					? 'bg-disabled-bg text-disabled-ink'
					: 'bg-accent text-accent-ink'
			}`}
		>
			{pending ? 'Checking…' : 'Sign in'}
		</button>

		{#if idleSeconds === null}
			<p class="text-ink-2">Automatic return to employee select is not configured yet.</p>
		{/if}
	{:else}
		<p class="text-ink-2">No employee selected.</p>
	{/if}
</main>
