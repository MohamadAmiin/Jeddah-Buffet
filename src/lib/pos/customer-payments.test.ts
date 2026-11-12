// fake-indexeddb for THIS file only — the store.test.ts idiom.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { minor } from '../money';
import { saveAgentSettings } from './print-client';
import { flush } from './queue';
import { cacheSettings, countUnsynced, valueOf, withDb, type QueueEntry } from './store';
import { isImageLine, type PrintLine, type TextLine } from './receipt';
import {
	acknowledgeRefusal,
	balanceBefore,
	listCustomerPayments,
	needsAttention,
	pendingFor,
	readCustomerPayment,
	refusalWords,
	startCustomerPayment,
	type StartPaymentArgs
} from './customer-payments';
import { printCustomerPayment, reprintCustomerPayment } from './printing';

// A customer pays at the till (tasks/customer-credit T-19).
//
// MANDATORY (spec 29 — offline sync: retries never create duplicates): a lost
// answer leaves the payment PENDING under its one key, and a second payment for
// that customer cannot be started until it is answered. And the risk-panel
// blocker: the receipt and the drawer wait for the server's yes.

function deleteDatabase(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase('matcami-pos');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

const TOKEN = 'ab'.repeat(32);
const TAP = new Date('2026-09-29T09:00:00Z');
const TAP_MS = TAP.getTime();

beforeEach(async () => {
	await deleteDatabase();
	await saveAgentSettings({ url: 'http://127.0.0.1:9471', token: TOKEN });
	await cacheSettings([
		{ key: 'restaurantName', value: 'Maqaayadda Hodan' },
		{ key: 'receiptAddress', value: null },
		{ key: 'receiptPhone', value: null },
		{ key: 'taxRegistrationNumber', value: null },
		{ key: 'timeZone', value: 'Africa/Mogadishu' },
		{ key: 'deviceCode', value: 'POS1' }
	]);
});

const ALI = { id: 'c-ali', name: 'Ali Hassan', phone: '615000001' };

function args(over: Partial<StartPaymentArgs> = {}): StartPaymentArgs {
	return {
		deviceId: 'device-A',
		employeeId: 'emp-1',
		cashierName: 'Sam',
		posSessionId: 'ses-1',
		online: true,
		customer: ALI,
		method: 'cash',
		paymentMethodId: 'pm-cash',
		methodName: 'Cash',
		amountMinor: minor(2000n),
		tenderedMinor: minor(5000n),
		changeMinor: minor(3000n),
		now: TAP,
		...over
	};
}

async function started(over: Partial<StartPaymentArgs> = {}): Promise<string> {
	const result = await startCustomerPayment(args(over));
	if (!result.ok) throw new Error(result.words);
	return result.clientOpId;
}

function queue(): Promise<QueueEntry[]> {
	return withDb(
		async (db) =>
			(await valueOf(
				db.transaction('sync_queue').objectStore('sync_queue').getAll()
			)) as QueueEntry[]
	);
}

type Posted = { kind: string; clientOpId: string };

/** A sync endpoint answering each op with `answer(envelope)`; every POST is recorded. */
function server(
	answer: (envelope: Posted, call: number) => { status: number; body: unknown } | 'network'
) {
	const posted: Posted[] = [];
	const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
		const envelope = JSON.parse(String(init?.body)) as Posted;
		posted.push(envelope);
		const reply = answer(envelope, posted.length);
		if (reply === 'network') throw new TypeError('Failed to fetch');
		return new Response(JSON.stringify(reply.body), {
			status: reply.status,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof fetch;
	return { fetchFn, posted };
}

const accepted = (balanceAfterMinor: string) =>
	server((envelope) => ({
		status: 200,
		body: { clientOpId: envelope.clientOpId, status: 'accepted', balanceAfterMinor }
	}));

/** Never schedules a retry timer in a test. */
const noRetry = { schedule: () => () => {}, now: () => TAP_MS + 1000 };

type Sent = { path: string; body: Record<string, unknown> };

function stubAgent(over: { drawer?: number } = {}) {
	const sent: Sent[] = [];
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const path = url.slice(url.indexOf('/', 'http://'.length));
		const json = (body: unknown, code: number) =>
			new Response(JSON.stringify(body), {
				status: code,
				headers: { 'content-type': 'application/json' }
			});
		if (path === '/status') {
			return json(
				{
					agentVersion: 1,
					printers: { receipt: { width: 32, reachable: true, queued: 0 }, kitchen: null }
				},
				200
			);
		}
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		sent.push({ path, body });
		if (path === '/jobs') return json({ status: 'queued' }, 202);
		if (path === '/drawer') {
			const code = over.drawer ?? 200;
			return code === 200 ? json({ status: 'opened' }, 200) : json({ error: 'too_late' }, 409);
		}
		return json({ error: 'not_found' }, 404);
	}) as unknown as typeof fetch;
	const jobs = () => sent.filter((s) => s.path === '/jobs');
	const drawers = () => sent.filter((s) => s.path === '/drawer');
	return { fetchFn, jobs, drawers };
}

const textOf = (job: Sent) =>
	(job.body.lines as PrintLine[]).filter((l): l is TextLine => !isImageLine(l)).map((l) => l.text);

describe('startCustomerPayment — the record and the op are one write', () => {
	it('queues ONE customer.payment op carrying its record; it counts as unsynced work', async () => {
		const result = await startCustomerPayment(args());
		expect(result.ok).toBe(true);

		const entries = await queue();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: 'customer.payment',
			state: 'pending',
			deviceId: 'device-A',
			customerPayment: {
				customerName: 'Ali Hassan',
				customerPhone: '615000001',
				methodName: 'Cash',
				cashierName: 'Sam',
				tappedAt: TAP.toISOString()
			}
		});
		expect(entries[0].envelope).toMatchObject({
			kind: 'customer.payment',
			employeeId: 'emp-1',
			occurredAt: TAP.toISOString(),
			payload: {
				customerId: 'c-ali',
				posSessionId: 'ses-1',
				method: 'cash',
				paymentMethodId: 'pm-cash',
				paymentMethodName: 'Cash',
				amountMinor: '2000',
				tenderedMinor: '5000',
				changeMinor: '3000',
				receivedAt: TAP.toISOString()
			}
		});
		// Logout and shift close are blocked while the queue is non-empty (invariant 5).
		expect(await countUnsynced()).toBe(1);

		const [view] = await listCustomerPayments();
		expect(view).toMatchObject({ state: 'pending', balanceAfterMinor: null, refusal: null });
	});

	it('a card or mobile payment carries no tendered or change', async () => {
		await started({ method: 'mobile', methodName: 'EVC Plus', paymentMethodId: 'pm-evc' });
		const [entry] = await queue();
		expect(entry.envelope.payload).toMatchObject({
			method: 'mobile',
			tenderedMinor: null,
			changeMinor: null
		});
	});

	it('is refused, in words, offline, with no shift, or for a non-positive amount — nothing queued', async () => {
		expect(await startCustomerPayment(args({ online: false }))).toEqual({
			ok: false,
			reason: 'offline',
			words: 'Receiving a payment needs a connection'
		});
		expect(await startCustomerPayment(args({ posSessionId: null }))).toMatchObject({
			ok: false,
			reason: 'no_shift'
		});
		expect(await startCustomerPayment(args({ amountMinor: minor(0n) }))).toMatchObject({
			ok: false,
			reason: 'invalid_amount'
		});
		expect(await queue()).toEqual([]);
	});
});

