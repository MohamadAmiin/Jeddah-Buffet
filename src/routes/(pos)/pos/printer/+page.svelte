<script lang="ts">
	// /pos/printer — pair this till with the local print agent (spec 11;
	// menu-and-printing T-29). OWNER-ONLY, enforced HERE on the device: printing
	// exists nowhere else, so there is no server route to guard. Anyone else who
	// lands here reads why, rather than being bounced (a disabled thing says why).
	//
	// The pairing token is typed once and stored in IndexedDB (invariant 12); the
	// field is cleared after a save so the secret does not sit on screen. The
	// TEST PRINT is deliberately here and not in the sale flow: Chrome 142+ asks
	// for "local network access" on the first call to 127.0.0.1, and that prompt
	// belongs in setup, not in the middle of a rush (RESEARCH.md).
	import { getContext, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { RESTORED_CONTEXT, signedIn } from '$lib/pos/employee.svelte';
	import {
		agentStatus,
		clearAgentSettings,
		DEFAULT_AGENT_URL,
		printerChip,
		readAgentSettings,
		saveAgentSettings,
		submitJob,
		type AgentState,
		type SubmitResult
	} from '$lib/pos/print-client';
	import { renderTestPage } from '$lib/pos/receipt';
	import { readCachedSetting } from '$lib/pos/store';

	const restored = getContext<Promise<void>>(RESTORED_CONTEXT) ?? Promise.resolve();

	let ready = $state(false);
	let isOwner = $state(false);
	let url = $state(DEFAULT_AGENT_URL);
	let token = $state('');
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
		void (async () => {
			await restored;
			if (!signedIn.current) {
				void goto(resolve('/pos'));
				return;
			}
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
				status = await agentStatus();
			}
			ready = true;
		})();
	});

	function announceChange() {
		// The layout's chip re-polls on this (it also polls every 30 s).
		dispatchEvent(new Event('matcami:printer-changed'));
	}

	function explain(state: AgentState): string {
		switch (state.state) {
			case 'ready':
				return '● The agent answered';
			case 'unauthorized':
				return '✕ Printer pairing is wrong — the token does not match this agent, or the agent was set up for another address (init --origin)';
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

	async function saveAndTest() {
		if (busy) return;
		busy = true;
		failure = '';
		results = [];
		try {
			const typed = token.trim();
			if (typed !== '' || !paired) {
				await saveAgentSettings({ url: url.trim(), token: typed });
				paired = true;
				token = '';
				url = url.trim();
				announceChange();
			}
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
			failure = `✕ ${err instanceof Error ? err.message : 'The pairing could not be saved'}`;
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
			token = '';
			url = DEFAULT_AGENT_URL;
			announceChange();
			status = await agentStatus();
		} catch {
			failure = '✕ The pairing could not be removed — try again';
		} finally {
			busy = false;
		}
	}

	const field =
		'min-h-touch border border-control-line rounded-control bg-raise text-ink w-full px-4 font-mono';
	const primary =
		'min-h-touch-xl w-full border border-control-line rounded-control bg-accent text-accent-ink font-semibold text-pos disabled:opacity-60';
	const secondary =
		'min-h-touch-lg border border-control-line rounded-control bg-raise text-ink px-4 font-semibold disabled:opacity-60';
</script>

<svelte:head><title>Printer · matcami</title></svelte:head>

<main class="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
	{#if !ready}
		<p class="text-ink-2">Loading…</p>
	{:else if !isOwner}
		<h2 class="text-title text-ink">Printer</h2>
		<p class="bg-raise-2 text-ink-2 rounded-control px-3 py-2">
			Only the owner can set up the printer.
		</p>
		<a
			class="min-h-touch-lg border-control-line rounded-control bg-raise text-ink inline-flex items-center justify-center border px-4 font-semibold"
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
			The print agent runs on this PC and owns the printers and the cash drawer. Run
			<code class="font-mono">init</code> there, then enter the address and token it printed.
		</p>

		<form
			class="flex flex-col gap-4"
			onsubmit={(event) => {
				event.preventDefault();
				void saveAndTest();
			}}
		>
			<label class="flex flex-col gap-1">
				<span class="font-semibold">Agent address</span>
				<input
					class={field}
					type="url"
					name="agentUrl"
					bind:value={url}
					autocomplete="off"
					spellcheck="false"
					inputmode="url"
				/>
				<span class="text-caption text-ink-2"
					>http://127.0.0.1:9471 unless the agent's port was changed</span
				>
			</label>
			<label class="flex flex-col gap-1">
				<span class="font-semibold">Pairing token</span>
				<input
					class={field}
					type="password"
					name="agentToken"
					bind:value={token}
					autocomplete="off"
					spellcheck="false"
					placeholder={paired
						? 'Paired — leave blank to keep the saved token'
						: '64 characters from init'}
				/>
			</label>
			<button type="submit" class={primary} disabled={busy} data-testid="save-and-test">
				{busy ? 'Working…' : paired && token.trim() === '' ? 'Test print' : 'Save and test print'}
			</button>
		</form>

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

		<div class="border-line flex flex-wrap items-center justify-between gap-3 border-t pt-4">
			<p class="text-ink-2">
				Pairing is stored on this till. Registering the till again clears it.
			</p>
			<button
				type="button"
				class={secondary}
				disabled={busy || !paired}
				onclick={() => void forget()}
			>
				Forget pairing
			</button>
		</div>
	{/if}
</main>
