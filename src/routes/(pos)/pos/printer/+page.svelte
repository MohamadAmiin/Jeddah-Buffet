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
		agentSupports,
		clearAgentSettings,
		DEFAULT_AGENT_URL,
		parsePairingFragment,
		printerChip,
		printerKeyOf,
		readAgentSettings,
		requestPairing,
		saveAgentSettings,
		savePrinters,
		stashPairing,
		submitJob,
		takePairing,
		type AgentSettings,
		type AgentState,
		type PairingRefusal,
		type SubmitResult
	} from '$lib/pos/print-client';
	import {
		addressText,
		agentSentence,
		messageFor,
		parseAddress,
		receiptChanged,
		type PrinterFields,
		type PrinterWidth
	} from '$lib/pos/printer-form';
	import { logoForAgent, logoGate } from '$lib/pos/printing';
	import { renderTestPage } from '$lib/pos/receipt';
	import {
		confirmReceiptLogo,
		readReceiptLogo,
		withdrawReceiptLogoConfirmation
	} from '$lib/pos/settings';
	import { readCachedSetting } from '$lib/pos/store';
	import { KEY, TILL_FIELD } from '$lib/components/pos/keys';
	import {
		firstRunSteps,
		guessPlatform,
		isDownloadFile,
		recommend,
		shortOsLabel,
		sizeLabel,
		type DownloadFile
	} from '$lib/print-agent-download';

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
	// THE LOGO CONFIRMATION GATE (settings-tax-payments-receipt T-24; RESEARCH.md):
	// a receipt carries the cached logo only after the owner has watched a test
	// page print it correctly and said so HERE — on a printer that does not
	// implement `GS v 0` the raster bytes are read as ordinary data, so the one
	// unconfirmed print happens on this page, in front of the owner. `logoSha` is
	// the fingerprint of the logo the last test page carried (what "The logo
	// printed correctly" records); `logoSent` is true after a test page that
	// carried the logo, which is the only time the two answer keys are offered.
	// A confirmation vouches for ONE printer, so it is withdrawn again by "It did
	// not print correctly" (for the logo that page carried) and by every pairing
	// saved or forgotten (print-client.ts) — the gate cannot tell printers apart.
	let logoCached = $state(false);
	let logoConfirmed = $state(false);
	let logoSha = $state<string | null>(null);
	let logoSent = $state(false);
	// The receipt printer that test page printed on (print-client.ts printerKeyOf):
	// "The logo printed correctly" records it, so the confirmation counts only
	// while the agent still reports that printer (print-agent-installer T-14).
	let testedPrinterKey = $state<string | null>(null);

	const chip = $derived(
		status === null ? null : printerChip(status, { logoCached, logoConfirmed })
	);

	// THE PRINTER FIELDS (print-agent-installer T-16): the receipt printer's
	// address and paper width, typed here once and kept by the agent on this PC
	// (PUT /printers). Offered only to an agent that says it can set printers; a
	// paired older agent gets one sentence instead. A width starts unchosen when
	// the agent has no printer: a guessed width wraps every line of a receipt.
	let receiptAddress = $state('');
	let receiptWidth = $state<PrinterWidth | null>(null);
	let separateKitchen = $state(false);
	let kitchenAddress = $state('');
	let kitchenWidth = $state<PrinterWidth | null>(null);
	let fieldsError = $state('');
	let receiptInvalid = $state(false);
	let kitchenInvalid = $state(false);
	// The paired agent's status while it answers (with or without a printer), else null.
	const answering = $derived(
		paired && status !== null && (status.state === 'ready' || status.state === 'no_printer')
			? status.status
			: null
	);
	const canSetPrinters = $derived(answering !== null && agentSupports(answering, 'printers'));

	// THE PRINT AGENT INSTALLER (print-agent-installer T-15): one download per OS,
	// served by this app (GET /downloads/print-agent). Fetched on mount and never
	// awaited before the page renders: offline, the page keeps working and says
	// the download needs a connection. The service worker passes it through and
	// caches nothing (CLAUDE.md, the service-worker decision part 6).
	type Downloads =
		| { status: 'loading' }
		| { status: 'offline' }
		| { status: 'not_built' }
		| { status: 'ready'; files: DownloadFile[] };
	let downloads = $state<Downloads>({ status: 'loading' });
	const platform =
		typeof navigator === 'undefined'
			? 'unknown'
			: guessPlatform(
					navigator as unknown as {
						userAgent: string;
						platform?: string;
						userAgentData?: { platform?: string };
					}
				);
	const pick = $derived(
		downloads.status === 'ready'
			? recommend(downloads.files, platform)
			: { primary: [] as DownloadFile[], others: [] as DownloadFile[] }
	);
	// Open while the till still needs the agent; folded away once it answers.
	const installerOpen = $derived(
		!paired ||
			status === null ||
			status.state === 'unreachable' ||
			status.state === 'blocked' ||
			status.state === 'not_set_up'
	);

	async function loadDownloads() {
		try {
			const response = await fetch('/downloads/print-agent', {
				credentials: 'same-origin',
				cache: 'no-store'
			});
			if (response.status === 404) {
				downloads = { status: 'not_built' };
				return;
			}
			if (!response.ok) {
				downloads = { status: 'offline' };
				return;
			}
			const body: unknown = await response.json();
			const listed = (body as { files?: unknown } | null)?.files;
			const files = Array.isArray(listed) ? listed.filter(isDownloadFile) : [];
			downloads = files.length > 0 ? { status: 'ready', files } : { status: 'not_built' };
		} catch {
			downloads = { status: 'offline' };
		}
	}

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
				// Not awaited: the page never waits on the network to render.
				void loadDownloads();
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
				// The rule receipts use: a confirmation counts for the printer it was watched on.
				({ cached: logoCached, confirmed: logoConfirmed } = await logoGate(status));
				fillFields(status);
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
			case 'no_printer':
				return '◆ The agent answered, but no printer address is set yet — enter it below';
			case 'unauthorized':
			case 'blocked':
			case 'unreachable':
				// The same sentences a failed Save printers shows (printer-form.ts).
				return agentSentence(state.state, url);
			case 'not_set_up':
				return '○ Printer not set up';
		}
	}

	/** The fields show what the agent has now. Never called on a refresh the owner did not ask for. */
	function fillFields(state: AgentState | null) {
		if (!state || (state.state !== 'ready' && state.state !== 'no_printer')) return;
		const { receipt, kitchen } = state.status.printers;
		receiptAddress = addressText(receipt);
		receiptWidth = receipt?.width ?? null;
		separateKitchen = kitchen !== null;
		kitchenAddress = addressText(kitchen);
		kitchenWidth = kitchen?.width ?? null;
		fieldsError = '';
		receiptInvalid = false;
		kitchenInvalid = false;
	}

	/** The fields as the PUT /printers body, or the first thing wrong with them — nothing is sent then. */
	function readFields():
		| { ok: true; receipt: PrinterFields; kitchen: PrinterFields | null }
		| { ok: false; error: string; field: 'receipt' | 'kitchen' } {
		const receipt = parseAddress(receiptAddress);
		if ('error' in receipt)
			return { ok: false, error: `Receipt printer: ${receipt.error}`, field: 'receipt' };
		if (receiptWidth === null) {
			return { ok: false, error: 'Choose the receipt printer’s paper width', field: 'receipt' };
		}
		if (!separateKitchen)
			return { ok: true, receipt: { ...receipt, width: receiptWidth }, kitchen: null };
		const kitchen = parseAddress(kitchenAddress);
		if ('error' in kitchen)
			return { ok: false, error: `Kitchen printer: ${kitchen.error}`, field: 'kitchen' };
		if (kitchenWidth === null) {
			return { ok: false, error: 'Choose the kitchen printer’s paper width', field: 'kitchen' };
		}
		return {
			ok: true,
			receipt: { ...receipt, width: receiptWidth },
			kitchen: { ...kitchen, width: kitchenWidth }
		};
	}

	/**
	 * "Save printers". THE LOGO GATE FIRST (invariant 9's drawer rule rides on it):
	 * a confirmation vouches for the printer it was watched on, so whenever the
	 * receipt printer's host, port or width changes it is withdrawn BEFORE the
	 * agent is asked — the same order as saveAgentSettings — and a save that then
	 * fails still leaves the gate closed. It is withdrawn whether or not a logo is
	 * cached now (a confirmation outlives a removed logo that comes back with the
	 * same fingerprint). The printer key binding (printing.ts logoForAgent) closes
	 * the gate too, for a change made on the agent's own setup page, which cannot
	 * reach this till's store; this withdrawal is not the only path, nor the
	 * binding.
	 */
	async function savePrintersHere() {
		if (busy || status === null || (status.state !== 'ready' && status.state !== 'no_printer')) {
			return;
		}
		const fields = readFields();
		receiptInvalid = !fields.ok && fields.field === 'receipt';
		kitchenInvalid = !fields.ok && fields.field === 'kitchen';
		if (!fields.ok) {
			fieldsError = `✕ ${fields.error}`;
			return;
		}
		fieldsError = '';
		const next = { receipt: fields.receipt, kitchen: fields.kitchen };
		const before = status.status;
		busy = true;
		failure = '';
		results = [];
		try {
			let withdrawn = false;
			if (receiptChanged(before, next)) {
				try {
					await withdrawReceiptLogoConfirmation();
				} catch {
					// Not withdrawn: the agent is not asked, so no printer changes under a confirmation.
					failure = '✕ The printers could not be saved — try again';
					return;
				}
				withdrawn = true;
				// A test page printed on the old printer is no longer answered here.
				logoSent = false;
				testedPrinterKey = null;
			}
			const result = await savePrinters(before, next);
			const lines = [messageFor(result, url)];
			status = await agentStatus();
			({ cached: logoCached, confirmed: logoConfirmed } = await logoGate(status));
			if (withdrawn && logoCached) lines.push('◆ Test-print the logo again before receipts use it');
			results = lines;
			if (result === 'saved') fillFields(status);
			announceChange();
		} catch (err) {
			failure = `✕ ${err instanceof Error ? err.message : 'The printers could not be saved'}`;
		} finally {
			busy = false;
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
			// Saving withdrew the logo confirmation, and an answer to a test page
			// printed before this pairing is no longer offered: it may have been
			// another printer.
			logoConfirmed = false;
			logoSent = false;
			url = settings.url;
			paired = true;
			announceChange();
			status = await agentStatus();
			results = [status.state === 'ready' ? `● Paired with the agent at ${url}` : explain(status)];
			fillFields(status);
		} catch (err) {
			failure = `✕ ${err instanceof Error ? err.message : 'The pairing could not be saved'}`;
			status = await agentStatus();
		}
	}

	function explainRefusal(reason: PairingRefusal): string {
		switch (reason) {
			case 'closed':
				return '○ Pairing is closed on the print agent. On this PC, run the matcami print agent file again and press Open pairing for a till, then press Pair this till again';
			case 'claimed':
				return '✕ Pairing was already used. On this PC, run the matcami print agent file again and press Open pairing for a till, then press Pair this till. If you did not pair a till since installing it, something else on this PC took the pairing: choose Advanced → Reset the pairing key there';
			case 'blocked':
				return "✕ Pairing blocked by Chrome — open Chrome's site settings for this address and allow local network access, then try again";
			case 'unreachable':
				return `◆ Nothing answered at ${url}. Is the matcami print agent installed on this PC? Download it below, run it, then press Pair this till.`;
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
		logoSent = false;
		try {
			status = await agentStatus();
			if (status.state !== 'ready') {
				results = [explain(status)];
				return;
			}
			const printers = status.status.printers;
			testedPrinterKey = printerKeyOf(status.status);
			// The cached logo, whenever the agent can print it — confirmed or not:
			// this is the one page that may carry an unconfirmed logo, and only the
			// RECEIPT printer's page gets it. The fingerprint is read beside it and
			// counts only when that record's three fields ARE the image this page
			// carries (the server's sha256 covers exactly the shape and the bitmap):
			// a logo refreshed between the two reads is offered no confirmation,
			// so "The logo printed correctly" never records a logo nobody watched.
			const [{ cached, confirmed, logo }, cachedLogo] = await Promise.all([
				logoForAgent(status.status, 'test'),
				readReceiptLogo().catch(() => null)
			]);
			logoCached = cached;
			logoConfirmed = confirmed;
			logoSha =
				logo !== null &&
				cachedLogo !== null &&
				cachedLogo.widthDots === logo.widthDots &&
				cachedLogo.heightDots === logo.heightDots &&
				cachedLogo.bitmap === logo.bitmap
					? cachedLogo.sha256
					: null;
			const now = new Date().toISOString();
			const base = { restaurantName, deviceCode, now, timeZone };
			const receipt = await submitJob({
				id: `test:${crypto.randomUUID()}`,
				printer: 'receipt',
				lines: renderTestPage({ ...base, width: printers.receipt.width, printer: 'receipt', logo }),
				cut: true
			});
			results = [describe('receipt', receipt)];
			if (receipt === 'queued' || receipt === 'duplicate') {
				if (logo !== null) {
					results = [
						...results,
						'● The logo was sent — it should print at the top of the receipt test page.'
					];
					logoSent = logoSha !== null;
				} else if (cached) {
					results = [
						...results,
						'◆ The logo was left off — update the print agent on this PC to version 2'
					];
				}
			}
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

	/** "The logo printed correctly": record the sent logo's fingerprint; receipts carry it from now on. */
	async function logoPrinted() {
		if (busy || logoSha === null) return;
		if (testedPrinterKey === null) {
			// The agent reported no printer address for the test page: nothing to vouch for.
			failure = '✕ Press Test print again before confirming the logo';
			return;
		}
		busy = true;
		failure = '';
		try {
			await confirmReceiptLogo(logoSha, testedPrinterKey);
			logoConfirmed = true;
			logoSent = false;
			results = [...results, '● Receipts will print the logo'];
			// The layout's chip re-polls on this: its "Test-print the logo" warning clears.
			announceChange();
		} catch (err) {
			failure = `✕ ${err instanceof Error ? err.message : 'The confirmation could not be saved'}`;
		} finally {
			busy = false;
		}
	}

	/**
	 * "It did not print correctly": withdraw ANY confirmation, not only the one of
	 * the logo this test page carried. A failed raster print means this printer
	 * cannot print a logo at all, so no logo confirmed on another printer — this
	 * one, or one restored later with the same fingerprint — may keep reaching its
	 * receipts. Receipts print without the logo until a test print is confirmed again.
	 */
	async function logoNotPrinted() {
		if (busy || logoSha === null) return;
		busy = true;
		failure = '';
		try {
			await withdrawReceiptLogoConfirmation();
			// Read back exactly as onMount and the layout derive it, so this chip is right at once.
			({ cached: logoCached, confirmed: logoConfirmed } = await logoGate(status));
			logoSent = false;
			results = [
				...results,
				'✕ Receipts will print without the logo. Remove it on the dashboard (Settings → Receipt).'
			];
			// The layout's chip re-polls on this: its "Test-print the logo" warning returns.
			announceChange();
		} catch {
			failure = '✕ The answer could not be saved — try again';
		} finally {
			busy = false;
		}
	}

	async function forget() {
		if (busy) return;
		busy = true;
		failure = '';
		results = [];
		logoSent = false;
		try {
			await clearAgentSettings();
			// Forgetting withdrew the logo confirmation too (print-client.ts).
			logoConfirmed = false;
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
	const savePrimary =
		'min-h-touch-lg w-full border border-control-line rounded-control bg-accent text-accent-ink font-semibold text-pos disabled:bg-disabled-bg disabled:text-disabled-ink';
	// The chosen width carries the radio's own dot, not colour alone.
	const WIDTHS: { width: PrinterWidth; label: string }[] = [
		{ width: 32, label: '58 mm paper' },
		{ width: 48, label: '80 mm paper' }
	];
	const widthOf = (target: 'receipt' | 'kitchen') =>
		target === 'receipt' ? receiptWidth : kitchenWidth;
	function setWidth(target: 'receipt' | 'kitchen', width: PrinterWidth) {
		if (target === 'receipt') receiptWidth = width;
		else kitchenWidth = width;
	}
</script>

<svelte:head><title>Printer · matcami</title></svelte:head>
<svelte:window onhashchange={onHashChange} />

{#snippet paperWidth(target: 'receipt' | 'kitchen', legend: string)}
	<fieldset class="flex flex-col gap-2">
		<legend class="mb-1 font-semibold">{legend}</legend>
		<div class="grid grid-cols-2 gap-2">
			{#each WIDTHS as option (option.width)}
				<label class="min-h-touch-lg has-checked:border-accent flex items-center gap-3 px-4 {KEY}">
					<input
						type="radio"
						name="{target}-width"
						value={option.width}
						class="accent-accent size-6"
						checked={widthOf(target) === option.width}
						onchange={() => setWidth(target, option.width)}
					/>
					{option.label}
				</label>
			{/each}
		</div>
	</fieldset>
{/snippet}

{#snippet installer()}
	<section
		class="flex flex-col gap-3"
		aria-labelledby="agent-download-heading"
		data-testid="agent-download"
	>
		<h3 id="agent-download-heading" class="text-ink font-semibold">
			Install the print agent on this PC
		</h3>
		{#if downloads.status === 'loading'}
			<p class="text-ink-2">Looking for the installer…</p>
		{:else if downloads.status === 'offline'}
			<p class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2">
				<span aria-hidden="true" class="font-mono">◆</span> The installer needs a connection — open this
				page again when online
			</p>
		{:else if downloads.status === 'not_built'}
			<p class="bg-raise-2 text-ink-2 rounded-control px-3 py-2">
				<span aria-hidden="true" class="font-mono">○</span> The installer has not been built on the server
				yet
			</p>
		{:else}
			{#each [...pick.primary, ...pick.others] as file, i (file.name)}
				{#if i === pick.primary.length && pick.primary.length > 0}
					<p class="text-ink-2">For another computer:</p>
				{/if}
				<div class="flex flex-col gap-1">
					<a
						class="{secondary} inline-flex items-center justify-center"
						href={resolve('/downloads/print-agent/[file]', { file: file.name })}
						download={file.name}>Download for {shortOsLabel(file.os, file.arch)}</a
					>
					<p class="text-ink-2">
						{sizeLabel(file.bytes)}{#if !file.verified}
							· <span aria-hidden="true" class="font-mono">◆</span> Not yet checked on a Mac{/if}
					</p>
					<p class="text-ink-2 font-mono break-all">SHA-256 {file.sha256}</p>
				</div>
			{/each}
			{#if pick.primary.length > 0}
				<ul class="text-ink-2 flex flex-col gap-1" data-testid="first-run-steps">
					{#each firstRunSteps(pick.primary[0]!.os) as step (step)}
						<li>{step}</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>
{/snippet}

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
					This till is not paired yet. Install the matcami print agent on this PC — download it
					below — then press <strong>Pair this till</strong>. Nothing is typed here.
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

			<!-- The printer fields (print-agent-installer T-16): only for an agent that says it
			     can set printers; a paired older agent gets the sentence that says why not. -->
			{#if canSetPrinters}
				<form
					class="border-line flex flex-col gap-4 border-t pt-4"
					aria-labelledby="printer-fields-heading"
					data-testid="printer-fields"
					novalidate
					onsubmit={(event) => {
						event.preventDefault();
						void savePrintersHere();
					}}
				>
					<h3 id="printer-fields-heading" class="text-ink font-semibold">Printers</h3>
					<div class="flex flex-col gap-1">
						<label for="receipt-address" class="font-semibold">Receipt printer address (IP)</label>
						<input
							id="receipt-address"
							type="text"
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							placeholder="192.168.1.50"
							aria-invalid={receiptInvalid}
							aria-describedby={receiptInvalid ? 'printer-fields-error' : undefined}
							bind:value={receiptAddress}
							class="font-mono {TILL_FIELD}"
						/>
					</div>
					{@render paperWidth('receipt', 'Receipt paper')}
					<label class="min-h-touch flex items-center gap-3 px-4 {KEY}">
						<input type="checkbox" class="accent-accent size-6" bind:checked={separateKitchen} />
						Separate kitchen printer
					</label>
					{#if separateKitchen}
						<div class="flex flex-col gap-1">
							<label for="kitchen-address" class="font-semibold">Kitchen printer address (IP)</label
							>
							<input
								id="kitchen-address"
								type="text"
								autocomplete="off"
								autocapitalize="off"
								spellcheck="false"
								placeholder="192.168.1.51"
								aria-invalid={kitchenInvalid}
								aria-describedby={kitchenInvalid ? 'printer-fields-error' : undefined}
								bind:value={kitchenAddress}
								class="font-mono {TILL_FIELD}"
							/>
						</div>
						{@render paperWidth('kitchen', 'Kitchen paper')}
					{:else}
						<p class="text-ink-2">Kitchen tickets print on the receipt printer.</p>
					{/if}
					{#if fieldsError}
						<p
							id="printer-fields-error"
							class="bg-danger-bg text-danger rounded-control px-3 py-2"
							role="alert"
						>
							{fieldsError}
						</p>
					{/if}
					<button type="submit" class={savePrimary} disabled={busy} data-testid="save-printers">
						{busy ? 'Working…' : 'Save printers'}
					</button>
				</form>
			{:else if answering !== null}
				<p
					class="bg-st-offline-bg text-st-offline rounded-control px-3 py-2"
					data-testid="printers-unsupported"
				>
					{messageFor({ error: 'unsupported' }, url)}
				</p>
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
			{#if logoSent}
				<!-- Offered only after a test page that carried the logo: the owner's answer
				     is what lets a receipt print it (the logo confirmation gate). -->
				<div
					class="flex flex-wrap items-center gap-3"
					role="group"
					aria-label="Did the logo print correctly?"
					data-testid="logo-check"
				>
					<button
						type="button"
						class={secondary}
						disabled={busy}
						data-testid="logo-printed"
						onclick={() => void logoPrinted()}
					>
						The logo printed correctly
					</button>
					<button
						type="button"
						class={secondary}
						disabled={busy}
						data-testid="logo-not-printed"
						onclick={() => void logoNotPrinted()}
					>
						It did not print correctly
					</button>
				</div>
			{/if}

			<!-- The print agent installer (print-agent-installer T-15): open while the till is
			     not paired or the agent did not answer, folded away otherwise. -->
			{#if installerOpen}
				{@render installer()}
			{:else}
				<details class="border-line border-t pt-4" data-testid="agent-download-details">
					<summary class="text-ink min-h-touch flex cursor-pointer items-center font-semibold">
						Print agent installer
					</summary>
					{@render installer()}
				</details>
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
