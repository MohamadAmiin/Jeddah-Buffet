// THE TILL'S PRINT CLIENT (spec 11 "Local WebSocket / HTTP", 32;
// tasks/menu-and-printing T-28). The only code on the till that talks to the
// print agent, and the only place the pairing token is read.
//
// THE TOKEN STAYS ON THE DEVICE (invariant 12): it lives in the IndexedDB
// `settings` store — never localStorage — and saveAgentSettings refuses any
// address that is not http://127.0.0.1:<port> or http://localhost:<port>, so it
// can never be sent anywhere but the loopback agent on this PC. Every request
// goes with `credentials: 'omit'` (no cookie ever reaches the agent) and an
// AbortController timeout, because a print must never hold up a sale.
//
// NOBODY TYPES THE PAIRING SECRET. requestPairing asks the agent for it (POST
// /pair), which the agent answers once, and only while its pairing is open
// (print-agent/src/pairing.ts). The other way in is the agent's `link`:
// `<app>/pos/printer#agent=…&token=…`, read by parsePairingFragment — the
// secret is in the FRAGMENT, which a browser sends to no server. A link opened
// before the owner is signed in waits in MEMORY (stashPairing) — not in any
// storage — until the Printer screen takes it; a reload simply drops it.
//
// `bindDevice` and `forgetDevice` clear the whole settings store, so a
// re-registered till must be paired again — deliberate: a token for a till that
// was handed to another restaurant must not survive (T-28 Watch out).
//
// A PAIRING SAVED OR FORGOTTEN WITHDRAWS THE RECEIPT-LOGO CONFIRMATION
// (settings.ts withdrawReceiptLogoConfirmation; settings-tax-payments-receipt
// Risk 6). The owner's "The logo printed correctly" vouched for the printer it
// was watched on; a new pairing may lead to another printer, and one without
// `GS v 0` reads the raster as data that could hold the drawer pulse.
//
// Chrome 142+ gates a public-origin page's requests to 127.0.0.1 behind a
// one-time "local network access" permission (RESEARCH.md). A refused request
// throws a TypeError exactly like an agent that is not running, so the client
// asks the Permissions API which it was — and never reports `blocked` unless the
// browser itself said `denied`.
import type { PrintLine } from './receipt';
import { withdrawReceiptLogoConfirmation } from './settings';
import { cacheSettings, readCachedSetting } from './store';

export const PRINT_AGENT_URL_KEY = 'printAgentUrl';
export const PRINT_AGENT_TOKEN_KEY = 'printAgentToken';
export const DEFAULT_AGENT_URL = 'http://127.0.0.1:9471';

export type AgentSettings = { url: string; token: string };

/** The agent's `GET /status` body (print-agent/src/server.ts AgentStatus). */
export type PrinterStatus = { width: 32 | 48; reachable: boolean; queued: number };
export type AgentStatus = {
	/**
	 * 1 prints text; 2 adds the validated image line (print-agent T-25), which
	 * is what lets a page carry the logo. The body is an unvalidated cast, so
	 * every reader asks agentPrintsImages rather than trusting the field.
	 */
	agentVersion: number;
	printers: { receipt: PrinterStatus; kitchen: PrinterStatus | null };
};

/** The first agent version that accepts an image line (print-agent T-25). */
export const IMAGE_AGENT_VERSION = 2;

/** True only when the status carries a NUMBER at or above IMAGE_AGENT_VERSION. */
export function agentPrintsImages(status: AgentStatus): boolean {
	return typeof status.agentVersion === 'number' && status.agentVersion >= IMAGE_AGENT_VERSION;
}

export type AgentState =
	| { state: 'not_set_up' }
	| { state: 'ready'; status: AgentStatus }
	| { state: 'unauthorized' }
	| { state: 'blocked' }
	| { state: 'unreachable' };