describe('MANDATORY (spec 29) — a lost answer never becomes a second payment', () => {
	it('the response is lost: the payment stays PENDING, and a second one for that customer is refused', async () => {
		const first = await started();
		const lost = server(() => 'network');
		expect((await flush(lost.fetchFn, noRetry)).outcome).toBe('network');

		// To the cashier this must not look like "nothing happened".
		expect((await readCustomerPayment(first))?.state).toBe('pending');
		const again = await startCustomerPayment(args({ now: new Date(TAP_MS + 5000) }));
		expect(again).toEqual({
			ok: false,
			reason: 'pending_for_customer',
			words: 'A payment from Ali Hassan is still waiting for the server'
		});
		expect(await queue()).toHaveLength(1);

		// Another customer is not held up.
		const other = await startCustomerPayment(
			args({ customer: { id: 'c-sara', name: 'Sara', phone: '615000002' } })
		);
		expect(other.ok).toBe(true);
	});

	it('the retry goes out under the SAME key and confirms once, with the server’s balance', async () => {
		const first = await started();
		await flush(server(() => 'network').fetchFn, noRetry);

		const ok = accepted('2400');
		await flush(ok.fetchFn, noRetry);

		expect(ok.posted.map((p) => p.clientOpId)).toEqual([first]);
		const view = await readCustomerPayment(first);
		expect(view).toMatchObject({ state: 'confirmed', balanceAfterMinor: '2400', refusal: null });
		// before = after + amount, by the money module.
		expect(balanceBefore(view!)).toBe(4400n);
		expect(await countUnsynced()).toBe(0);
		// Answered: the customer can pay again.
		expect((await startCustomerPayment(args({ now: new Date(TAP_MS + 60_000) }))).ok).toBe(true);
	});

	it('a replayed answer confirms it just the same', async () => {
		const first = await started();
		await flush(
			server((e) => ({
				status: 200,
				body: { clientOpId: e.clientOpId, status: 'replayed', balanceAfterMinor: '2400' }
			})).fetchFn,
			noRetry
		);
		expect(await readCustomerPayment(first)).toMatchObject({
			state: 'confirmed',
			balanceAfterMinor: '2400'
		});
	});

	it('a database_error is NOT a refusal: the op stays pending under its key and is sent again', async () => {
		const first = await started();
		const failing = server(() => ({
			status: 422,
			body: { error: 'rejected', flag: 'database_error' }
		}));
		expect((await flush(failing.fetchFn, noRetry)).outcome).toBe('network');
		expect((await readCustomerPayment(first))?.state).toBe('pending');

		const ok = accepted('2400');
		await flush(ok.fetchFn, noRetry);
		expect(ok.posted.map((p) => p.clientOpId)).toEqual([first]);
		expect((await readCustomerPayment(first))?.state).toBe('confirmed');
	});
});

