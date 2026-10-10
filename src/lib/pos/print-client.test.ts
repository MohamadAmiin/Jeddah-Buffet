// The unit project runs in `node`, which has no indexedDB: fake-indexeddb
// provides the global for THIS file only. `fetch` is a scripted stub that
// records every request, so the test can read the headers the till sends.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	agentPrintsImages,
	agentStatus,
	agentSupports,
	clearAgentSettings,
	DEFAULT_AGENT_URL,
	hasPendingPairing,
	IMAGE_AGENT_VERSION,
	localNetworkPermission,
	parsePairingFragment,
	printerChip,
	printerKeyOf,
	pulseDrawer,
	readAgentSettings,
	requestPairing,
	saveAgentSettings,
	savePrinters,
	stashPairing,
	submitJob,
	takePairing,
	type AgentStatus,
	type ReadyStatus
} from './print-client';
import { confirmReceiptLogo, readConfirmedLogoSha } from './settings';
import { readCachedSetting } from './store';

function deleteDatabase(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase('matcami-pos');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

beforeEach(async () => {
	await deleteDatabase();
});

const TOKEN = 'ab'.repeat(32);
const URL = 'http://127.0.0.1:9471';

const READY: ReadyStatus = {
	agentVersion: 1,
	printers: {
		receipt: { width: 48, reachable: true, queued: 0 },
		kitchen: { width: 32, reachable: true, queued: 2 }
	}
};

type Recorded = { url: string; init: RequestInit };
type Reply = { status: number; body?: unknown } | { throws: Error } | { hang: true };

function stubFetch(replies: Reply[]): { fetchFn: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		const reply = replies.shift();
		if (!reply) throw new Error('unexpected fetch');
		if ('throws' in reply) throw reply.throws;
		if ('hang' in reply) {
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('The operation was aborted.', 'AbortError'))
				);
			});
		}
		return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
			status: reply.status,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof fetch;
	return { fetchFn, calls };
}

const denied = async () => 'denied' as const;
const unknown = async () => 'unknown' as const;

describe('saveAgentSettings', () => {
	it.each([
		['https://evil.example', TOKEN],
		['http://192.168.1.5:9471', TOKEN],
		['http://127.0.0.1:9471/x', TOKEN],
		['http://127.0.0.1:80', TOKEN],
		['http://127.0.0.1:9471', TOKEN.slice(1)],
		['http://127.0.0.1:9471', 'AB'.repeat(32)]
	])('refuses %s with token %s and stores nothing', async (url, token) => {
		await expect(saveAgentSettings({ url, token })).rejects.toThrow();
		expect(await readAgentSettings()).toBeNull();
		expect(await readCachedSetting('printAgentUrl')).toBeUndefined();
		expect(await readCachedSetting('printAgentToken')).toBeUndefined();
	});

	it('accepts a loopback address with a 64-hex token, trims, and clears', async () => {
		await saveAgentSettings({ url: ` ${URL} `, token: `${TOKEN}\n` });
		expect(await readAgentSettings()).toEqual({ url: URL, token: TOKEN });
		await saveAgentSettings({ url: 'http://localhost:9471', token: TOKEN });
		expect(await readAgentSettings()).toEqual({ url: 'http://localhost:9471', token: TOKEN });
		await clearAgentSettings();
		expect(await readAgentSettings()).toBeNull();
		expect(DEFAULT_AGENT_URL).toBe('http://127.0.0.1:9471');
	});

	it('the token never reaches localStorage', () => {
		expect(typeof globalThis.localStorage).toBe('undefined');
	});
});