export type PrintJob = {
	id: string;
	printer: 'receipt' | 'kitchen';
	lines: PrintLine[];
	cut: boolean;
};
export type SubmitResult = 'queued' | 'duplicate' | { error: string };
export type DrawerResult =
	'opened' | 'duplicate' | 'too_late' | 'printer_unreachable' | { error: string };

export type LocalNetworkPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

const STATUS_TIMEOUT_MS = 3000;
const JOB_TIMEOUT_MS = 5000;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{4,5})$/;

// ── Settings ────────────────────────────────────────────────────────────────

/** Exactly `http://127.0.0.1:<port>` or `http://localhost:<port>`, port 1024–65535, no path. */
export function isAgentUrl(url: unknown): url is string {
	if (typeof url !== 'string') return false;
	const match = URL_RE.exec(url);
	if (!match) return false;
	const port = Number.parseInt(match[1] ?? '', 10);
	return port >= 1024 && port <= 65535;
}

export function isAgentToken(token: unknown): token is string {
	return typeof token === 'string' && TOKEN_RE.test(token);
}

export async function readAgentSettings(): Promise<AgentSettings | null> {
	const [url, token] = await Promise.all([
		readCachedSetting(PRINT_AGENT_URL_KEY),
		readCachedSetting(PRINT_AGENT_TOKEN_KEY)
	]);
	if (!isAgentUrl(url) || !isAgentToken(token)) return null;
	return { url, token };
}

/**
 * Throws — and stores nothing — unless the address is loopback and the token is
 * 64 hex. A pairing that IS saved withdraws the receipt-logo confirmation
 * first, whatever it replaces (see the header): withdrawn before the write, so
 * a failure between the two leaves the gate closed — never a new pairing under
 * an old confirmation.
 */
export async function saveAgentSettings(settings: AgentSettings): Promise<void> {
	const url = settings.url.trim();
	const token = settings.token.trim();
	if (!isAgentUrl(url)) {
		throw new Error(
			'The agent address must be http://127.0.0.1:<port> or http://localhost:<port> — the agent runs on this PC only'
		);
	}
	if (!isAgentToken(token)) {
		throw new Error('The pairing link is damaged — open the link the agent printed again');
	}
	await withdrawReceiptLogoConfirmation();
	await cacheSettings([
		{ key: PRINT_AGENT_URL_KEY, value: url },
		{ key: PRINT_AGENT_TOKEN_KEY, value: token }
	]);
}

/** "Forget pairing": the logo confirmation goes first, as in saveAgentSettings, then the pairing. */
export async function clearAgentSettings(): Promise<void> {
	await withdrawReceiptLogoConfirmation();
	await cacheSettings([
		{ key: PRINT_AGENT_URL_KEY, value: null },
		{ key: PRINT_AGENT_TOKEN_KEY, value: null }
	]);
}

// ── The pairing link ────────────────────────────────────────────────────────

/**
 * The fragment of the link the agent prints (print-agent/src/main.ts
 * pairingLink): `#agent=<loopback address>&token=<64 hex>`. Anything else —
 * no fragment, another address, a short token — is null, never a guess.
 */
export function parsePairingFragment(hash: string): AgentSettings | null {
	const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
	const url = fragment.get('agent');
	const token = fragment.get('token');
	if (!isAgentUrl(url) || !isAgentToken(token)) return null;
	return { url, token };
}

let pendingPairing: AgentSettings | null = null;

/** Hold a pairing read from a link until the owner's Printer screen takes it. */
export function stashPairing(settings: AgentSettings): void {
	pendingPairing = settings;
}

export function hasPendingPairing(): boolean {
	return pendingPairing !== null;
}

/** Hand the waiting pairing over, once. */
export function takePairing(): AgentSettings | null {
	const settings = pendingPairing;
	pendingPairing = null;
	return settings;
}

// ── Requests ────────────────────────────────────────────────────────────────

