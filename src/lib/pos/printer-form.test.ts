import { describe, expect, it } from 'vitest';
import type { AgentStatus, SavePrintersResult } from './print-client';
import {
	addressText,
	agentSentence,
	applyPrinters,
	DEFAULT_PRINTER_PORT,
	localNameOf,
	messageFor,
	parseAddress,
	placeOf,
	receiptChanged,
	type PrintersBody
} from './printer-form';

const URL = 'http://127.0.0.1:9471';

/** A status from an agent that can set printers, with this receipt printer. */
function status(receipt: { host: string; port: number; width: 32 | 48 } | null): AgentStatus {
	return {
		agentVersion: 2,
		features: ['printers', 'setup'],
		printers: {
			receipt: receipt === null ? null : { ...receipt, reachable: true, queued: 0 },
			kitchen: null
		}
	};
}

function body(host: string, port: number, width: 32 | 48): PrintersBody {
	return { receipt: { host, port, width }, kitchen: null };
}

describe('the printer address the owner types (print-agent-installer T-16)', () => {
	it('a bare IP gets the ESC/POS port 9100; host:port keeps its port', () => {
		expect(parseAddress('192.168.1.50')).toEqual({ host: '192.168.1.50', port: 9100 });
		expect(parseAddress('  10.0.0.5:9101 ')).toEqual({ host: '10.0.0.5', port: 9101 });
		expect(parseAddress('printer.local')).toEqual({ host: 'printer.local', port: 9100 });
		expect(DEFAULT_PRINTER_PORT).toBe(9100);
	});

	it('refuses whitespace, a slash, an empty host and a port outside 1–65535', () => {
		const address = 'Enter the printer’s IP address, e.g. 192.168.1.50';
		expect(parseAddress('a b')).toEqual({ error: address });
		expect(parseAddress('')).toEqual({ error: address });
		expect(parseAddress('   ')).toEqual({ error: address });
		expect(parseAddress('http://192.168.1.50')).toEqual({ error: address });
		expect(parseAddress('192.168.1.50/24')).toEqual({ error: address });
		expect(parseAddress(':9100')).toEqual({ error: address });
		expect(parseAddress('fe80::1')).toEqual({ error: address });
		for (const text of ['1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:65536']) {
			expect(parseAddress(text)).toEqual({
				error:
					'The number after the colon is the printer’s port, 1 to 65535 — most printers use 9100'
			});
		}
		expect(parseAddress('1.2.3.4:65535')).toEqual({ host: '1.2.3.4', port: 65535 });
	});

	it('prefills the field from the agent: the port only when it is not 9100', () => {
		expect(
			addressText({ host: '192.168.1.50', port: 9100, width: 32, reachable: true, queued: 0 })
		).toBe('192.168.1.50');
		expect(
			addressText({ host: '10.0.0.5', port: 9101, width: 48, reachable: false, queued: 0 })
		).toBe('10.0.0.5:9101');
		// An older agent reports no address; no printer at all is an empty field.
		expect(addressText({ width: 32, reachable: true, queued: 0 })).toBe('');
		expect(addressText(null)).toBe('');
	});
});

describe('whether Save printers changes the receipt printer — the logo gate (T-16)', () => {
	const now = status({ host: '192.168.1.50', port: 9100, width: 32 });

	it('the same host, port and width is no change', () => {
		expect(receiptChanged(now, body('192.168.1.50', 9100, 32))).toBe(false);
	});

	it('a different width, host or port is a change', () => {
		expect(receiptChanged(now, body('192.168.1.50', 9100, 48))).toBe(true);
		expect(receiptChanged(now, body('192.168.1.51', 9100, 32))).toBe(true);
		expect(receiptChanged(now, body('192.168.1.50', 9101, 32))).toBe(true);
	});

	it('no printer yet, or an older agent that reports no address, is always a change', () => {
		expect(receiptChanged(status(null), body('192.168.1.50', 9100, 32))).toBe(true);
		const legacy: AgentStatus = {
			agentVersion: 2,
			printers: { receipt: { width: 32, reachable: true, queued: 0 }, kitchen: null }
		};
		expect(receiptChanged(legacy, body('192.168.1.50', 9100, 32))).toBe(true);
	});
});

describe('Save printers runs the logo gate FIRST (T-16, invariant 9)', () => {
	const now = status({ host: '192.168.1.50', port: 9100, width: 32 });

	/** Records the order of the two calls; `failWithdraw` makes the withdrawal throw. */
	function io(result: SavePrintersResult, failWithdraw = false) {
		const calls: string[] = [];
		return {
			calls,
			withdraw: async () => {
				calls.push('withdraw');
				if (failWithdraw) throw new Error('IndexedDB refused');
			},
			save: async () => {
				calls.push('save');
				return result;
			}
		};
	}

	it('a new receipt printer: the confirmation is withdrawn BEFORE the agent is asked', async () => {
		const run = io('saved');
		expect(await applyPrinters(now, body('192.168.1.60', 9100, 32), run)).toEqual({
			result: 'saved',
			withdrawn: true
		});
		expect(run.calls).toEqual(['withdraw', 'save']);
	});

	it('a refused save still leaves the gate closed — the withdrawal already happened', async () => {
		const refused = { error: 'jobs_waiting', target: 'receipt', queued: 1 } as const;
		const run = io(refused);
		expect(await applyPrinters(now, body('192.168.1.50', 9100, 48), run)).toEqual({
			result: refused,
			withdrawn: true
		});
		expect(run.calls).toEqual(['withdraw', 'save']);
	});

	it('a withdrawal that fails asks the agent NOTHING', async () => {
		const run = io('saved', true);
		expect(await applyPrinters(now, body('192.168.1.60', 9100, 32), run)).toEqual({
			result: null,
			withdrawn: false
		});
		expect(run.calls).toEqual(['withdraw']);
	});

	it('the same receipt printer (a kitchen change only) keeps the confirmation', async () => {
		const run = io('saved');
		const next: PrintersBody = {
			receipt: { host: '192.168.1.50', port: 9100, width: 32 },
			kitchen: { host: '192.168.1.51', port: 9100, width: 48 }
		};
		expect(await applyPrinters(now, next, run)).toEqual({ result: 'saved', withdrawn: false });
		expect(run.calls).toEqual(['save']);
	});
});