describe('the pairing and the receipt-logo confirmation (Risk 6)', () => {
	// The confirmation vouches for the printer it was watched on, and the gate
	// cannot tell printers apart: every pairing saved or forgotten withdraws it.
	const SHA = 'a'.repeat(64);
	const OTHER = { url: 'http://localhost:9500', token: 'cd'.repeat(32) };

	it('saving a pairing withdraws it — a first pairing, a new one, and the same one again', async () => {
		for (const settings of [{ url: URL, token: TOKEN }, OTHER, OTHER]) {
			await confirmReceiptLogo(SHA, 'legacy');
			expect(await readConfirmedLogoSha()).toBe(SHA);

			await saveAgentSettings(settings);

			expect(await readConfirmedLogoSha()).toBeNull();
			expect(await readAgentSettings()).toEqual(settings);
		}
	});

	it('Forget pairing withdraws it', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		await confirmReceiptLogo(SHA, 'legacy');

		await clearAgentSettings();

		expect(await readConfirmedLogoSha()).toBeNull();
		expect(await readAgentSettings()).toBeNull();
	});

	it('a refused pairing stores nothing and withdraws nothing', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		await confirmReceiptLogo(SHA, 'legacy');

		await expect(
			saveAgentSettings({ url: 'https://evil.example', token: TOKEN })
		).rejects.toThrow();
		await expect(saveAgentSettings({ url: URL, token: TOKEN.slice(1) })).rejects.toThrow();

		expect(await readConfirmedLogoSha()).toBe(SHA);
		expect(await readAgentSettings()).toEqual({ url: URL, token: TOKEN });
	});
});

describe('the pairing link', () => {
	// The exact shape print-agent/src/main.test.ts asserts pairingLink produces.
	const FRAGMENT = `#agent=http%3A%2F%2F127.0.0.1%3A9471&token=${TOKEN}`;

	it("reads the agent's link, with or without the leading #", () => {
		expect(parsePairingFragment(FRAGMENT)).toEqual({ url: URL, token: TOKEN });
		expect(parsePairingFragment(FRAGMENT.slice(1))).toEqual({ url: URL, token: TOKEN });
		expect(parsePairingFragment(`#token=${TOKEN}&agent=http://localhost:9500`)).toEqual({
			url: 'http://localhost:9500',
			token: TOKEN
		});
	});

	it.each([
		['no fragment', ''],
		['a bare #', '#'],
		['no token', '#agent=http%3A%2F%2F127.0.0.1%3A9471'],
		['no agent', `#token=${TOKEN}`],
		['a short token', `#agent=http%3A%2F%2F127.0.0.1%3A9471&token=${TOKEN.slice(1)}`],
		['an upper-case token', `#agent=http%3A%2F%2F127.0.0.1%3A9471&token=${'AB'.repeat(32)}`],
		['an agent that is not loopback', `#agent=http%3A%2F%2F192.168.1.5%3A9471&token=${TOKEN}`],
		['an https agent elsewhere', `#agent=https%3A%2F%2Fevil.example&token=${TOKEN}`],
		['an agent with a path', `#agent=http%3A%2F%2F127.0.0.1%3A9471%2Fx&token=${TOKEN}`]
	])('%s is null, never a guess', (_, hash) => {
		expect(parsePairingFragment(hash)).toBeNull();
	});

	it('a stashed pairing waits in memory and is handed over once', async () => {
		expect(hasPendingPairing()).toBe(false);
		expect(takePairing()).toBeNull();
		stashPairing({ url: URL, token: TOKEN });
		expect(hasPendingPairing()).toBe(true);
		// Waiting is not pairing: nothing is stored until the owner's screen takes it.
		expect(await readAgentSettings()).toBeNull();
		expect(takePairing()).toEqual({ url: URL, token: TOKEN });
		expect(hasPendingPairing()).toBe(false);
		expect(takePairing()).toBeNull();
	});
});

