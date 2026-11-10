import { describe, expect, it } from 'vitest';
import type { AgentState, AgentStatus, ReadyStatus, SavePrintersResult } from './print-client';
import {
	addressText,
	agentSentence,
	agentWaiting,
	applyPrinters,
	browserName,
	DEFAULT_PRINTER_PORT,
	localNameOf,
	messageFor,
	parseAddress,
	placeOf,
	printerDetails,
	receiptChanged,
	type DetailsInput,
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

	it('unauthorized and blocked read exactly as the page explains those states', () => {
		for (const state of ['unauthorized', 'blocked'] as const) {
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

	// 2026-10-30: only a paired till can Save printers, and its setup is intact, so an
	// agent that is not answering is never a reason to install or pair again.
	it('a paired till whose agent is not answering is told to wait, not to set up again', () => {
		expect(messageFor({ error: 'unreachable' }, URL)).toBe(agentWaiting(URL));
		const sentence = agentWaiting(URL);
		expect(sentence).toContain(URL);
		expect(sentence).toContain('Nothing needs setting up again');
		expect(sentence).toContain('keeps the pairing and the printers');
		expect(sentence).not.toMatch(/download|forget|pair this till/i);
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

	it('a print service that did not answer says to try again', () => {
		expect(messageFor({ error: 'print_service_unavailable', target: 'receipt' }, URL)).toBe(
			'◆ The PC’s print service did not answer — try again in a moment'
		);
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

// ── The Printer details box (2026-11-10) ────────────────────────────────────

const EDGE =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const CHROME =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const LOCAL: ReadyStatus = {
	agentVersion: 2,
	features: ['printers', 'setup', 'local-printers', 'text-images'],
	printers: {
		receipt: { name: 'SomStar 80mm Series', width: 48, reachable: true, queued: 0 },
		kitchen: null
	}
};

function input(over: Partial<DetailsInput> = {}): DetailsInput {
	return {
		state: { state: 'ready', status: LOCAL },
		confirmedHere: ['local:SomStar 80mm Series:48'],
		arabic: { inUse: true, supported: true, confirmed: true },
		browser: { userAgent: EDGE, standalone: true, persisted: true },
		...over
	};
}

const value = (rows: ReturnType<typeof printerDetails>, label: string) =>
	rows.find((row) => row.label === label)?.value;

describe('browserName tells Edge from Chrome', () => {
	it('Edge and Opera carry the Chrome token and are named first', () => {
		expect(browserName(EDGE)).toBe('Edge');
		expect(browserName(CHROME)).toBe('Chrome');
		expect(browserName(CHROME.replace('Chrome/', 'HeadlessChrome/'))).toBe('Chrome');
		expect(browserName(`${CHROME} OPR/115.0.0.0`)).toBe('Opera');
		expect(
			browserName('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')
		).toBe('Firefox');
		expect(browserName('')).toBe('unknown browser');
	});
});

describe('the Printer details box (2026-11-10)', () => {
	it('names the browser, the window and the storage', () => {
		expect(value(printerDetails(input()), 'Browser')).toBe(
			'Edge · installed app window · storage persisted'
		);
		expect(
			value(
				printerDetails(
					input({ browser: { userAgent: CHROME, standalone: false, persisted: null } })
				),
				'Browser'
			)
		).toBe('Chrome · browser tab · storage: unknown');
		expect(
			value(
				printerDetails(
					input({ browser: { userAgent: CHROME, standalone: false, persisted: false } })
				),
				'Browser'
			)
		).toBe('Chrome · browser tab · storage NOT persisted');
	});

	it('shows the agent, the printer keys and both confirmation lists', () => {
		const rows = printerDetails(input());
		expect(value(rows, 'Agent')).toBe('version 2 · printers, setup, local-printers, text-images');
		expect(value(rows, 'Receipt printer')).toBe(
			'local:SomStar 80mm Series:48 · reachable · 0 waiting'
		);
		expect(value(rows, 'Kitchen printer')).toBe('none (tickets print on the receipt printer)');
		expect(value(rows, 'Arabic confirmed on the agent')).toBe('this agent keeps no list');
		expect(value(rows, 'Arabic confirmed in this browser')).toBe('local:SomStar 80mm Series:48');
		expect(value(rows, 'Receipts draw Arabic')).toBe('yes');
	});

	it('an agent that keeps its own list shows it, empty or not', () => {
		const keeps = { ...LOCAL, arabicPrinters: [] as string[] };
		expect(
			value(
				printerDetails(input({ state: { state: 'ready', status: keeps } })),
				'Arabic confirmed on the agent'
			)
		).toBe('none');
		expect(
			value(
				printerDetails(
					input({
						state: { state: 'ready', status: { ...keeps, arabicPrinters: ['local:X:48'] } }
					})
				),
				'Arabic confirmed on the agent'
			)
		).toBe('local:X:48');
	});

	it("says why receipts print '?' in the gate's own words", () => {
		const unconfirmed = input({
			confirmedHere: [],
			arabic: { inUse: true, supported: true, confirmed: false }
		});
		const rows = printerDetails(unconfirmed);
		expect(value(rows, 'Arabic confirmed in this browser')).toBe('none');
		expect(value(rows, 'Receipts draw Arabic')).toBe(
			'no — the printer is not confirmed in THIS browser'
		);
		expect(
			value(
				printerDetails(input({ arabic: { inUse: true, supported: false, confirmed: false } })),
				'Receipts draw Arabic'
			)
		).toBe('no — the agent cannot print pictures (update it)');
		expect(
			value(
				printerDetails(input({ arabic: { inUse: false, supported: true, confirmed: false } })),
				'Receipts draw Arabic'
			)
		).toBe('no Arabic in the menu or the receipt header');
		expect(value(printerDetails(input({ arabic: undefined })), 'Receipts draw Arabic')).toBe(
			'not read yet'
		);
	});

	it('an agent that is not answering, or no pairing, still gives the browser rows', () => {
		for (const [state, text] of [
			[null, 'not paired'],
			[{ state: 'not_set_up' }, 'not paired'],
			[{ state: 'unreachable' }, 'not answering (unreachable)'],
			[{ state: 'unauthorized' }, 'not answering (unauthorized)']
		] as Array<[AgentState | null, string]>) {
			const rows = printerDetails(input({ state }));
			expect(value(rows, 'Agent')).toBe(text);
			expect(value(rows, 'Receipt printer')).toBeUndefined();
			expect(value(rows, 'Arabic confirmed in this browser')).toBe('local:SomStar 80mm Series:48');
		}
	});

	it('a network printer and an older agent read as their keys say', () => {
		const older: ReadyStatus = {
			agentVersion: 2,
			printers: {
				receipt: { width: 48, reachable: false, queued: 2 },
				kitchen: { host: '192.168.1.60', port: 9100, width: 32, reachable: true, queued: 0 }
			}
		};
		const rows = printerDetails(input({ state: { state: 'ready', status: older } }));
		expect(value(rows, 'Agent')).toBe('version 2 · no features (an older agent)');
		expect(value(rows, 'Receipt printer')).toBe(
			'no key (an older agent) · not reachable · 2 waiting'
		);
		expect(value(rows, 'Kitchen printer')).toBe('192.168.1.60:9100:32 · reachable · 0 waiting');
	});
});
