<script lang="ts">
	// PIN ENTRY — /pos/pin?employee=<id> (spec 7: 4–6 digit PINs; five wrong
	// attempts lock the employee for five minutes; the POS returns to employee
	// select after an idle period).
	//
	// THE SERVER OWNS THE COUNTER; THIS SCREEN RENDERS IT. Attempts are never counted
	// here as the source of truth — a reload would reset such a count, which is the
	// exact bypass the server-side counter exists to close.
	//
	// Laid out as docs/redesign Phase 4 asks: who the PIN is for on the left, the
	// keypad card on the right ending in Sign in, always on screen.
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
	import { createIdleWatch, type IdleWatch } from '$lib/pos/idle';
	import {
		POS_PIN_FAILED,
		POS_PIN_SUCCESS,
		type CachedEmployee,
		forgetDevice,
		readBoundDeviceId,
		readCachedEmployees,
		readCachedIdleSeconds,
		recordOfflineLogin,
		verifyCachedPin
	} from '$lib/pos/store';
	import { signIn, type SignedInEmployee } from '$lib/pos/employee.svelte';
	import { readLocalSession } from '$lib/pos/session';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Keypad, { type KeypadKey } from '$lib/components/pos/Keypad.svelte';
	import TillBanner from '$lib/components/pos/TillBanner.svelte';
	import { KEY } from '$lib/components/pos/keys';

	async function handOff(employee: SignedInEmployee) {
		signIn(employee);
		signedIn = { displayName: employee.displayName, roleName: employee.roleName };
		let inSession = false;
		try {
			const deviceId = await readBoundDeviceId();
			if (deviceId) {
				const session = await readLocalSession(deviceId);
				inSession = session !== null;
			}
		} catch {
			inSession = false;
		}
		void goto(resolve(inSession ? '/pos/order' : '/pos/session'));
	}

	// An employee id is not a secret — it is already on the employee-select list.
	const employeeId = $derived(page.url.searchParams.get('employee'));

	let digits = $state('');
	let pending = $state(false);
	let message = $state<string | null>(null);
	let notRegistered = $state(false);
	let signedIn = $state<{ displayName: string; roleName: string } | null>(null);

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
	// number written here. It reaches the till through GET /api/pos/employees, which
	// the employee-select screen caches in IndexedDB, and is read back ONCE after
	// mount. `null` — the owner has set no value, or nothing is cached yet — is the
	// watch's defined INERT case, and the screen says so.
	let idleSeconds = $state<number | null>(null);
	let idleRead = $state(false);

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

	// The offline sign-in: the SAME isomorphic verifyPin the server calls, against
	// the hash cached on this device. EVERY attempt against a cached employee with a
	// PIN is recorded locally under THIS attempt's clientOpId — a success AND a
	// wrong PIN, because invariant 10 names failed PINs and the only offline
	// exception it grants is timing (recorded locally, synced later), never leaving
	// the record out. The server writes pos.pin.failed for every wrong PIN online;
	// offline, this is that row. A retry of the same attempt is a no-op in the store.
	async function signInOffline(id: string, pin: string, clientOpId: string) {
		let cached: CachedEmployee | undefined;
		let verified = false;
		// The device the cache belongs to: every offline record is stamped with it.
		let deviceId: string | null = null;
		try {
			deviceId = await readBoundDeviceId();
			cached = (await readCachedEmployees()).find((e) => e.id === id);
			if (cached && cached.pinPhc !== null) verified = await verifyCachedPin(id, pin);
		} catch {
			message = 'No connection, and this device cannot check a PIN offline.';
			return;
		}
		if (deviceId === null) {
			// A cache with no device bound to it was never filled by this device's own
			// directory fetch: nothing here may be trusted or recorded.
			message = 'No connection, and this device cannot check a PIN offline.';
			return;
		}
		if (!cached || cached.pinPhc === null) {
			// No employee to attempt against — nothing was checked, so nothing to record.
			message = 'That PIN is not right. Try again.';
			return;
		}

		const outcome = verified ? 'success' : 'failed';
		let recorded = true;
		try {
			await recordOfflineLogin({
				clientOpId,
				deviceId,
				employeeId: id,
				event: verified ? POS_PIN_SUCCESS : POS_PIN_FAILED,
				occurredAt: new Date().toISOString(),
				outcome,
				synced: false
			});
		} catch {
			recorded = false;
		}

		if (!verified) {
			message = recorded
				? 'That PIN is not right. Try again.'
				: 'That PIN is not right, and this device could not record the attempt.';
			return;
		}
		if (!recorded) {
			// An offline sign-in that cannot be recorded does not happen: invariant 10
			// needs the record, and there is nowhere else to keep it.
			message = 'No connection, and this device could not record the sign-in.';
			return;
		}
		await handOff({
			id: cached.id,
			displayName: cached.displayName,
			isOwner: cached.isOwner,
			roleName: cached.roleName,
			permissions: cached.permissions
		});
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
				// NO NETWORK — both tries threw, so no server has answered this attempt.
				// Only now may the PIN hash cached on this device decide (spec 6). A
				// server ANSWER never reaches this branch: re-checking a 401 or a 423
				// against the cache would be an unlimited-guesses bypass of the server's
				// five-attempts lockout.
				await signInOffline(employeeId, digits, clientOpId);
				return;
			}

			if (response.status === 200) {
				const body = (await response.json()) as {
					employeeId: string;
					displayName: string;
					isOwner: boolean;
					roleName: string;
				};
				let permissions: string[] = [];
				try {
					const cached = (await readCachedEmployees()).find((e) => e.id === body.employeeId);
					if (cached) permissions = cached.permissions;
				} catch {
					permissions = [];
				}
				await handOff({
					id: body.employeeId,
					displayName: body.displayName,
					isOwner: body.isOwner,
					roleName: body.roleName,
					permissions
				});
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
				// Unknown or REVOKED: forget the cached bundle, so this till cannot sign
				// anyone in offline from the PIN hashes it still holds.
				try {
					await forgetDevice();
				} catch {
					// No readable cache: there is nothing to forget.
				}
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

		// Read the cached idle lock once, then arm the watch with whatever came back,
		// null included — null is the watch's inert case, not an error to retry.
		let watch: IdleWatch | undefined;
		let disposed = false;
		void (async () => {
			let seconds: number | null = null;
			try {
				seconds = await readCachedIdleSeconds();
			} catch {
				// No readable cache: the same inert null, and the screen says so.
			}
			if (disposed) return;
			idleSeconds = seconds;
			idleRead = true;
			watch = createIdleWatch({
				seconds,
				onIdle: () => {
					digits = '';
					void goto(resolve('/pos'));
				}
			});
		})();
		const poke = () => watch?.poke();
		addEventListener('pointerdown', poke);
		addEventListener('keydown', poke);

		return () => {
			disposed = true;
			removeEventListener('pointerdown', poke);
			removeEventListener('keydown', poke);
			watch?.stop();
			digits = '';
		};
	});

	onDestroy(() => {
		stopTicker();
		digits = '';
	});

	// Who the PIN is for, from the cached employee list (the same list the
	// employee-select screen shows). Read once after mount.
	let who = $state<{ name: string; role: string } | null>(null);
	$effect(() => {
		const id = employeeId;
		if (!id) return;
		void readCachedEmployees()
			.then((all) => {
				const found = all.find((e) => e.id === id);
				who = found
					? { name: found.displayName, role: found.isOwner ? 'Owner' : found.roleName }
					: null;
			})
			.catch(() => (who = null));
	});
	const initials = $derived(
		who === null
			? ''
			: who.name
					.split(/\s+/)
					.filter(Boolean)
					.slice(0, 2)
					.map((word) => word.charAt(0).toUpperCase())
					.join('')
	);
	const firstName = $derived(who === null ? null : (who.name.split(/\s+/)[0] ?? who.name));
	const keysDisabled = $derived(locked || pending);
	const signInDisabled = $derived(locked || pending || digits.length < PIN_MIN_DIGITS);

	function onkey(key: KeypadKey) {
		if (key === 'back') backspace();
		else if (key === 'clear') clear();
		else press(key);
	}
