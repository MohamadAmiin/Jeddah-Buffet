// THE PRINTER FIELDS ON THE TILL'S PRINTER PAGE (print-agent-installer T-16).
// The owner types the receipt printer's address once, on the till, and the agent
// on this PC keeps it (PUT /printers). Everything here is pure or takes its I/O
// as arguments: what the page reads from the fields, whether the receipt printer
// changed (which is what withdraws the logo confirmation), the order a save
// runs in, and the sentence each answer gets.
//
// The agent checks the address again (print-agent/src/config.ts parsePrinter):
// this is the owner's early answer, not the control.

import {
	printerKeyFor,
	printerKeyOf,
	type AgentState,
	type AgentStatus,
	type PrinterStatus,
	type SavePrintersResult
} from './print-client';

export type PrinterWidth = 32 | 48;
/** A network printer, or one plugged into (or installed on) the till PC, by its name there. */
export type PrinterFields =
	{ host: string; port: number; width: PrinterWidth } | { name: string; width: PrinterWidth };
export type PrintersBody = { receipt: PrinterFields; kitchen: PrinterFields | null };
/** Where a printer is: on the till PC, or on the network. */
export type PrinterPlace = 'local' | 'network';

/** The port an ESC/POS network printer listens on unless it was changed. */
export const DEFAULT_PRINTER_PORT = 9100;

const BAD_ADDRESS = 'Enter the printer’s IP address, e.g. 192.168.1.50';
const BAD_PORT =
	'The number after the colon is the printer’s port, 1 to 65535 — most printers use 9100';

/**
 * `host` or `host:port`, trimmed; the port defaults to 9100. No whitespace, no
 * slash, no second colon (a pasted URL or an IPv6 literal), and never empty.
 */
export function parseAddress(text: string): { host: string; port: number } | { error: string } {
	const match = /^([^\s/:]+)(?::(\d+))?$/.exec(text.trim());
	if (!match || !match[1]) return { error: BAD_ADDRESS };
	if (match[2] === undefined) return { host: match[1], port: DEFAULT_PRINTER_PORT };
	const port = Number.parseInt(match[2], 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: BAD_PORT };
	return { host: match[1], port };
}

/** What the address field shows for a printer the agent reports: the port only when it is not 9100. */
export function addressText(printer: PrinterStatus | null): string {
	if (!printer || typeof printer.host !== 'string') return '';
	return typeof printer.port === 'number' && printer.port !== DEFAULT_PRINTER_PORT
		? `${printer.host}:${printer.port}`
		: printer.host;
}

/** The name of the printer on the till PC a status reports, or '' for a network printer or none. */
export function localNameOf(printer: PrinterStatus | null): string {
	return printer?.name ?? '';
}

/** Where the printer a status reports is; `fallback` when none is set yet. */
export function placeOf(printer: PrinterStatus | null, fallback: PrinterPlace): PrinterPlace {
	if (!printer) return fallback;
	return printer.name ? 'local' : 'network';
}

/**
 * True when saving `next` changes the receipt printer the agent reports — its
 * host, port or width, or its name on the till PC (printerKeyOf). A status with
 * no receipt printer, or one from an older agent ('legacy'), never matches, so
 * the confirmation is withdrawn.
 */
export function receiptChanged(status: AgentStatus, next: PrintersBody): boolean {
	return printerKeyOf(status) !== printerKeyFor(next.receipt);
}

/**
 * Save printers, THE LOGO GATE FIRST: when the receipt printer changes, the
 * confirmation is withdrawn BEFORE the agent is asked, so a save that fails
 * still leaves the gate closed — and when the withdrawal itself fails, the agent
 * is not asked at all (`result: null`). `withdrawn` says the gate was closed.
 */
export async function applyPrinters(
	before: AgentStatus,
	next: PrintersBody,
	io: {
		withdraw: () => Promise<void>;
		save: (before: AgentStatus, next: PrintersBody) => Promise<SavePrintersResult>;
	}
): Promise<{ result: SavePrintersResult | null; withdrawn: boolean }> {
	let withdrawn = false;
	if (receiptChanged(before, next)) {
		try {
			await io.withdraw();
		} catch {
			return { result: null, withdrawn: false };
		}
		withdrawn = true;
	}
	return { result: await io.save(before, next), withdrawn };
}

/**
 * The sentences the page already shows for an agent in these states (explain()
 * in +page.svelte), kept here once so a failed save reads exactly the same.
 */
export function agentSentence(
	state: 'unauthorized' | 'blocked' | 'unreachable',
	url: string
): string {
	switch (state) {
		case 'unauthorized':
			return '✕ Printer pairing is wrong — the print agent on this PC was set up again, or for another address. Forget the pairing, then pair again';
		case 'blocked':
			return "✕ Printing blocked by Chrome — open Chrome's site settings for this address and allow local network access, then try again";
		case 'unreachable':
			return `◆ Printer unreachable — nothing answered at ${url}. Is the matcami print agent installed on this PC? Download it below.`;
	}
}

/**
 * A PAIRED till whose agent is not answering: the setup is intact, so this never
 * says to download or pair. Both claims are in the code: the installer starts the
 * agent at sign-in, and running the file again keeps config.json and its token.
 */
export function agentWaiting(url: string): string {
	return `◆ The print agent on this PC is not answering at ${url}. Nothing needs setting up again: it starts by itself after you sign in to this PC, and this page keeps checking. If it has not answered after a few minutes, run the matcami print agent file again (Print agent installer, below). That keeps the pairing and the printers.`;
}

