// THE PRINTER FIELDS ON THE TILL'S PRINTER PAGE (print-agent-installer T-16).
// The owner types the receipt printer's address once, on the till, and the agent
// on this PC keeps it (PUT /printers). Everything here is pure: what the page
// reads from the fields, whether the receipt printer changed (which is what
// withdraws the logo confirmation), and the sentence each answer gets.
//
// The agent checks the address again (print-agent/src/config.ts parsePrinter):
// this is the owner's early answer, not the control.

import {
	printerKeyOf,
	type AgentStatus,
	type PrinterStatus,
	type SavePrintersResult
} from './print-client';

export type PrinterWidth = 32 | 48;
export type PrinterFields = { host: string; port: number; width: PrinterWidth };
export type PrintersBody = { receipt: PrinterFields; kitchen: PrinterFields | null };

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

/**
 * True when saving `next` changes the receipt printer the agent reports — its
 * host, port or width (printerKeyOf). A status with no receipt printer, or one
 * from an older agent ('legacy'), never matches, so the confirmation is withdrawn.
 */
export function receiptChanged(status: AgentStatus, next: PrintersBody): boolean {
	return printerKeyOf(status) !== `${next.receipt.host}:${next.receipt.port}:${next.receipt.width}`;
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
		case 'bad_printers':
			return '✕ Check the printer address';
		case 'unsupported':
			return '◆ Update the print agent on this PC to set printers here — download it below';
		case 'unauthorized':
		case 'blocked':
		case 'unreachable':
			return agentSentence(result.error, url);
		case 'not_set_up':
			return '○ Printer not set up — pair this till first';
		default:
			return `✕ The agent refused the printers (${result.error})`;
	}
}