export type PairingRefusal =
	/** Open pairing's one claim is gone — this till's, or something else's. */
	| 'claimed'
	/** Nobody has opened pairing on the agent. */
	| 'closed'
	| 'blocked'
	| 'unreachable'
	| 'refused';
export type PairingResult =
	{ ok: true; settings: AgentSettings } | { ok: false; reason: PairingRefusal };

/**
 * Ask the agent on this PC for the pairing secret. Stores NOTHING — the caller
 * saves the settings it is handed. No Authorization header (the till has none
 * yet) and no body, so the agent's Host and Origin walls are what stand in
 * front of it, and whether its pairing is open decides the answer.
 */
export async function requestPairing(
	url: string = DEFAULT_AGENT_URL,
	fetchFn: typeof fetch = fetch,
	probe: () => Promise<LocalNetworkPermission> = localNetworkPermission
): Promise<PairingResult> {
	if (!isAgentUrl(url)) return { ok: false, reason: 'refused' };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetchFn(url + '/pair', {
			method: 'POST',
			credentials: 'omit',
			mode: 'cors',
			signal: controller.signal
		});
	} catch {
		return { ok: false, reason: await failureState(probe) };
	} finally {
		clearTimeout(timer);
	}
	const body = await bodyOf(response);
	if (response.status === 200 && isAgentToken(body.token)) {
		return { ok: true, settings: { url, token: body.token } };
	}
	if (response.status === 403 && body.error === 'pairing_closed') {
		return { ok: false, reason: body.reason === 'claimed' ? 'claimed' : 'closed' };
	}
	return { ok: false, reason: 'refused' };
}

