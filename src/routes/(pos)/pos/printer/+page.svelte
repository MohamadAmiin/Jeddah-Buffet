<script lang="ts">
	// /pos/printer — pair this till with the local print agent (spec 11;
	// menu-and-printing T-29). OWNER-ONLY, enforced HERE on the device: printing
	// exists nowhere else, so there is no server route to guard. Anyone else who
	// lands here reads why, rather than being bounced (a disabled thing says why).
	//
	// NOTHING IS TYPED HERE. "Pair this till" asks the agent on this PC for the
	// pairing secret, which it hands over once while its pairing is open (the
	// agent's `init` and `pair` open it; the first till to ask closes it). The other way in is
	// the agent's `link`: a link to this page with the agent address and the
	// secret in the FRAGMENT, which no server ever sees; opening it pairs the till
	// and the fragment is dropped from the address bar at once. Either way the
	// pairing lands in IndexedDB (invariant 12). A link opened before the owner
	// has signed in waits in memory (stashPairing) and the PIN page brings the
	// owner back here. The first call to the agent is made HERE
	// and not in the sale flow: Chrome 142+ asks for "local network access" on
	// the first call to 127.0.0.1, and that prompt belongs in setup, not in the
	// middle of a rush (RESEARCH.md).
	import { getContext, onMount } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';
	import {
		agentStatus,
		clearAgentSettings,
		DEFAULT_AGENT_URL,
		parsePairingFragment,
		printerChip,
		readAgentSettings,
		requestPairing,
		saveAgentSettings,
		stashPairing,
		submitJob,
		takePairing,
		type AgentSettings,
		type AgentState,
		type PairingRefusal,
		type SubmitResult
	} from '$lib/pos/print-client';
	import { renderTestPage } from '$lib/pos/receipt';
	import { readCachedSetting } from '$lib/pos/store';
	import { KEY } from '$lib/components/pos/keys';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let ready = $state(false);
	let isOwner = $state(false);
	let url = $state(DEFAULT_AGENT_URL);
	let paired = $state(false);
	let status = $state<AgentState | null>(null);
	let busy = $state(false);
	let failure = $state('');
	let results = $state<string[]>([]);
	let restaurantName = $state('Restaurant');
	let deviceCode = $state('');
	let timeZone = $state('UTC');

	const chip = $derived(status === null ? null : printerChip(status));

	onMount(() => {
		// Read the link BEFORE anything can navigate away from it.
		const fromLink = parsePairingFragment(location.hash);
		if (fromLink) stashPairing(fromLink);
		void (async () => {
			await restored;
			if (!signedIn.current) {
				// replaceState: the link and its secret must not stay one Back press away.
				void goto(resolve('/pos'), { replaceState: fromLink !== null });
				return;
			}
			if (fromLink) dropFragment();
			isOwner = signedIn.current.isOwner;
			if (isOwner) {
				const [saved, name, code, zone] = await Promise.all([
					readAgentSettings().catch(() => null),
					readCachedSetting('restaurantName').catch(() => null),
					readCachedSetting('deviceCode').catch(() => null),
					readCachedSetting('timeZone').catch(() => null)
				]);
				if (saved) {
					url = saved.url;
					paired = true;
				}
				if (typeof name === 'string') restaurantName = name;
				if (typeof code === 'string') deviceCode = code;
				if (typeof zone === 'string') timeZone = zone;
				// A cashier's screen leaves the link waiting; only the owner's takes it.
				const pending = takePairing();
				if (pending) await pair(pending);
				else status = await agentStatus();
			}
			ready = true;
			// A link pasted while the lines above were still loading.
			if (isOwner) await pairFromStash();
		})();
	});

	function dropFragment() {
		try {
			replaceState(resolve('/pos/printer'), {});
		} catch {
			// The router had not started; the fragment goes with the next navigation.
		}
	}

	async function pairFromStash() {
		const pending = takePairing();
		if (!pending || busy) return;
		busy = true;
		failure = '';
		results = [];
		try {
			await pair(pending);
		} finally {
			busy = false;
		}
	}

	// The link pasted into THIS tab while this screen is open differs from the
	// current address only after the #, so the browser neither reloads nor
	// remounts — it fires hashchange, and onMount never sees the link.
	function onHashChange() {
		const fromLink = parsePairingFragment(location.hash);
		if (!fromLink) return;
		stashPairing(fromLink);
		dropFragment();
		if (ready && isOwner) void pairFromStash();
	}

	function announceChange() {
		// The layout's chip re-polls on this (it also polls every 30 s).
		dispatchEvent(new Event('matcami:printer-changed'));
	}

	function explain(state: AgentState): string {
		switch (state.state) {
			case 'ready':
				return '● The agent answered';
			case 'unauthorized':
				return '✕ Printer pairing is wrong — the agent was set up again after this till was paired, or for another address (init --origin). Forget the pairing, then pair again';
			case 'blocked':
				return "✕ Printing blocked by Chrome — open Chrome's site settings for this address and allow local network access, then try again";
			case 'unreachable':
				return `◆ Printer unreachable — nothing answered at ${url}. Is the agent running on this PC?`;
			case 'not_set_up':
				return '○ Printer not set up';
		}
	}

	function describe(role: 'receipt' | 'kitchen', result: SubmitResult): string {
		if (result === 'queued' || result === 'duplicate') {
			return `● Test page sent to the ${role} printer`;
		}
		if (result.error === 'blocked') {
			return "✕ Printing blocked by Chrome — open Chrome's site settings for this address and allow local network access";
		}
		if (result.error === 'unreachable') return `◆ The agent did not answer at ${url}`;
		if (result.error === 'http_401' || result.error === 'http_403') {
			return '✕ Printer pairing is wrong — pair again';
		}
		return `✕ The agent refused the ${role} test page (${result.error})`;
	}

	async function pair(settings: AgentSettings) {
		try {
			await saveAgentSettings(settings);
			url = settings.url;
			paired = true;
			announceChange();
			status = await agentStatus();
			results = [status.state === 'ready' ? `● Paired with the agent at ${url}` : explain(status)];
		} catch (err) {
			failure = `✕ ${err instanceof Error ? err.message : 'The pairing could not be saved'}`;
			status = await agentStatus();
		}
	}

	function explainRefusal(reason: PairingRefusal): string {
		switch (reason) {
			case 'closed':
				return '○ Pairing is closed on the agent. On this PC run: node print-agent/src/main.ts pair — then press Pair this till again';
			case 'claimed':
				return '✕ Pairing was already used. On this PC run: node print-agent/src/main.ts pair — then press Pair this till again. If you did not pair a till since the agent was set up, something else on this PC took the pairing: run init --force instead';
			case 'blocked':
				return "✕ Pairing blocked by Chrome — open Chrome's site settings for this address and allow local network access, then try again";
			case 'unreachable':
				return `◆ Nothing answered at ${url}. Is the agent running on this PC, and was it set up for this address (init --origin)?`;
			case 'refused':
				return '✕ The agent refused to pair this till';
		}
	}

	/** "Pair this till": ask the agent on this PC for the pairing, then keep it. */
	async function pairHere() {
		if (busy) return;
		busy = true;
		failure = '';
		results = [];
		try {
			const outcome = await requestPairing(url);
			if (outcome.ok) await pair(outcome.settings);
			else results = [explainRefusal(outcome.reason)];
		} catch {
			failure = '✕ The pairing could not be completed — try again';
		} finally {
			busy = false;
		}
	}

	async function testPrint() {
		if (busy || !paired) return;
		busy = true;
		failure = '';
		results = [];
		try {
			status = await agentStatus();
			if (status.state !== 'ready') {
				results = [explain(status)];
				return;
			}
			const printers = status.status.printers;
			const now = new Date().toISOString();
			const base = { restaurantName, deviceCode, now, timeZone };
			const receipt = await submitJob({
				id: `test:${crypto.randomUUID()}`,
				printer: 'receipt',
				lines: renderTestPage({ ...base, width: printers.receipt.width, printer: 'receipt' }),
				cut: true
			});
			results = [describe('receipt', receipt)];
			if (printers.kitchen) {
				const kitchen = await submitJob({
					id: `test:${crypto.randomUUID()}`,
					printer: 'kitchen',
					lines: renderTestPage({ ...base, width: printers.kitchen.width, printer: 'kitchen' }),
					cut: true
				});
				results = [...results, describe('kitchen', kitchen)];
			}
		} catch (err) {
			failure = `✕ ${err instanceof Error ? err.message : 'The test page could not be sent'}`;
		} finally {
			busy = false;
		}
	}

	async function forget() {
		if (busy) return;
		busy = true;
		failure = '';
		results = [];
		try {
			await clearAgentSettings();
			paired = false;
			// `url` stays: "Pair this till" asks the agent this till just left, which
			// matters when the agent is not on the default port.
			announceChange();
			status = await agentStatus();
		} catch {
			failure = '✕ The pairing could not be removed — try again';
		} finally {
			busy = false;
		}
	}

	// The till's own key classes (keys.ts). A disabled key takes the disabled PAIR,
	// never opacity (docs/redesign Phase 8).
	const primary =
		'min-h-touch-xl w-full border border-control-line rounded-control bg-accent text-accent-ink font-semibold text-pos disabled:bg-disabled-bg disabled:text-disabled-ink';
	const secondary = `min-h-touch-lg px-4 ${KEY}`;
