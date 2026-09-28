<script lang="ts">
	// T-32: /pos/session — open with a float, close with a count.
	//
	// Spec 10: opening cash → sales → count → reconciliation. The screen is
	// two conditional forms on ONE URL: OPEN when no local session, CLOSE when
	// one is open, DONE after closeSession lands. Money in cents: the input is
	// dollars/cents and the parser turns it into a bigint minor amount (never a
	// float outside src/lib/money).

	import { onMount, getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { readBoundDeviceId, countUnsynced, type LocalSession } from '$lib/pos/store';
	import { closeLocalSession, openLocalSession, readLocalSession } from '$lib/pos/session';
	import { flush } from '$lib/pos/queue';
	import { RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';

	// Wait for the layout's restore gate before the sign-in guard runs.
	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let deviceId = $state<string | null>(null);
	let session = $state<LocalSession | null>(null);
	let openingCash = $state('');
	let countedCash = $state('');
	let message = $state('');
	let submitting = $state(false);
	let unsynced = $state<number | null>(null);

	function toMinor(text: string): bigint | null {
		const trimmed = text.trim();
		if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
		const [dollars, cents = ''] = trimmed.split('.');
		const padded = (cents + '00').slice(0, 2);
		return BigInt(dollars) * 100n + BigInt(padded);
	}

	async function refresh() {
		try {
			const id = await readBoundDeviceId();
			deviceId = id;
			session = id ? await readLocalSession(id) : null;
			unsynced = await countUnsynced();
		} catch {
			session = null;
			unsynced = null;
		}
	}

	onMount(async () => {
		await restored;
		if (!signedIn.current) {
			void goto(resolve('/pos'));
			return;
		}
		await refresh();
	});

	async function open() {
		if (!deviceId || !signedIn.current) return;
		message = '';
		const cash = toMinor(openingCash);
		if (cash === null) {
			message = 'Enter the drawer count as dollars and cents, e.g. 50.00';
			return;
		}
		submitting = true;
		try {
			await openLocalSession({
				deviceId,
				employeeId: signedIn.current.id,
				openingCashMinor: cash,
				now: new Date()
			});
			void flush().catch(() => {});
			void goto(resolve('/pos/order'));
		} catch (err) {
			message = err instanceof Error ? err.message : 'Could not open the session.';
		} finally {
			submitting = false;
		}
	}

	async function close() {
		if (!deviceId || !signedIn.current) return;
		message = '';
		if ((unsynced ?? 0) > 0) {
			message = 'There is unsynced work. Wait for the queue to drain before closing.';
			return;
		}
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			message = 'Session close needs a connection so the server can reconcile.';
			return;
		}
		const cash = toMinor(countedCash);
		if (cash === null) {
			message = 'Enter the drawer count as dollars and cents.';
			return;
		}
		submitting = true;
		try {
			await closeLocalSession({
				deviceId,
				employeeId: signedIn.current.id,
				countedCashMinor: cash,
				now: new Date()
			});
			void flush().catch(() => {});
			void goto(resolve('/pos'));
		} catch (err) {
			message = err instanceof Error ? err.message : 'Could not close the session.';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto flex max-w-lg flex-col gap-5 p-6">
	<h2 class="text-ink text-xl font-semibold">POS session</h2>
	{#if !signedIn.current}
		<p class="text-ink-2">Signing you back in…</p>
	{:else if session === null}
		<p class="text-ink-2">
			Count the drawer, then open the session. Every sale in this shift belongs to its business
			date.
		</p>
		<label class="flex flex-col gap-1">
			<span class="text-ink font-semibold">Opening cash (dollars)</span>
			<input
				type="text"
				inputmode="decimal"
				bind:value={openingCash}
				class="border-control-line rounded-md border p-2 font-mono"
				placeholder="50.00"
			/>
		</label>
		{#if message}<p class="text-danger">{message}</p>{/if}
		<button
			type="button"
			class="bg-accent text-ink rounded-md p-3 font-semibold"
			onclick={open}
			disabled={submitting}
		>
			{submitting ? 'Opening…' : 'Open session'}
		</button>
	{:else if session.state === 'closing'}
		<p class="text-ink-2">Closing the session with the server…</p>
	{:else}
		<p class="text-ink-2">
			Session {session.businessDate ?? '(pending sync)'} · opening {session.openingCashMinor} cents.
		</p>
		<label class="flex flex-col gap-1">
			<span class="text-ink font-semibold">Counted cash (dollars)</span>
			<input
				type="text"
				inputmode="decimal"
				bind:value={countedCash}
				class="border-control-line rounded-md border p-2 font-mono"
				placeholder="50.00"
			/>
		</label>
		{#if message}<p class="text-danger">{message}</p>{/if}
		<button
			type="button"
			class="bg-accent text-ink rounded-md p-3 font-semibold"
			onclick={close}
			disabled={submitting}
		>
			{submitting ? 'Closing…' : 'Close session'}
		</button>
		<a class="text-ink-2 text-center underline" href={resolve('/pos/order')}>Back to orders</a>
	{/if}
</div>