async function agentFetch(
	settings: AgentSettings,
	path: string,
	init: { method: 'GET' | 'POST'; body?: unknown },
	timeoutMs: number,
	fetchFn: typeof fetch
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchFn(settings.url + path, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${settings.token}`,
				'Content-Type': 'application/json'
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			credentials: 'omit',
			mode: 'cors',
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
	try {
		const json: unknown = await response.json();
		return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function errorCode(body: Record<string, unknown>, status: number): string {
	return typeof body.error === 'string' ? body.error : `http_${status}`;
}

/**
 * Which of the two identical-looking failures this was. Chrome names the
 * permission `loopback-network` from 145 and `local-network-access` before;
 * an unknown name throws a TypeError. No Permissions API, or any other
 * failure, is `unknown` — never `denied`.
 */
export async function localNetworkPermission(): Promise<LocalNetworkPermission> {
	const permissions =
		typeof navigator === 'undefined' ? undefined : (navigator.permissions ?? undefined);
	if (!permissions || typeof permissions.query !== 'function') return 'unknown';
	for (const name of ['loopback-network', 'local-network-access']) {
		try {
			const result = await permissions.query({ name: name as PermissionName });
			if (result.state === 'granted' || result.state === 'denied' || result.state === 'prompt') {
				return result.state;
			}
			return 'unknown';
		} catch (error) {
			if (error instanceof TypeError) continue;
			return 'unknown';
		}
	}
	return 'unknown';
}

async function failureState(
	probe: () => Promise<LocalNetworkPermission>
): Promise<'blocked' | 'unreachable'> {
	return (await probe()) === 'denied' ? 'blocked' : 'unreachable';
}

export async function agentStatus(
	fetchFn: typeof fetch = fetch,
	probe: () => Promise<LocalNetworkPermission> = localNetworkPermission
): Promise<AgentState> {
	const settings = await readAgentSettings();
	if (!settings) return { state: 'not_set_up' };
	let response: Response;
	try {
		response = await agentFetch(settings, '/status', { method: 'GET' }, STATUS_TIMEOUT_MS, fetchFn);
	} catch {
		return { state: await failureState(probe) };
	}
	if (response.status === 200) {
		const body = await bodyOf(response);
		return { state: 'ready', status: body as unknown as AgentStatus };
	}
	if (response.status === 401 || response.status === 403) return { state: 'unauthorized' };
	return { state: 'unreachable' };
}

export async function submitJob(
	job: PrintJob,
	fetchFn: typeof fetch = fetch,
	probe: () => Promise<LocalNetworkPermission> = localNetworkPermission
): Promise<SubmitResult> {
	const settings = await readAgentSettings();
	if (!settings) return { error: 'not_set_up' };
	let response: Response;
	try {
		response = await agentFetch(
			settings,
			'/jobs',
			{ method: 'POST', body: job },
			JOB_TIMEOUT_MS,
			fetchFn
		);
	} catch {
		return { error: await failureState(probe) };
	}
	if (response.status === 202) return 'queued';
	if (response.status === 200) return 'duplicate';
	return { error: errorCode(await bodyOf(response), response.status) };
}

export async function pulseDrawer(
	args: { id: string; completedAt: string },
	fetchFn: typeof fetch = fetch,
	probe: () => Promise<LocalNetworkPermission> = localNetworkPermission
): Promise<DrawerResult> {
	const settings = await readAgentSettings();
	if (!settings) return { error: 'not_set_up' };
	let response: Response;
	try {
		response = await agentFetch(
			settings,
			'/drawer',
			{ method: 'POST', body: args },
			JOB_TIMEOUT_MS,
			fetchFn
		);
	} catch {
		return { error: await failureState(probe) };
	}
	const body = await bodyOf(response);
	if (response.status === 200) return body.status === 'duplicate' ? 'duplicate' : 'opened';
	if (response.status === 409) return 'too_late';
	if (response.status === 503) return 'printer_unreachable';
	return { error: errorCode(body, response.status) };
}

// ── The chip ────────────────────────────────────────────────────────────────

export type PrinterChip = {
	glyph: '●' | '◆' | '✕' | '○';
	text: string;
	tone: 'ok' | 'offline' | 'danger' | 'neutral';
};

export type PrinterChipOptions = {
	/** A logo is cached on this till (settings.ts readReceiptLogo). */
	logoCached?: boolean;
	/** The owner confirmed that logo's test print on /pos/printer (readConfirmedLogoSha). */
	logoConfirmed?: boolean;
};

/**
 * One glyph AND one sentence per state: colour never carries the meaning alone.
 * A ready agent too old to print the cached logo, or one whose logo the owner
 * has not test-printed and confirmed yet, says so in the offline tone — the
 * till bar lists that sentence among its warnings. Receipts still print, without
 * the logo (T-24).
 */
export function printerChip(state: AgentState, opts: PrinterChipOptions = {}): PrinterChip {
	switch (state.state) {
		case 'ready': {
			const { receipt, kitchen } = state.status.printers;
			const waiting = receipt.queued + (kitchen?.queued ?? 0);
			const suffix = waiting > 0 ? ` · ${waiting} waiting` : '';
			if (opts.logoCached && !agentPrintsImages(state.status)) {
				return {
					glyph: '◆',
					text: `Update the print agent to print the logo${suffix}`,
					tone: 'offline'
				};
			}
			if (opts.logoCached && agentPrintsImages(state.status) && !opts.logoConfirmed) {
				return {
					glyph: '◆',
					text: `Test-print the logo before receipts use it${suffix}`,
					tone: 'offline'
				};
			}
			return { glyph: '●', text: `Printer ready${suffix}`, tone: 'ok' };
		}
		case 'unreachable':
			return { glyph: '◆', text: 'Printer unreachable', tone: 'offline' };
		case 'blocked':
			return {
				glyph: '✕',
				text: 'Printing blocked by Chrome — allow local network access',
				tone: 'danger'
			};
		case 'unauthorized':
			return { glyph: '✕', text: 'Printer pairing is wrong — pair again', tone: 'danger' };
		case 'not_set_up':
			return { glyph: '○', text: 'Printer not set up', tone: 'neutral' };
	}
}
