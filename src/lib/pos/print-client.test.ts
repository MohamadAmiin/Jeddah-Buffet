// The unit project runs in `node`, which has no indexedDB: fake-indexeddb
// provides the global for THIS file only. `fetch` is a scripted stub that
// records every request, so the test can read the headers the till sends.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	agentStatus,
	clearAgentSettings,
	DEFAULT_AGENT_URL,
	localNetworkPermission,
	printerChip,
	pulseDrawer,
	readAgentSettings,
	saveAgentSettings,
	submitJob,
	type AgentStatus
} from './print-client';
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

const READY: AgentStatus = {
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

describe('printerChip', () => {
	it('gives each state its glyph, sentence and tone', () => {
		expect(printerChip({ state: 'ready', status: READY })).toEqual({
			glyph: '●',
			text: 'Printer ready · 2 waiting',
			tone: 'ok'
		});
		const idle: AgentStatus = {
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