describe('requestPairing', () => {
	const granted = async () => 'granted' as const;

	it('POSTs /pair with no Authorization header, no cookie and no body, and hands back the settings', async () => {
		const { fetchFn, calls } = stubFetch([{ status: 200, body: { token: TOKEN } }]);
		expect(await requestPairing(URL, fetchFn, granted)).toEqual({
			ok: true,
			settings: { url: URL, token: TOKEN }
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${URL}/pair`);
		expect(calls[0]?.init.method).toBe('POST');
		expect(calls[0]?.init.credentials).toBe('omit');
		expect(calls[0]?.init.headers).toBeUndefined();
		expect(calls[0]?.init.body).toBeUndefined();
		// Asking is not pairing: the caller saves what it was handed.
		expect(await readAgentSettings()).toBeNull();
	});

	it('defaults to the agent on this PC', async () => {
		const { fetchFn, calls } = stubFetch([{ status: 200, body: { token: TOKEN } }]);
		await requestPairing(undefined, fetchFn, granted);
		expect(calls[0]?.url).toBe('http://127.0.0.1:9471/pair');
	});

	it.each([
		['claimed', 'claimed'],
		['not_open', 'closed']
	] as const)('pairing that is %s is refused as %s', async (reason, expected) => {
		const { fetchFn } = stubFetch([{ status: 403, body: { error: 'pairing_closed', reason } }]);
		expect(await requestPairing(URL, fetchFn, granted)).toEqual({ ok: false, reason: expected });
	});

	it('an answer that is not a 64-hex token is refused, never stored', async () => {
		for (const body of [{}, { token: 'short' }, { token: 'AB'.repeat(32) }, { token: 42 }]) {
			const { fetchFn } = stubFetch([{ status: 200, body }]);
			expect(await requestPairing(URL, fetchFn, granted)).toEqual({ ok: false, reason: 'refused' });
		}
		const { fetchFn } = stubFetch([{ status: 403, body: { error: 'bad_origin' } }]);
		expect(await requestPairing(URL, fetchFn, granted)).toEqual({ ok: false, reason: 'refused' });
	});

	it('never asks anything but a loopback agent', async () => {
		const { fetchFn, calls } = stubFetch([]);
		for (const url of ['https://evil.example', 'http://192.168.1.5:9471', 'http://127.0.0.1:80']) {
			expect(await requestPairing(url, fetchFn, granted)).toEqual({ ok: false, reason: 'refused' });
		}
		expect(calls).toHaveLength(0);
	});

	it('no answer is unreachable, and blocked only when Chrome itself said denied', async () => {
		const down = stubFetch([{ throws: new TypeError('Failed to fetch') }]);
		expect(await requestPairing(URL, down.fetchFn, granted)).toEqual({
			ok: false,
			reason: 'unreachable'
		});
		const denied = stubFetch([{ throws: new TypeError('Failed to fetch') }]);
		expect(await requestPairing(URL, denied.fetchFn, async () => 'denied')).toEqual({
			ok: false,
			reason: 'blocked'
		});
	});
});

describe('agentStatus', () => {
	it('is not_set_up without settings, and sends nothing', async () => {
		const { fetchFn, calls } = stubFetch([]);
		expect(await agentStatus(fetchFn, unknown)).toEqual({ state: 'not_set_up' });
		expect(calls).toHaveLength(0);
	});

	it('maps 200 → ready, carrying the token and credentials: omit on the request', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const { fetchFn, calls } = stubFetch([{ status: 200, body: READY }]);
		expect(await agentStatus(fetchFn, unknown)).toEqual({ state: 'ready', status: READY });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(`${URL}/status`);
		expect(calls[0]!.init.method).toBe('GET');
		expect(calls[0]!.init.credentials).toBe('omit');
		expect(calls[0]!.init.mode).toBe('cors');
		expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${TOKEN}`
		);
		expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
	});

	it('returns a version-2 body as ready, exactly as it arrived (print-agent T-25)', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const v2: ReadyStatus = { ...READY, agentVersion: 2 };
		const { fetchFn } = stubFetch([{ status: 200, body: v2 }]);
		expect(await agentStatus(fetchFn, unknown)).toEqual({ state: 'ready', status: v2 });
	});

	it('maps 401 and 403 → unauthorized, 500 → unreachable', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const { fetchFn } = stubFetch([
			{ status: 401, body: { error: 'unauthorized' } },
			{ status: 403, body: { error: 'bad_origin' } },
			{ status: 500, body: { error: 'internal' } }
		]);
		expect(await agentStatus(fetchFn, unknown)).toEqual({ state: 'unauthorized' });
		expect(await agentStatus(fetchFn, unknown)).toEqual({ state: 'unauthorized' });
		expect(await agentStatus(fetchFn, unknown)).toEqual({ state: 'unreachable' });
	});

	it('a TypeError is blocked only when the browser says denied, else unreachable; an abort is unreachable', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const failed = () => new TypeError('Failed to fetch');
		expect(await agentStatus(stubFetch([{ throws: failed() }]).fetchFn, denied)).toEqual({
			state: 'blocked'
		});
		expect(await agentStatus(stubFetch([{ throws: failed() }]).fetchFn, unknown)).toEqual({
			state: 'unreachable'
		});
		expect(
			await agentStatus(
				stubFetch([{ throws: new DOMException('aborted', 'AbortError') }]).fetchFn,
				unknown
			)
		).toEqual({ state: 'unreachable' });
	});
});