describe('the sentence after Save printers (T-16)', () => {
	it('saved', () => {
		expect(messageFor('saved', URL)).toBe('● Printer saved. Press Test print.');
	});

	// e2e/printing.spec.ts drives the one-receipt case against the real agent;
	// the plural and the kitchen printer are pinned here.
	it('jobs waiting for the old printer: counted, in the right grammar, per printer', () => {
		expect(messageFor({ error: 'jobs_waiting', target: 'receipt', queued: 1 }, URL)).toBe(
			'◆ 1 receipt is waiting for the old printer. Let them print, or reconnect it, before changing the paper width.'
		);
		expect(messageFor({ error: 'jobs_waiting', target: 'receipt', queued: 3 }, URL)).toBe(
			'◆ 3 receipts are waiting for the old printer. Let them print, or reconnect it, before changing the paper width.'
		);
		expect(messageFor({ error: 'jobs_waiting', target: 'kitchen', queued: 1 }, URL)).toBe(
			'◆ 1 kitchen ticket is waiting for the old printer. Let them print, or reconnect it, before changing the paper width.'
		);
		expect(messageFor({ error: 'jobs_waiting', target: 'kitchen', queued: 2 }, URL)).toBe(
			'◆ 2 kitchen tickets are waiting for the old printer. Let them print, or reconnect it, before changing the paper width.'
		);
	});

	it('a refused address, an older agent and an unpaired till', () => {
		expect(messageFor({ error: 'bad_printers', field: 'receipt.host' }, URL)).toBe(
			'✕ Check the printer address'
		);
		expect(messageFor({ error: 'unsupported' }, URL)).toBe(
			'◆ Update the print agent on this PC to set printers here — download it below'
		);
		expect(messageFor({ error: 'not_set_up' }, URL)).toBe(
			'○ Printer not set up — pair this till first'
		);
		expect(messageFor({ error: 'http_500' }, URL)).toBe(
			'✕ The agent refused the printers (http_500)'
		);
	});

	it('unauthorized, blocked and unreachable read exactly as the page explains those states', () => {
		for (const state of ['unauthorized', 'blocked', 'unreachable'] as const) {
			expect(messageFor({ error: state }, URL)).toBe(agentSentence(state, URL));
		}
		expect(agentSentence('unauthorized', URL)).toBe(
			'✕ Printer pairing is wrong — the print agent on this PC was set up again, or for another address. Forget the pairing, then pair again'
		);
		expect(agentSentence('blocked', URL)).toBe(
			"✕ Printing blocked by Chrome — open Chrome's site settings for this address and allow local network access, then try again"
		);
		expect(agentSentence('unreachable', URL)).toBe(
			'◆ Printer unreachable — nothing answered at http://127.0.0.1:9471. Is the matcami print agent installed on this PC? Download it below.'
		);
	});
});

describe('a printer plugged into the till PC (feat/local-printers)', () => {
	const named = (name: string, width: 32 | 48): AgentStatus => ({
		agentVersion: 2,
		features: ['printers', 'setup', 'local-printers'],
		printers: { receipt: { name, width, reachable: true, queued: 0 }, kitchen: null }
	});
	const local = (name: string, width: 32 | 48): PrintersBody => ({
		receipt: { name, width },
		kitchen: null
	});

	it('the same name and width is no change; another name, width or a move to the network is', () => {
		const now = named('SomStar-80mm-Series', 48);
		expect(receiptChanged(now, local('SomStar-80mm-Series', 48))).toBe(false);
		expect(receiptChanged(now, local('SomStar-80mm-Series', 32))).toBe(true);
		expect(receiptChanged(now, local('Other', 48))).toBe(true);
		expect(receiptChanged(now, body('192.168.1.50', 9100, 48))).toBe(true);
		expect(
			receiptChanged(status({ host: '192.168.1.50', port: 9100, width: 48 }), local('SomStar', 48))
		).toBe(true);
	});

	it('reads where a reported printer is, and its name on this PC', () => {
		const printer = named('SomStar-80mm-Series', 48).printers.receipt;
		expect(placeOf(printer, 'network')).toBe('local');
		expect(localNameOf(printer)).toBe('SomStar-80mm-Series');
		const network = status({ host: '192.168.1.50', port: 9100, width: 48 }).printers.receipt;
		expect(placeOf(network, 'local')).toBe('network');
		expect(localNameOf(network)).toBe('');
		expect(placeOf(null, 'local')).toBe('local');
		expect(localNameOf(null)).toBe('');
	});

	it('a refused name says to pick from the list; a refused address says to check it', () => {
		expect(messageFor({ error: 'bad_printers', field: 'receipt.name' }, URL)).toBe(
			'✕ Pick the printer from the list'
		);
		expect(messageFor({ error: 'bad_printers', field: 'kitchen.host' }, URL)).toBe(
			'✕ Check the printer address'
		);
	});
});