</script>

<svelte:head><title>Printer · matcami</title></svelte:head>
<svelte:window onhashchange={onHashChange} />

<main class="relative flex min-h-0 flex-1 overflow-y-auto p-3 md:p-4 lg:p-6">
	<div class="m-auto flex w-full max-w-2xl flex-col gap-4">
		{#if !ready}
			<p class="text-ink-2">Loading…</p>
		{:else if !isOwner}
			<h2 class="text-title text-ink">Printer</h2>
			<p class="bg-raise-2 text-ink-2 rounded-control px-3 py-2">
				Only the owner can set up the printer.
			</p>
			<a
				class="min-h-touch-lg inline-flex items-center justify-center px-4 {KEY}"
				href={resolve('/pos/order')}>Back to the till</a
			>
		{:else}
			<h2 class="text-title text-ink">Printer</h2>
			{#if chip !== null}
				<p
					data-testid="printer-state"
					class="rounded-control px-3 py-2 font-semibold {chip.tone === 'ok'
						? 'bg-ok-bg text-ok'
						: chip.tone === 'offline'
							? 'bg-st-offline-bg text-st-offline'
							: chip.tone === 'danger'
								? 'bg-danger-bg text-danger'
								: 'bg-raise-2 text-ink-2'}"
				>
					<span aria-hidden="true" class="font-mono">{chip.glyph}</span>
					{chip.text}
				</p>
			{/if}
			<p class="text-ink-2">
				The print agent runs on this PC and owns the printers and the cash drawer.
			</p>
			{#if paired}
				<p class="text-ink-2" data-testid="paired-agent">
					Paired with the agent at <span class="font-mono">{url}</span>.
				</p>
				<button
					type="button"
					class={primary}
					disabled={busy}
					data-testid="test-print"
					onclick={() => void testPrint()}
				>
					{busy ? 'Working…' : 'Test print'}
				</button>
			{:else}
				<p class="bg-raise-2 text-ink-2 rounded-control px-3 py-2" data-testid="pairing-help">
					This till is not paired yet. <strong>Pair this till</strong> asks the agent at
					<span class="font-mono">{url}</span>. Setting the agent up opens pairing for the first
					till that asks; if it says pairing is closed, run
					<code class="font-mono">node print-agent/src/main.ts pair</code> on this PC first. Nothing is
					typed here.
				</p>
				<button
					type="button"
					class={primary}
					disabled={busy}
					data-testid="pair-here"
					onclick={() => void pairHere()}
				>
					{busy ? 'Working…' : 'Pair this till'}
				</button>
			{/if}

			{#if failure}
				<p class="bg-danger-bg text-danger rounded-control px-3 py-2" role="alert">{failure}</p>
			{/if}
			{#if results.length > 0}
				<ul class="flex flex-col gap-2" aria-live="polite" data-testid="test-results">
					{#each results as line (line)}
						<li
							class="rounded-control px-3 py-2 {line.startsWith('●')
								? 'bg-ok-bg text-ok'
								: line.startsWith('◆')
									? 'bg-st-offline-bg text-st-offline'
									: line.startsWith('✕')
										? 'bg-danger-bg text-danger'
										: 'bg-raise-2 text-ink-2'}"
						>
							{line}
						</li>
					{/each}
				</ul>
			{/if}

			{#if paired}
				<!-- Shown only while there is a pairing to forget: a key that can do nothing
				     is not offered. -->
				<div class="border-line flex flex-wrap items-center justify-between gap-3 border-t pt-4">
					<p class="text-ink-2">
						Pairing is stored on this till. Registering the till again clears it.
					</p>
					<button
						type="button"
						class={secondary}
						disabled={busy}
						data-testid="forget-pairing"
						onclick={() => void forget()}
					>
						Forget pairing
					</button>
				</div>
			{/if}
		{/if}
	</div>
</main>