describe('submitJob and pulseDrawer', () => {
	const job = {
		id: 'o1:receipt:0',
		printer: 'receipt' as const,
		lines: [{ text: 'Tea' }],
		cut: true
	};

	it('submitJob maps 202 → queued, 200 → duplicate, 422 → { error }, and posts the job as JSON', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const { fetchFn, calls } = stubFetch([
			{ status: 202, body: { status: 'queued' } },
			{ status: 200, body: { status: 'duplicate' } },
			{ status: 422, body: { error: 'bad_job', detail: 'x' } },
			{ status: 500 }
		]);
		expect(await submitJob(job, fetchFn, unknown)).toBe('queued');
		expect(await submitJob(job, fetchFn, unknown)).toBe('duplicate');
		expect(await submitJob(job, fetchFn, unknown)).toEqual({ error: 'bad_job' });
		expect(await submitJob(job, fetchFn, unknown)).toEqual({ error: 'http_500' });
		expect(calls[0]!.url).toBe(`${URL}/jobs`);
		expect(calls[0]!.init.method).toBe('POST');
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual(job);
		expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe(
			'application/json'
		);
		expect(calls[0]!.init.credentials).toBe('omit');
	});

	it('submitJob without settings is { error: not_set_up }; a network failure names blocked or unreachable', async () => {
		expect(await submitJob(job, stubFetch([]).fetchFn, unknown)).toEqual({ error: 'not_set_up' });
		await saveAgentSettings({ url: URL, token: TOKEN });
		expect(
			await submitJob(job, stubFetch([{ throws: new TypeError('x') }]).fetchFn, denied)
		).toEqual({
			error: 'blocked'
		});
		expect(
			await submitJob(job, stubFetch([{ throws: new TypeError('x') }]).fetchFn, unknown)
		).toEqual({
			error: 'unreachable'
		});
	});

	it('pulseDrawer maps 200 opened/duplicate, 409 → too_late, 503 → printer_unreachable', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const args = { id: 'o1:drawer', completedAt: '2026-09-29T09:00:00.000Z' };
		const { fetchFn, calls } = stubFetch([
			{ status: 200, body: { status: 'opened' } },
			{ status: 200, body: { status: 'duplicate' } },
			{ status: 409, body: { error: 'too_late' } },
			{ status: 503, body: { error: 'printer_unreachable' } },
			{ status: 422, body: { error: 'bad_request' } }
		]);
		expect(await pulseDrawer(args, fetchFn, unknown)).toBe('opened');
		expect(await pulseDrawer(args, fetchFn, unknown)).toBe('duplicate');
		expect(await pulseDrawer(args, fetchFn, unknown)).toBe('too_late');
		expect(await pulseDrawer(args, fetchFn, unknown)).toBe('printer_unreachable');
		expect(await pulseDrawer(args, fetchFn, unknown)).toEqual({ error: 'bad_request' });
		expect(calls[0]!.url).toBe(`${URL}/drawer`);
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual(args);
	});

	it('a request that never answers is aborted by the 5 s timeout and reported as unreachable', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const { fetchFn, calls } = stubFetch([{ hang: true }]);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const pending = submitJob(job, fetchFn, unknown);
			// The settings read goes through fake-indexeddb on real setImmediate
			// ticks; wait for the request to be issued before touching the clock.
			for (let i = 0; i < 200 && calls.length === 0; i += 1) {
				await new Promise((r) => setImmediate(r));
			}
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(4_999);
			expect(calls[0]!.init.signal!.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls[0]!.init.signal!.aborted).toBe(true);
			expect(await pending).toEqual({ error: 'unreachable' });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('localNetworkPermission', () => {
	it('is unknown when the Permissions API is missing or every name throws TypeError', async () => {
		expect(await localNetworkPermission()).toBe('unknown');
		const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: {
				permissions: {
					query: async () => {
						throw new TypeError('unknown permission');
					}
				}
			}
		});
		try {
			expect(await localNetworkPermission()).toBe('unknown');
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				value: {
					permissions: {
						query: async ({ name }: { name: string }) => {
							if (name === 'loopback-network') throw new TypeError('unknown');
							return { state: 'denied' };
						}
					}
				}
			});
			expect(await localNetworkPermission()).toBe('denied');
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				value: {
					permissions: {
						query: async () => {
							throw new Error('not a TypeError');
						}
					}
				}
			});
			expect(await localNetworkPermission()).toBe('unknown');
		} finally {
			if (original) Object.defineProperty(globalThis, 'navigator', original);
			else delete (globalThis as { navigator?: unknown }).navigator;
		}
	});
});