describe('a refused payment', () => {
	it('422 with a reason: refused, nothing more is sent — no sale.abandoned — and it stays until acknowledged', async () => {
		const first = await started();
		const refusing = server(() => ({
			status: 422,
			body: { error: 'rejected', flag: 'invalid_payload', detail: 'exceeds_balance' }
		}));
		await flush(refusing.fetchFn, noRetry);

		const view = await readCustomerPayment(first);
		expect(view).toMatchObject({
			state: 'refused',
			refusal: 'exceeds_balance',
			balanceAfterMinor: null
		});
		expect(refusalWords(view!.refusal)).toBe('it is more than the customer owes');
		expect((await queue()).map((e) => e.kind)).toEqual(['customer.payment']);
		expect(await countUnsynced()).toBe(0);

		// On screen until the cashier says the money went back.
		expect(needsAttention(await listCustomerPayments())).toHaveLength(1);
		await acknowledgeRefusal(first, new Date(TAP_MS + 9000));
		expect(needsAttention(await listCustomerPayments())).toEqual([]);
		// A refusal is an answer: the customer may try again.
		expect(pendingFor(await listCustomerPayments(), 'c-ali')).toBeNull();
		expect((await startCustomerPayment(args({ now: new Date(TAP_MS + 10_000) }))).ok).toBe(true);
	});

	it('403: refused as not permitted', async () => {
		const first = await started();
		await flush(server(() => ({ status: 403, body: { error: 'not_permitted' } })).fetchFn, noRetry);
		const view = await readCustomerPayment(first);
		expect(view).toMatchObject({ state: 'refused', refusal: 'not_permitted' });
		expect(refusalWords(view!.refusal)).toBe('this employee may not take payments');
		expect(refusalWords('something-new')).toBe('the server refused it');
	});
});

