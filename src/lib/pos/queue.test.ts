import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	bindDevice,
	cacheEmployees,
	countUnsynced,
	recordOfflineLogin,
	readCachedEmployees,
	readBoundDeviceId,
	withDb,
	type LocalOrder,
	type OfflineLogin,
	type QueueEntry
} from './store';
import {
	DeviceRevoked,
	flush,
	lastSkewMs,
	onFlushEvent,
	onFlushResult,
	parkedCount,
	type FlushEvent,
	type FlushOptions
} from './queue';
import { addLine, completeSale, newCart, type Cart, type MenuItemForCart } from './orders';

const NOW_MS = Date.parse('2026-09-28T10:00:00Z');
const NOW = new Date(NOW_MS);

function deleteDatabase(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase('matcami-pos');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

const tea: MenuItemForCart = {
	id: 'item-tea',
	name: 'Tea',
	priceMinor: 850n
};

beforeEach(async () => {
	await deleteDatabase();
});

type ScriptedReply =
	{ kind: 'response'; status: number; body: unknown; date?: string } | { kind: 'network' };

function makeMockFetch(script: ScriptedReply[]): {
	fetchFn: typeof fetch;
	bodies: unknown[];
	remaining: () => number;
} {
	const bodies: unknown[] = [];
	let index = 0;
	const fetchFn = (async (_url: string | URL, init?: { body?: BodyInit | null }) => {
		const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
		bodies.push(parsedBody);
		const reply = script[index++];
		if (!reply) throw new Error(`no scripted reply for request #${bodies.length}`);
		if (reply.kind === 'network') throw new TypeError('Failed to fetch');
		return new Response(JSON.stringify(reply.body ?? null), {
			status: reply.status,
			headers: {
				'content-type': 'application/json',
				...(reply.date ? { date: reply.date } : {})
			}
		});
	}) as unknown as typeof fetch;
	return { fetchFn, bodies, remaining: () => script.length - index };
}

async function seedSale(deviceCode: string, invoiceSeq = 1): Promise<string> {
	let cart = newCart('device-A', 'takeaway', null, NOW);
	cart = addLine(cart, tea, { id: null, name: null, rateBp: 1000 });
	const result = await completeSale({
		cart,
		payment: {
			method: 'cash',
			tenderedMinor: 5000n,
			paymentMethodId: null,
			paymentMethodName: null
		},
		employeeId: 'emp-1',
		deviceId: 'device-A',
		deviceCode,
		posSessionId: 'ses-1',
		taxMode: 'exclusive',
		currencyCode: 'USD',
		menuVersion: 1,
		now: NOW,
		cashierName: 'Sam',
		businessDate: '2026-09-28'
	});
	expect(result.invoiceNumber).toBe(`${deviceCode}-${String(invoiceSeq).padStart(6, '0')}`);
	return result.clientOpId;
}

async function readQueue(): Promise<QueueEntry[]> {
	return withDb(async (db) => {
		return new Promise<QueueEntry[]>((resolve, reject) => {
			const request = db.transaction('sync_queue').objectStore('sync_queue').getAll();
			request.onsuccess = () => resolve(request.result as QueueEntry[]);
			request.onerror = () => reject(request.error);
		});
	});
}

async function readOrders(): Promise<LocalOrder<Cart>[]> {
	return withDb(async (db) => {
		return new Promise<LocalOrder<Cart>[]>((resolve, reject) => {
			const request = db.transaction('orders').objectStore('orders').getAll();
			request.onsuccess = () => resolve(request.result as LocalOrder<Cart>[]);
			request.onerror = () => reject(request.error);
		});
	});
}

async function readLogins(): Promise<OfflineLogin[]> {
	return withDb(async (db) => {
		return new Promise<OfflineLogin[]>((resolve, reject) => {
			const request = db.transaction('offline_logins').objectStore('offline_logins').getAll();
			request.onsuccess = () => resolve(request.result as OfflineLogin[]);
			request.onerror = () => reject(request.error);
		});
	});
}

function schedulerStub(): {
	schedule: NonNullable<FlushOptions['schedule']>;
	pending: Array<{ delay: number; run: () => void; cancelled: boolean }>;
} {
	const pending: Array<{ delay: number; run: () => void; cancelled: boolean }> = [];
	const schedule = (delay: number, run: () => void) => {
		const entry = { delay, run, cancelled: false };
		pending.push(entry);
		return () => {
			entry.cancelled = true;
		};
	};
	return { schedule, pending };
}

describe('flush — the basics', () => {
	it('MANDATORY (spec 29): a network failure then a retry keeps the same clientOpId', async () => {
		const clientOpId = await seedSale('POS1');
		const { schedule, pending } = schedulerStub();
		const { fetchFn, bodies } = makeMockFetch([
			{ kind: 'network' },
			{ kind: 'response', status: 200, body: { clientOpId, status: 'accepted' } }
		]);
		const first = await flush(fetchFn, { schedule, now: () => NOW_MS });
		expect(first.outcome).toBe('network');
		expect(pending).toHaveLength(1);
		expect(pending[0].delay).toBe(2000);
		expect((await readQueue())[0]).toMatchObject({
			state: 'pending',
			attempts: 1
		});
		const second = await flush(fetchFn, { now: () => NOW_MS });
		expect(second.outcome).toBe('drained');
		expect(second.sent).toBe(1);
		expect(bodies).toHaveLength(2);
		const first_body = bodies[0] as { clientOpId: string; payload: { invoiceNumber: string } };
		const second_body = bodies[1] as { clientOpId: string; payload: { invoiceNumber: string } };
		expect(second_body.clientOpId).toBe(first_body.clientOpId);
		expect(second_body.payload.invoiceNumber).toBe('POS1-000001');
		const queue = await readQueue();
		expect(queue).toHaveLength(1);
		expect(queue[0].state).toBe('done');
		const orders = await readOrders();
		expect(orders[0].syncStatus).toBe('accepted');
		expect(orders[0].syncedAt).toBeTruthy();
	});

	it('sends entries in seq order and resumes at the same one', async () => {
		const first = await seedSale('POS1', 1);
		const second = await seedSale('POS1', 2);
		const third = await seedSale('POS1', 3);
		const { schedule } = schedulerStub();
		const { fetchFn, bodies } = makeMockFetch([
			{ kind: 'response', status: 200, body: { clientOpId: first, status: 'accepted' } },
			{ kind: 'network' }
		]);
		const summary = await flush(fetchFn, { schedule, now: () => NOW_MS });
		expect(summary.outcome).toBe('network');
		const seqs = bodies.map((b) => (b as { payload: { invoiceSeq: number } }).payload.invoiceSeq);
		expect(seqs).toEqual([1, 2]);
		// The middle entry is still pending with the same clientOpId.
		const queue = await readQueue();
		const secondEntry = queue.find((q) => q.clientOpId === second)!;
		expect(secondEntry.state).toBe('pending');

		const scriptTwo = [
			{ kind: 'response', status: 200, body: { clientOpId: second, status: 'accepted' } },
			{ kind: 'response', status: 200, body: { clientOpId: third, status: 'accepted' } }
		] as ScriptedReply[];
		const second_mock = makeMockFetch(scriptTwo);
		const cont = await flush(second_mock.fetchFn, { now: () => NOW_MS });
		expect(cont.outcome).toBe('drained');
		expect(cont.sent).toBe(2);
		const seqs2 = second_mock.bodies.map(
			(b) => (b as { payload: { invoiceSeq: number } }).payload.invoiceSeq
		);
		expect(seqs2).toEqual([2, 3]);
	});
});

describe('flush — the order is marked synced before done is announced (T-30)', () => {
	it('a listener reading the order row on the done event sees syncStatus accepted', async () => {
		const clientOpId = await seedSale('POS1');
		const { fetchFn } = makeMockFetch([
			{ kind: 'response', status: 200, body: { clientOpId, status: 'accepted' } }
		]);
		let seen: LocalOrder<Cart>['syncStatus'] | 'no-event' = 'no-event';
		const pending: Promise<void>[] = [];
		const stop = onFlushEvent((event) => {
			if (event.type !== 'done' || event.clientOpId !== clientOpId) return;
			pending.push(
				readOrders().then((orders) => {
					seen = orders[0].syncStatus;
				})
			);
		});
		await flush(fetchFn, { now: () => NOW_MS });
		await Promise.all(pending);
		stop();
		expect(seen).toBe('accepted');
	});
});

describe('flush — offline logins first', () => {
	it('sends every pin.login row before any sale', async () => {
		await recordOfflineLogin({
			clientOpId: 'op-login-1',
			deviceId: 'device-OLD',
			employeeId: 'emp-1',
			event: 'pos.pin.success',
			occurredAt: '2026-09-28T09:00:00.000Z',
			outcome: 'success',
			synced: false
		});
		await seedSale('POS1');
		const { fetchFn, bodies } = makeMockFetch([
			{ kind: 'response', status: 200, body: { clientOpId: 'op-login-1', status: 'accepted' } },
			{ kind: 'response', status: 200, body: { status: 'accepted' } }
		]);
		const summary = await flush(fetchFn, { now: () => NOW_MS });
		expect(summary.outcome).toBe('drained');
		expect(summary.sent).toBe(2);
		expect((bodies[0] as { kind: string }).kind).toBe('pin.login');
		expect((bodies[1] as { kind: string }).kind).toBe('sale.complete');
		const logins = await readLogins();
		expect(logins[0].synced).toBe(true);
		expect(await countUnsynced()).toBe(0);
	});
});

describe('flush — parking and rejects', () => {
	it('409 foreign_device parks the entry and continues', async () => {
		const a = await seedSale('POS1', 1);
		const b = await seedSale('POS1', 2);
		const { fetchFn } = makeMockFetch([
			{ kind: 'response', status: 409, body: { error: 'foreign_device' } },
			{ kind: 'response', status: 200, body: { clientOpId: b, status: 'accepted' } }
		]);
		let parked: FlushEvent | null = null;
		const stop = onFlushEvent((e) => {
			if (e.type === 'parked') parked = e;
		});
		const summary = await flush(fetchFn, { now: () => NOW_MS });
		stop();
		expect(summary.outcome).toBe('drained');
		expect(await parkedCount()).toBe(1);
		expect(await countUnsynced()).toBe(0);
		expect(parked).not.toBeNull();
		const queue = await readQueue();
		const parkedRow = queue.find((q) => q.clientOpId === a)!;
		expect(parkedRow.state).toBe('parked');
	});

	it('plain 403 (Forbidden) forgets the device and throws DeviceRevoked', async () => {
		await bindDevice('device-A');
		await cacheEmployees([
			{
				id: 'emp-1',
				displayName: 'Sam',
				isOwner: false,
				roleName: 'Cashier',
				permissions: [],
				isActive: true,
				pinPhc: null
			}
		]);
		await seedSale('POS1');
		const { fetchFn, bodies } = makeMockFetch([{ kind: 'response', status: 403, body: null }]);
		await expect(flush(fetchFn, { now: () => NOW_MS })).rejects.toBeInstanceOf(DeviceRevoked);
		expect(await readBoundDeviceId()).toBeNull();
		expect(await readCachedEmployees()).toEqual([]);
		expect(bodies).toHaveLength(1);
	});

	it('403 not_permitted on a card sale abandons it and sends the abandon in the same run', async () => {
		let cart = newCart('device-A', 'takeaway', null, NOW);
		cart = addLine(cart, tea, { id: null, name: null, rateBp: 1000 });
		const sale = await completeSale({
			cart,
			payment: {
				method: 'card',
				tenderedMinor: null,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const { fetchFn, bodies } = makeMockFetch([
			{ kind: 'response', status: 403, body: { error: 'not_permitted' } },
			{ kind: 'response', status: 200, body: { status: 'accepted' } }
		]);
		const summary = await flush(fetchFn, { now: () => NOW_MS });
		expect(summary.outcome).toBe('drained');
		expect((bodies[1] as { kind: string }).kind).toBe('sale.abandoned');
		const orders = await readOrders();
		expect(orders[0].state).toBe('abandoned');
		expect(orders[0].syncStatus).toBe('rejected');
		expect(sale.clientOpId).toBeTruthy();
	});

	it('422 rejected on a card sale emits rejected with http 422 and the flag', async () => {
		let cart = newCart('device-A', 'takeaway', null, NOW);
		cart = addLine(cart, tea, { id: null, name: null, rateBp: 1000 });
		await completeSale({
			cart,
			payment: {
				method: 'card',
				tenderedMinor: null,
				paymentMethodId: null,
				paymentMethodName: null
			},
			employeeId: 'emp-1',
			deviceId: 'device-A',
			deviceCode: 'POS1',
			posSessionId: 'ses-1',
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			now: NOW,
			cashierName: 'Sam',
			businessDate: '2026-09-28'
		});
		const { fetchFn } = makeMockFetch([
			{
				kind: 'response',
				status: 422,
				body: { error: 'rejected', flag: 'price_tamper' }
			},
			{ kind: 'response', status: 200, body: { status: 'accepted' } }
		]);
		let rejected: FlushEvent | null = null;
		const stop = onFlushResult((e) => {
			if (e.type === 'rejected') rejected = e;
		});
		await flush(fetchFn, { now: () => NOW_MS });
		stop();
		expect(rejected).toMatchObject({
			type: 'rejected',
			kind: 'sale.complete',
			http: 422,
			flag: 'price_tamper'
		});
	});
});

describe('flush — skew and single-flight', () => {
	it('a 200 response with a future date emits a skew event; lastSkewMs reflects it', async () => {
		await seedSale('POS1');
		const { fetchFn } = makeMockFetch([
			{
				kind: 'response',
				status: 200,
				body: { status: 'accepted' },
				date: 'Mon, 28 Sep 2026 10:05:00 GMT'
			}
		]);
		let skew: FlushEvent | null = null;
		const stop = onFlushEvent((e) => {
			if (e.type === 'skew') skew = e;
		});
		await flush(fetchFn, { now: () => NOW_MS });
		stop();
		expect(skew).toMatchObject({ type: 'skew', skewMs: 300_000 });
		expect(lastSkewMs()).toBe(300_000);
	});

	it('two concurrent flush() calls return the SAME promise', async () => {
		await seedSale('POS1');
		const { fetchFn } = makeMockFetch([
			{ kind: 'response', status: 200, body: { status: 'accepted' } }
		]);
		const a = flush(fetchFn, { now: () => NOW_MS });
		const b = flush(fetchFn, { now: () => NOW_MS });
		expect(a).toBe(b);
		await a;
	});
});