describe('agentPrintsImages (T-24)', () => {
	it('is true from version 2 — IMAGE_AGENT_VERSION — and false for 1, a missing version or the string "2"', () => {
		expect(IMAGE_AGENT_VERSION).toBe(2);
		// The status body is an unvalidated cast: a version that is not a number is no version.
		const at = (agentVersion: unknown) =>
			agentPrintsImages({ ...READY, agentVersion } as AgentStatus);
		expect(at(1)).toBe(false);
		expect(at(2)).toBe(true);
		expect(at(3)).toBe(true);
		expect(at(undefined)).toBe(false);
		expect(at(null)).toBe(false);
		expect(at('2')).toBe(false);
	});
});

describe('printerChip', () => {
	it('says when a ready agent is too old to print the cached logo, or the logo still needs its test print (T-24)', () => {
		const v1: ReadyStatus = {
			agentVersion: 1,
			printers: { receipt: { width: 48, reachable: true, queued: 0 }, kitchen: null }
		};
		const v2: ReadyStatus = { ...v1, agentVersion: 2 };
		const tooOld = {
			glyph: '◆',
			text: 'Update the print agent to print the logo',
			tone: 'offline'
		};
		expect(printerChip({ state: 'ready', status: v1 }, { logoCached: true })).toEqual(tooOld);
		expect(
			printerChip({ state: 'ready', status: v1 }, { logoCached: true, logoConfirmed: true })
		).toEqual(tooOld);
		// Jobs waiting are still counted, after the sentence.
		expect(
			printerChip({ state: 'ready', status: READY }, { logoCached: true, logoConfirmed: true })
		).toEqual({
			glyph: '◆',
			text: 'Update the print agent to print the logo · 2 waiting',
			tone: 'offline'
		});
		expect(printerChip({ state: 'ready', status: v2 }, { logoCached: true })).toEqual({
			glyph: '◆',
			text: 'Test-print the logo before receipts use it',
			tone: 'offline'
		});
		expect(
			printerChip(
				{ state: 'ready', status: { ...READY, agentVersion: 2 } },
				{ logoCached: true, logoConfirmed: false }
			)
		).toEqual({
			glyph: '◆',
			text: 'Test-print the logo before receipts use it · 2 waiting',
			tone: 'offline'
		});
		// Ready, as before: no logo cached (whatever the version), or v2 with the logo confirmed.
		const ready = { glyph: '●', text: 'Printer ready', tone: 'ok' };
		expect(printerChip({ state: 'ready', status: v1 })).toEqual(ready);
		expect(printerChip({ state: 'ready', status: v1 }, {})).toEqual(ready);
		expect(printerChip({ state: 'ready', status: v2 }, { logoCached: false })).toEqual(ready);
		expect(
			printerChip({ state: 'ready', status: v2 }, { logoCached: true, logoConfirmed: true })
		).toEqual(ready);
		// The four non-ready states ignore the option.
		for (const state of ['unreachable', 'blocked', 'unauthorized', 'not_set_up'] as const) {
			expect(printerChip({ state }, { logoCached: true })).toEqual(printerChip({ state }));
			expect(printerChip({ state }, { logoCached: true, logoConfirmed: true })).toEqual(
				printerChip({ state })
			);
		}
	});

	it('gives each state its glyph, sentence and tone', () => {
		expect(printerChip({ state: 'ready', status: READY })).toEqual({
			glyph: '●',
			text: 'Printer ready · 2 waiting',
			tone: 'ok'
		});
		const idle: ReadyStatus = {
			agentVersion: 1,
			printers: { receipt: { width: 48, reachable: true, queued: 0 }, kitchen: null }
		};
		expect(printerChip({ state: 'ready', status: idle })).toEqual({
			glyph: '●',
			text: 'Printer ready',
			tone: 'ok'
		});
		expect(printerChip({ state: 'unreachable' })).toEqual({
			glyph: '◆',
			text: 'Printer unreachable',
			tone: 'offline'
		});
		expect(printerChip({ state: 'blocked' })).toEqual({
			glyph: '✕',
			text: 'Printing blocked by Chrome — allow local network access',
			tone: 'danger'
		});
		expect(printerChip({ state: 'unauthorized' })).toEqual({
			glyph: '✕',
			text: 'Printer pairing is wrong — pair again',
			tone: 'danger'
		});
		expect(printerChip({ state: 'not_set_up' })).toEqual({
			glyph: '○',
			text: 'Printer not set up',
			tone: 'neutral'
		});
	});
});