describe('MANDATORY (risk panel blocker) — the receipt and the drawer wait for the server’s yes', () => {
	const within = { now: () => TAP_MS + 5000 };

	it('PENDING: nothing prints and the drawer stays shut', async () => {
		const first = await started();
		const agent = stubAgent();
		const result = await printCustomerPayment(first, { fetchFn: agent.fetchFn, ...within });
		expect(result).toEqual({
			receipt: { skipped: 'awaiting_confirmation' },
			drawer: 'not_requested'
		});
		expect(agent.jobs()).toEqual([]);
		expect(agent.drawers()).toEqual([]);
	});

	it('REFUSED: nothing prints and the drawer stays shut — a drawer never opens for a payment that was not recorded', async () => {
		const first = await started();
		await flush(
			server(() => ({
				status: 422,
				body: { error: 'rejected', flag: 'invalid_payload', detail: 'exceeds_balance' }
			})).fetchFn,
			noRetry
		);
		const agent = stubAgent();
		const result = await printCustomerPayment(first, { fetchFn: agent.fetchFn, ...within });
		expect(result).toEqual({ receipt: { skipped: 'refused' }, drawer: 'not_requested' });
		expect(agent.jobs()).toEqual([]);
		expect(agent.drawers()).toEqual([]);
	});

	it('CONFIRMED cash: one receipt with the server’s balances, one drawer pulse — and never twice', async () => {
		const first = await started();
		await flush(accepted('2400').fetchFn, noRetry);
		const agent = stubAgent();

		const result = await printCustomerPayment(first, { fetchFn: agent.fetchFn, ...within });
		expect(result).toEqual({ receipt: 'queued', drawer: 'opened' });
		expect(agent.jobs()).toHaveLength(1);
		expect(agent.drawers()).toHaveLength(1);
		expect(agent.drawers()[0].body).toMatchObject({ completedAt: TAP.toISOString() });

		const lines = textOf(agent.jobs()[0]);
		expect(lines.some((l) => l.trim() === 'PAYMENT RECEIVED')).toBe(true);
		expect(lines).toContain('Customer: Ali Hassan');
		expect(lines.some((l) => /^Balance before\s+44\.00$/.test(l))).toBe(true);
		expect(lines.some((l) => /^PAID CASH\s+20\.00$/.test(l))).toBe(true);
		expect(lines.some((l) => /^Tendered\s+50\.00$/.test(l))).toBe(true);
		expect(lines.some((l) => /^Change\s+30\.00$/.test(l))).toBe(true);
		expect(lines.some((l) => /^STILL OWED\s+24\.00$/.test(l))).toBe(true);
		expect(lines.some((l) => /^Cashier\s+Sam$/.test(l))).toBe(true);
		for (const l of lines) expect(l.length).toBeLessThanOrEqual(32);

		// Idempotent: the marks say it was done.
		const again = await printCustomerPayment(first, { fetchFn: agent.fetchFn, ...within });
		expect(again).toEqual({ receipt: 'already_printed', drawer: 'already_opened' });
		expect(agent.jobs()).toHaveLength(1);
		expect(agent.drawers()).toHaveLength(1);
	});

	it('confirmed later than 30 s after the tap: the receipt prints, the drawer does not open', async () => {
		const first = await started();
		await flush(accepted('2400').fetchFn, noRetry);
		const agent = stubAgent();
		const result = await printCustomerPayment(first, {
			fetchFn: agent.fetchFn,
			now: () => TAP_MS + 31_000
		});
		expect(result).toEqual({ receipt: 'queued', drawer: 'too_late' });
		expect(agent.drawers()).toEqual([]);
	});

	it('a card or mobile payment prints and NEVER opens the drawer', async () => {
		const first = await started({
			method: 'mobile',
			methodName: 'EVC Plus',
			paymentMethodId: 'pm'
		});
		await flush(accepted('0').fetchFn, noRetry);
		const agent = stubAgent();
		const result = await printCustomerPayment(first, { fetchFn: agent.fetchFn, ...within });
		expect(result).toEqual({ receipt: 'queued', drawer: 'not_cash' });
		expect(agent.drawers()).toEqual([]);
		const lines = textOf(agent.jobs()[0]);
		expect(lines.some((l) => /^PAID EVC PLUS\s+20\.00$/.test(l))).toBe(true);
		expect(lines.some((l) => /^Tendered|^Change/.test(l))).toBe(false);
		expect(lines.some((l) => /^STILL OWED\s+0\.00$/.test(l))).toBe(true);
	});

	it('a reprint is marked COPY, takes a new job id, and never opens the drawer', async () => {
		const first = await started();
		await flush(accepted('2400').fetchFn, noRetry);
		const agent = stubAgent();
		await printCustomerPayment(first, { fetchFn: agent.fetchFn, ...within });

		const outcome = await reprintCustomerPayment(first, 'Farhiya', {
			fetchFn: agent.fetchFn,
			...within
		});
		expect(outcome).toBe('queued');
		expect(agent.jobs()).toHaveLength(2);
		expect(agent.jobs()[1].body.id).not.toBe(agent.jobs()[0].body.id);
		expect(textOf(agent.jobs()[1]).some((l) => /COPY/.test(l))).toBe(true);
		expect(textOf(agent.jobs()[1]).some((l) => /^Reprint by\s+Farhiya$/.test(l))).toBe(true);
		expect(agent.drawers()).toHaveLength(1);

		// A pending payment cannot be reprinted either.
		const second = await started({
			customer: { id: 'c-sara', name: 'Sara', phone: '615000002' }
		});
		expect(await reprintCustomerPayment(second, 'Farhiya', { fetchFn: agent.fetchFn })).toEqual({
			skipped: 'awaiting_confirmation'
		});
	});
});