</script>

<svelte:head>
	<title>Enter your PIN · matcami</title>
</svelte:head>

<!-- A two-column screen, vertically centred, that always fits. Below md the columns
     stack and Sign in sits under the keypad, never above it. -->
<main class="relative flex min-h-0 flex-1 overflow-y-auto p-3 md:p-4 lg:p-6">
	{#if signedIn}
		<!-- Shown only for the instant between signIn and the hand-off landing. -->
		<h1 class="text-title text-ink m-auto">
			Signed in as {signedIn.displayName} ({signedIn.roleName})
		</h1>
	{:else if employeeId}
		<div class="m-auto grid w-full max-w-4xl items-center gap-8 md:grid-cols-2 lg:gap-12">
			<div class="flex flex-col gap-5">
				<div class="flex items-center gap-4">
					{#if who}
						<span
							aria-hidden="true"
							class="bg-accent font-display text-title text-accent-ink grid size-16 shrink-0 place-items-center rounded-full"
							>{initials}</span
						>
					{/if}
					<div class="flex min-w-0 flex-col">
						<h1 class="text-title">
							{who ? `Enter the PIN for ${who.name}` : 'Enter the PIN'}
						</h1>
						{#if who}<p class="text-body text-ink-2">{who.role}</p>{/if}
					</div>
				</div>

				<!-- The digits are never shown: six drawn slots (the last two, optional,
				     dashed while empty) and a count for a screen reader. -->
				<div aria-hidden="true" class="flex items-center gap-3">
					{#each [0, 1, 2, 3, 4, 5] as slot (slot)}
						<span
							class="size-5 rounded-full border-2 {slot < digits.length
								? 'border-ink bg-ink'
								: slot >= PIN_MIN_DIGITS
									? 'border-control-line border-dashed'
									: 'border-control-line'}"
						></span>
					{/each}
				</div>
				<p aria-live="polite" class="sr-only">{digits.length} digits entered</p>

				<!-- One message line with a reserved height, so nothing below it moves. -->
				<div id="pin-hint" class="min-h-12">
					{#if locked}
						<TillBanner tone="danger" live="alert"
							>Locked after 5 wrong attempts. Try again in {countdown}.</TillBanner
						>
					{:else if message}
						<TillBanner tone="danger" live="alert">
							{message}
							{#if notRegistered}
								<a href={resolve('/pos/register')} class="text-danger underline"
									>Register it again</a
								>
							{/if}
						</TillBanner>
					{:else if pending}
						<p class="text-body text-ink-2">Checking the PIN…</p>
					{:else if digits.length < PIN_MIN_DIGITS}
						<p class="text-body text-ink-2">Enter at least {PIN_MIN_DIGITS} digits</p>
					{/if}
				</div>

				<a href={resolve('/pos')} class="min-h-touch-min flex w-fit items-center gap-2 px-4 {KEY}">
					<Icon name="arrow-left" class="size-5" />
					{firstName ? `Not ${firstName}? Choose your name` : 'Choose your name'}
				</a>

				{#if idleRead && idleSeconds === null}
					<p class="text-body text-ink-2">
						Automatic return to employee select is not configured yet.
					</p>
				{/if}
			</div>

			<section
				aria-label="PIN keypad"
				class="rounded-card border-line bg-raise shadow-raised flex flex-col gap-3 border p-4"
			>
				<Keypad label="PIN keypad" disabled={keysDisabled} reason="pin-hint" {onkey} />
				<button
					type="button"
					disabled={signInDisabled}
					aria-describedby={signInDisabled ? 'pin-hint' : undefined}
					onclick={submit}
					class="min-h-touch-lg rounded-control border-control-line w-full border font-semibold {signInDisabled
						? 'bg-disabled-bg text-disabled-ink'
						: 'bg-accent text-accent-ink'}">Sign in</button
				>
			</section>
		</div>
	{:else}
		<p class="text-ink-2 m-auto">No employee selected.</p>
	{/if}
</main>