// ── tasks/print-agent-installer T-14 ────────────────────────────────────────

const NEW_AGENT: ReadyStatus = {
	agentVersion: 2,
	features: ['printers', 'setup'],
	printers: {
		receipt: { host: '192.168.1.50', port: 9100, width: 48, reachable: true, queued: 0 },
		kitchen: null
	}
};

describe('agentStatus validates the body (print-agent-installer T-14)', () => {
	it('an agent with no printer yet is no_printer, and its chip says what to do', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const body = {
			agentVersion: 2,
			features: ['printers', 'setup'],
			printers: { receipt: null, kitchen: null }
		};
		const state = await agentStatus(stubFetch([{ status: 200, body }]).fetchFn, unknown);
		expect(state).toEqual({ state: 'no_printer', status: body });
		expect(printerChip(state)).toEqual({
			glyph: '◆',
			text: 'Printer address not set — open Printer',
			tone: 'offline'
		});
	});

	it('a garbled body is unreachable — it never reaches the chip', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		for (const body of [
			{ printers: 'x' },
			{ agentVersion: 2 },
			{
				agentVersion: 2,
				printers: { receipt: { width: 40, reachable: true, queued: 0 }, kitchen: null }
			},
			{ agentVersion: 2, printers: { receipt: { width: 48 }, kitchen: null } },
			{ agentVersion: 2, printers: { receipt: READY.printers.receipt, kitchen: { width: 48 } } }
		]) {
			expect(await agentStatus(stubFetch([{ status: 200, body }]).fetchFn, unknown)).toEqual({
				state: 'unreachable'
			});
		}
	});

	it('an older agent (no features, no host) is still ready', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const state = await agentStatus(stubFetch([{ status: 200, body: READY }]).fetchFn, unknown);
		expect(state).toEqual({ state: 'ready', status: READY });
	});
});