/** The line the results list shows after Save printers. */
export function messageFor(result: SavePrintersResult, url: string): string {
	if (result === 'saved') return '● Printer saved. Press Test print.';
	switch (result.error) {
		case 'jobs_waiting': {
			const { target, queued } = result as { target: 'receipt' | 'kitchen'; queued: number };
			const what =
				target === 'kitchen'
					? queued === 1
						? 'kitchen ticket is'
						: 'kitchen tickets are'
					: queued === 1
						? 'receipt is'
						: 'receipts are';
			return `◆ ${queued} ${what} waiting for the old printer. Let them print, or reconnect it, before changing the paper width.`;
		}
		case 'print_service_unavailable':
			return '◆ The PC’s print service did not answer — try again in a moment';
		case 'bad_printers':
			return /\.name$/.test((result as { field: string }).field)
				? '✕ Pick the printer from the list'
				: '✕ Check the printer address';
		case 'unsupported':
			return '◆ Update the print agent on this PC to set printers here — download it below';
		case 'unauthorized':
		case 'blocked':
			return agentSentence(result.error, url);
		// Save printers is offered only to a paired till.
		case 'unreachable':
			return agentWaiting(url);
		case 'not_set_up':
			return '○ Printer not set up — pair this till first';
		default:
			return `✕ The agent refused the printers (${result.error})`;
	}
}

// ── The Printer details box (2026-11-10) ────────────────────────────────────
// Arabic printed as '?' on a Windows till after a power cycle although the
// till had been confirmed, and printing never reaches the server, so nothing
// could be read from a log. The box puts every fact the Arabic gate uses
// (printing.ts arabicForAgent) on the page, for one screenshot: the browser
// (each keeps its own store), the agent's build, the printer keys, and the
// confirmations in this browser and on the agent. Pure: the page passes what
// it read.

export type DetailRow = { label: string; value: string };

export type DetailsInput = {
	/** The agent's last answer, or null before the first. */
	state: AgentState | null;
	/** The printer keys confirmed in THIS browser's store (settings.ts). */
	confirmedHere: readonly string[];
	/** The printer chip's Arabic facts (printing.ts arabicGate), if read. */
	arabic: { inUse: boolean; supported: boolean; confirmed: boolean } | undefined;
	browser: {
		/** navigator.userAgent */
		userAgent: string;
		/** matchMedia('(display-mode: standalone)') — an installed app window. */
		standalone: boolean;
		/** navigator.storage.persisted(), null when the browser cannot say. */
		persisted: boolean | null;
	};
};

/** The browser a user-agent string names; Edge and Opera carry Chrome's token too, so they go first. */
export function browserName(userAgent: string): string {
	if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return 'Edge';
	if (/\bOPR\//.test(userAgent)) return 'Opera';
	if (/\bFirefox\//.test(userAgent)) return 'Firefox';
	// No word boundary: Playwright's Chromium says HeadlessChrome/.
	if (/Chrome\//.test(userAgent)) return 'Chrome';
	if (/\bSafari\//.test(userAgent)) return 'Safari';
	return 'unknown browser';
}

function printerRow(printer: PrinterStatus | null, none: string): string {
	if (!printer) return none;
	const key = printerKeyFor(printer) ?? 'no key (an older agent)';
	return `${key} · ${printer.reachable ? 'reachable' : 'not reachable'} · ${printer.queued} waiting`;
}

function list(keys: readonly string[], none: string): string {
	return keys.length === 0 ? none : keys.join(', ');
}

/** The rows of the box. Every value is a plain sentence or a key, never a secret. */
export function printerDetails(input: DetailsInput): DetailRow[] {
	const { state, browser } = input;
	const where = browser.standalone ? 'installed app window' : 'browser tab';
	const persisted =
		browser.persisted === null
			? 'storage: unknown'
			: browser.persisted
				? 'storage persisted'
				: 'storage NOT persisted';
	const rows: DetailRow[] = [
		{ label: 'Browser', value: `${browserName(browser.userAgent)} · ${where} · ${persisted}` }
	];
	if (state === null || state.state === 'not_set_up') {
		rows.push({ label: 'Agent', value: 'not paired' });
	} else if (state.state !== 'ready' && state.state !== 'no_printer') {
		rows.push({ label: 'Agent', value: `not answering (${state.state})` });
	} else {
		const status = state.status;
		rows.push(
			{
				label: 'Agent',
				value: `version ${status.agentVersion} · ${list(status.features ?? [], 'no features (an older agent)')}`
			},
			{ label: 'Receipt printer', value: printerRow(status.printers.receipt, 'none set') },
			{
				label: 'Kitchen printer',
				value: printerRow(status.printers.kitchen, 'none (tickets print on the receipt printer)')
			},
			{
				label: 'Arabic confirmed on the agent',
				value:
					status.arabicPrinters === undefined
						? 'this agent keeps no list'
						: list(status.arabicPrinters, 'none')
			}
		);
	}
	rows.push({
		label: 'Arabic confirmed in this browser',
		value: list(input.confirmedHere, 'none')
	});
	const arabic = input.arabic;
	rows.push({
		label: 'Receipts draw Arabic',
		value:
			arabic === undefined
				? 'not read yet'
				: !arabic.inUse
					? 'no Arabic in the menu or the receipt header'
					: !arabic.supported
						? 'no — the agent cannot print pictures (update it)'
						: arabic.confirmed
							? 'yes'
							: 'no — the printer is not confirmed in THIS browser'
	});
	return rows;
}