describe('agentSupports and printerKeyOf', () => {
	it('features are read only from an array', () => {
		expect(agentSupports(NEW_AGENT, 'printers')).toBe(true);
		expect(agentSupports(NEW_AGENT, 'setup')).toBe(true);
		expect(agentSupports(READY, 'printers')).toBe(false);
	});

	it('names the receipt printer: host:port:width, legacy for an older agent, null with no printer', () => {
		expect(printerKeyOf(NEW_AGENT)).toBe('192.168.1.50:9100:48');
		expect(printerKeyOf(READY)).toBe('legacy');
		expect(printerKeyOf({ ...NEW_AGENT, printers: { receipt: null, kitchen: null } })).toBeNull();
		// Claims the feature but reports no address: a key that matches nothing.
		expect(
			printerKeyOf({
				...NEW_AGENT,
				printers: { receipt: { width: 48, reachable: true, queued: 0 }, kitchen: null }
			})
		).toBeNull();
	});
});

describe('savePrinters', () => {
	const printers = {
		receipt: { host: '192.168.1.60', port: 9100, width: 32 as const },
		kitchen: null
	};

	it('sends PUT /printers with the token, no cookie, and the printers as JSON', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const { fetchFn, calls } = stubFetch([{ status: 200, body: { printers: {} } }]);
		expect(await savePrinters(NEW_AGENT, printers, fetchFn, unknown)).toBe('saved');
		expect(calls[0]!.url).toBe(`${URL}/printers`);
		expect(calls[0]!.init.method).toBe('PUT');
		expect(calls[0]!.init.credentials).toBe('omit');
		expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${TOKEN}`
		);
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual(printers);
	});

	it('maps 409 jobs_waiting, 422 bad_printers and 401 to their errors', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const { fetchFn } = stubFetch([
			{ status: 409, body: { error: 'jobs_waiting', target: 'kitchen', queued: 3 } },
			{ status: 422, body: { error: 'bad_printers', field: 'receipt.host' } },
			{ status: 401, body: { error: 'unauthorized' } }
		]);
		expect(await savePrinters(NEW_AGENT, printers, fetchFn, unknown)).toEqual({
			error: 'jobs_waiting',
			target: 'kitchen',
			queued: 3
		});
		expect(await savePrinters(NEW_AGENT, printers, fetchFn, unknown)).toEqual({
			error: 'bad_printers',
			field: 'receipt.host'
		});
		expect(await savePrinters(NEW_AGENT, printers, fetchFn, unknown)).toEqual({
			error: 'unauthorized'
		});
	});

	it('never sends to an older agent: unsupported, with no request at all', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const { fetchFn, calls } = stubFetch([]);
		expect(await savePrinters(READY, printers, fetchFn, unknown)).toEqual({ error: 'unsupported' });
		expect(calls).toHaveLength(0);
	});

	it('a 403 (an agent built for another address) is unauthorized; a failed fetch is unreachable or blocked', async () => {
		await saveAgentSettings({ url: URL, token: TOKEN });
		const { fetchFn } = stubFetch([
			{ status: 403, body: { error: 'bad_origin' } },
			{ throws: new TypeError('Failed to fetch') },
			{ throws: new TypeError('Failed to fetch') }
		]);
		expect(await savePrinters(NEW_AGENT, printers, fetchFn, unknown)).toEqual({
			error: 'unauthorized'
		});
		expect(await savePrinters(NEW_AGENT, printers, fetchFn, unknown)).toEqual({
			error: 'unreachable'
		});
		expect(await savePrinters(NEW_AGENT, printers, fetchFn, denied)).toEqual({ error: 'blocked' });
	});
});
