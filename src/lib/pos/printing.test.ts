// The unit project runs in `node`, which has no indexedDB: fake-indexeddb
// provides the global for THIS file only. Orders are created by the REAL
// completeSale, the agent is a stub fetch that records every request, and the
// clock is injected where the drawer window and the catch-up window matter.
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	abandonSale,
	addLine,
	completeSale,
	newCart,
	type Cart,
	type MenuItemForCart
} from './orders';
import { saveAgentSettings } from './print-client';
import {
	CATCH_UP_WINDOW_MS,
	catchUp,
	listRecentSales,
	printOriginals,
	readOrder,
	readReceiptHeader,
	reprint,
	reprintRefusal,
	saleStatusMark,
	startAutoPrint
} from './printing';
import { flush } from './queue';
import { cacheSettings, withDb, type LocalOrder } from './store';

function deleteDatabase(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase('matcami-pos');
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

const TOKEN = 'ab'.repeat(32);
const NOW_MS = Date.parse('2026-09-29T09:00:00Z');

const tea: MenuItemForCart = { id: 'item-tea', name: 'Tea', priceMinor: 850n, taxRateBp: 1000 };

beforeEach(async () => {
	await deleteDatabase();
	await saveAgentSettings({ url: 'http://127.0.0.1:9471', token: TOKEN });
	await cacheSettings([
		{ key: 'restaurantName', value: 'Maqaayadda Hodan' },
		{ key: 'receiptAddress', value: 'Makka Al-Mukarama Rd, Km4' },
		{ key: 'receiptPhone', value: null },
		{ key: 'taxRegistrationNumber', value: null },
		{ key: 'receiptFooter', value: 'Mahadsanid!' },
		{ key: 'timeZone', value: 'Africa/Mogadishu' },
		{ key: 'deviceCode', value: 'POS1' }
	]);
});

// ── A stub agent ────────────────────────────────────────────────────────────

type Sent = { path: string; body: Record<string, unknown> };

function stubAgent(over: { kitchen?: boolean; drawer?: number } = {}) {
	const sent: Sent[] = [];
	const status = {
		agentVersion: 1,
		printers: {
			receipt: { width: 48, reachable: true, queued: 0 },
			kitchen: over.kitchen === false ? null : { width: 32, reachable: true, queued: 0 }
		}
	};
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const path = url.slice(url.indexOf('/', 'http://'.length));
		const json = (body: unknown, code: number) =>
			new Response(JSON.stringify(body), {
				status: code,
				headers: { 'content-type': 'application/json' }
			});
		if (path === '/status') return json(status, 200);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		sent.push({ path, body });
		if (path === '/jobs') return json({ status: 'queued' }, 202);
		if (path === '/drawer') {
			const code = over.drawer ?? 200;
			if (code === 200) return json({ status: 'opened' }, 200);
			if (code === 409) return json({ error: 'too_late' }, 409);
			return json({ error: 'printer_unreachable' }, 503);
		}
		return json({ error: 'not_found' }, 404);
	}) as unknown as typeof fetch;
	const jobs = () => sent.filter((s) => s.path === '/jobs');
	const drawers = () => sent.filter((s) => s.path === '/drawer');
	const ids = () => sent.map((s) => s.body.id as string);
	return { fetchFn, sent, jobs, drawers, ids };
}

// ── Orders through the real completeSale ────────────────────────────────────

async function sell(
	method: 'cash' | 'card' | 'mobile',
	over: { now?: Date; deviceId?: string; orderType?: 'dine_in' | 'takeaway' | 'delivery' } = {}
) {
	const deviceId = over.deviceId ?? 'device-A';
	let cart = newCart(deviceId, over.orderType ?? 'takeaway', null, over.now ?? new Date(NOW_MS));
	cart = addLine(cart, tea, 1000);
	return completeSale({
		cart,
		payment: { method, tenderedMinor: method === 'cash' ? 1000n : null },
		employeeId: 'emp-1',
		deviceId,
		deviceCode: 'POS1',
		posSessionId: 'ses-1',
		taxMode: 'exclusive',
		currencyCode: 'USD',
		menuVersion: 1,
		now: over.now ?? new Date(NOW_MS),
		cashierName: 'Amina',
		businessDate: '2026-09-29'
	});
}

async function setSync(orderId: string, syncStatus: LocalOrder<Cart>['syncStatus']) {
	await withDb(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction('orders', 'readwrite');
				const store = tx.objectStore('orders');
				const request = store.get(orderId);
				request.onsuccess = () => {
					store.put({ ...(request.result as LocalOrder<Cart>), syncStatus, syncedAt: 'x' });
				};
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			})
	);
}

const textOf = (job: Sent) =>
	(job.body.lines as Array<{ text: string }>).map((l) => l.text).join('\n');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('printOriginals', () => {
	it('MANDATORY (invariant 5 — fail closed): a pending card sale sends NOTHING; once accepted it prints both and never the drawer', async () => {
		const agent = stubAgent();
		const { orderId } = await sell('card');
		const pending = await printOriginals(orderId, { drawer: true, fetchFn: agent.fetchFn });
		expect(pending).toEqual({
			receipt: { skipped: 'awaiting_confirmation' },
			kitchen: { skipped: 'awaiting_confirmation' },
			drawer: { skipped: 'awaiting_confirmation' }
		});
		expect(agent.sent).toHaveLength(0);

		await setSync(orderId, 'accepted');
		const printed = await printOriginals(orderId, { drawer: true, fetchFn: agent.fetchFn });
		expect(printed.receipt).toBe('queued');
		expect(printed.kitchen).toBe('queued');
		expect(printed.drawer).toBe('not_cash');
		expect(agent.ids()).toEqual([`${orderId}:receipt:0`, `${orderId}:kitchen:0`]);
		expect(agent.drawers()).toHaveLength(0);
		expect(textOf(agent.jobs()[0]!)).toContain('CARD');
	});

	it('a cash sale prints the receipt and the kitchen ticket and pulses the drawer once; a second call sends nothing', async () => {
		const agent = stubAgent();
		const { orderId, invoiceNumber } = await sell('cash');
		const now = () => NOW_MS + 5_000;
		const result = await printOriginals(orderId, { drawer: true, fetchFn: agent.fetchFn, now });
		expect(result).toEqual({ receipt: 'queued', kitchen: 'queued', drawer: 'opened' });
		expect(agent.ids()).toEqual([
			`${orderId}:receipt:0`,
			`${orderId}:kitchen:0`,
			`${orderId}:drawer`
		]);
		const receipt = agent.jobs()[0]!;
		expect(receipt.body.printer).toBe('receipt');
		expect(receipt.body.cut).toBe(true);
		const tape = textOf(receipt);
		expect(tape).toContain('Maqaayadda Hodan');
		expect(tape).toContain(invoiceNumber);
		expect(tape).toContain('Mahadsanid!');
		expect(tape).toContain('Business date');
		for (const line of receipt.body.lines as Array<{ text: string }>) {
			expect(line.text.length).toBeLessThanOrEqual(48);
		}
		const kitchen = agent.jobs()[1]!;
		expect(kitchen.body.printer).toBe('kitchen');
		for (const line of kitchen.body.lines as Array<{ text: string; size?: string }>) {
			expect(line.text.length).toBeLessThanOrEqual(line.size === 'double' ? 16 : 32);
		}
		expect(agent.drawers()[0]!.body).toEqual({
			id: `${orderId}:drawer`,
			completedAt: new Date(NOW_MS).toISOString()
		});
		const order = await readOrder(orderId);
		expect(order?.printed?.receiptAt).toBeTruthy();
		expect(order?.printed?.kitchenAt).toBeTruthy();
		expect(order?.printed?.drawerAt).toBeTruthy();

		const again = await printOriginals(orderId, { drawer: true, fetchFn: agent.fetchFn, now });
		expect(again).toEqual({
			receipt: 'already_printed',
			kitchen: 'already_printed',
			drawer: 'already_opened'
		});
		expect(agent.sent).toHaveLength(3);
	});

	it('a cash sale completed 31 s ago prints both tickets and sends NO drawer request', async () => {
		const agent = stubAgent();
		const { orderId } = await sell('cash');
		const result = await printOriginals(orderId, {
			drawer: true,
			fetchFn: agent.fetchFn,
			now: () => NOW_MS + 31_000
		});
		expect(result).toEqual({ receipt: 'queued', kitchen: 'queued', drawer: 'too_late' });
		expect(agent.drawers()).toHaveLength(0);
		expect((await readOrder(orderId))?.printed?.drawerAt).toBeUndefined();
	});

	it('without the drawer flag, a cash original never pulses; the agent answers are surfaced', async () => {
		const agent = stubAgent({ drawer: 503 });
		const { orderId } = await sell('cash');
		const quiet = await printOriginals(orderId, {
			drawer: false,
			fetchFn: agent.fetchFn,
			now: () => NOW_MS
		});
		expect(quiet.drawer).toBe('not_requested');
		expect(agent.drawers()).toHaveLength(0);
		const { orderId: second } = await sell('cash');
		const down = await printOriginals(second, {
			drawer: true,
			fetchFn: agent.fetchFn,
			now: () => NOW_MS
		});
		expect(down.drawer).toBe('printer_unreachable');
		expect((await readOrder(second))?.printed?.drawerAt).toBeUndefined();
	});

	it('an agent that is not ready prints nothing and names the state; a kitchen job goes to the receipt width when there is no kitchen printer', async () => {
		const { orderId } = await sell('cash');
		const down = (async () => {
			throw new TypeError('Failed to fetch');
		}) as unknown as typeof fetch;
		expect(await printOriginals(orderId, { drawer: true, fetchFn: down })).toEqual({
			receipt: { error: 'unreachable' },
			kitchen: { error: 'unreachable' },
			drawer: { error: 'unreachable' }
		});
		const agent = stubAgent({ kitchen: false });
		await printOriginals(orderId, { drawer: false, fetchFn: agent.fetchFn });
		const kitchen = agent.jobs()[1]!;
		expect(kitchen.body.printer).toBe('kitchen');
		expect((kitchen.body.lines as Array<{ text: string }>).some((l) => l.text.length > 32)).toBe(
			true
		);
	});
});

describe('reprint', () => {
	it('numbers reprints r1, r2 with the COPY banner first, never pulses the drawer, and refuses a pending card sale', async () => {
		const agent = stubAgent();
		const { orderId } = await sell('cash');
		expect(await reprint(orderId, 'receipt', 'Amina', { fetchFn: agent.fetchFn })).toBe('queued');
		expect(await reprint(orderId, 'kitchen', 'Amina', { fetchFn: agent.fetchFn })).toBe('queued');
		expect(agent.ids()).toEqual([`${orderId}:receipt:r1`, `${orderId}:kitchen:r2`]);
		const first = textOf(agent.jobs()[0]!).split('\n');
		expect(first[0]).toMatch(/^\*+$/);
		expect(first[1]).toContain('COPY');
		expect(textOf(agent.jobs()[1]!)).toContain('*** COPY ***');
		expect(agent.drawers()).toHaveLength(0);
		expect((await readOrder(orderId))?.printed?.reprints).toBe(2);

		const { orderId: card } = await sell('card');
		expect(await reprint(card, 'receipt', 'Amina', { fetchFn: agent.fetchFn })).toEqual({
			skipped: 'awaiting_confirmation'
		});
		expect(agent.sent).toHaveLength(2);
	});
});

describe('startAutoPrint and the catch-up', () => {
	it("a 'done' for a card sale prints it (no drawer); a 'done' for a cash sale prints nothing new", async () => {
		const agent = stubAgent();
		const cash = await sell('cash');
		const card = await sell('card');
		const stop = startAutoPrint({ fetchFn: agent.fetchFn, now: () => NOW_MS + 60 * 60 * 1000 });
		// The catch-up ran with a clock an hour later: both sales are too old for it.
		await new Promise((r) => setTimeout(r, 50));
		expect(agent.sent).toHaveLength(0);

		const server = (async (_url: string, init?: RequestInit) => {
			const envelope = JSON.parse(String(init?.body)) as { clientOpId: string };
			return new Response(JSON.stringify({ clientOpId: envelope.clientOpId, status: 'accepted' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as unknown as typeof fetch;
		await flush(server, { now: () => NOW_MS });
		await new Promise((r) => setTimeout(r, 100));
		expect(agent.ids()).toEqual([`${card.orderId}:receipt:0`, `${card.orderId}:kitchen:0`]);
		expect(agent.drawers()).toHaveLength(0);
		expect((await readOrder(cash.orderId))?.printed).toBeUndefined();
		stop();
	});

	it('the catch-up prints a 2-minute-old cash sale with no marks — without the drawer — and ignores an 11-minute-old one', async () => {
		const agent = stubAgent();
		const recent = await sell('cash', { now: new Date(NOW_MS - 2 * 60 * 1000) });
		const old = await sell('cash', { now: new Date(NOW_MS - 11 * 60 * 1000) });
		const printed = await catchUp({ fetchFn: agent.fetchFn, now: () => NOW_MS });
		expect(printed).toEqual([recent.orderId]);
		expect(agent.ids()).toEqual([`${recent.orderId}:receipt:0`, `${recent.orderId}:kitchen:0`]);
		expect(agent.drawers()).toHaveLength(0);
		expect((await readOrder(old.orderId))?.printed).toBeUndefined();
		expect(CATCH_UP_WINDOW_MS).toBe(600_000);
	});
});

describe('listRecentSales and saleStatusMark (T-31)', () => {
	it("lists only this device's completed and abandoned sales, newest first, at most limit", async () => {
		const first = await sell('cash', { now: new Date(NOW_MS - 3000) });
		const second = await sell('card', { now: new Date(NOW_MS - 2000) });
		const third = await sell('cash', { now: new Date(NOW_MS - 1000) });
		const other = await sell('cash', { deviceId: 'device-B', now: new Date(NOW_MS) });
		await abandonSale(second.orderId, 'cancelled', new Date(NOW_MS));
		// A cart in progress is not a sale.
		await withDb(
			(db) =>
				new Promise<void>((resolve, reject) => {
					const tx = db.transaction('orders', 'readwrite');
					tx.objectStore('orders').put({
						id: 'cart-1',
						deviceId: 'device-A',
						state: 'cart',
						cart: newCart('device-A', 'dine_in', null, new Date(NOW_MS))
					} satisfies LocalOrder<Cart>);
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
				})
		);

		const all = await listRecentSales('device-A');
		expect(all.map((o) => o.id)).toEqual([third.orderId, second.orderId, first.orderId]);
		expect(all.map((o) => o.state)).toEqual(['completed', 'abandoned', 'completed']);
		expect((await listRecentSales('device-A', 2)).map((o) => o.id)).toEqual([
			third.orderId,
			second.orderId
		]);
		expect((await listRecentSales('device-B')).map((o) => o.id)).toEqual([other.orderId]);
		expect(await listRecentSales('device-C')).toEqual([]);
	});

	it('gives every sale its glyph, sentence and tone — and the reason a reprint is refused', async () => {
		const cash = await sell('cash');
		const order = (await readOrder(cash.orderId))!;
		expect(saleStatusMark(order)).toEqual({ glyph: '●', text: 'Paid', tone: 'ok' });
		expect(saleStatusMark({ ...order, syncStatus: 'accepted' })).toEqual({
			glyph: '●',
			text: 'Paid',
			tone: 'ok'
		});
		const review = { ...order, syncStatus: 'unrecorded' as const };
		expect(saleStatusMark(review)).toEqual({
			glyph: '◆',
			text: "Recorded for the owner's review",
			tone: 'pending'
		});
		// Still printable: the customer paid.
		expect(reprintRefusal(review)).toBeNull();
		expect(reprintRefusal(order)).toBeNull();

		const card = (await readOrder((await sell('card')).orderId))!;
		expect(saleStatusMark(card)).toEqual({
			glyph: '◐',
			text: 'Awaiting confirmation — no receipt yet',
			tone: 'pending'
		});
		expect(reprintRefusal(card)).toBe("Awaiting the server's confirmation");
		for (const syncStatus of ['accepted', 'recorded_flagged'] as const) {
			expect(saleStatusMark({ ...card, syncStatus })).toEqual({
				glyph: '●',
				text: 'Paid',
				tone: 'ok'
			});
			expect(reprintRefusal({ ...card, syncStatus })).toBeNull();
		}
		// A card sale the server could not record waits: closed, not printed.
		expect(saleStatusMark({ ...card, syncStatus: 'unrecorded' }).glyph).toBe('◐');
		expect(reprintRefusal({ ...card, syncStatus: 'unrecorded' })).toBe(
			"Awaiting the server's confirmation"
		);

		const refused = { ...card, syncStatus: 'rejected' as const };
		expect(saleStatusMark(refused)).toEqual({
			glyph: '✕',
			text: 'Refused — no receipt',
			tone: 'danger'
		});
		expect(reprintRefusal(refused)).toBe('Refused — no receipt');
		expect(saleStatusMark({ ...refused, state: 'abandoned' }).glyph).toBe('✕');
		expect(reprintRefusal({ ...refused, state: 'abandoned' })).toBe('Refused — no receipt');

		const cancelled = { ...card, state: 'abandoned' as const };
		expect(saleStatusMark(cancelled)).toEqual({ glyph: '↩', text: 'Cancelled', tone: 'neutral' });
		expect(reprintRefusal(cancelled)).toBe('Cancelled — no receipt');

		const old = { ...order, sale: undefined };
		expect(saleStatusMark(old)).toEqual({
			glyph: '○',
			text: 'Sold before printing was set up',
			tone: 'neutral'
		});
		expect(reprintRefusal(old)).toBe('Sold before printing was set up');
	});
});

describe('readReceiptHeader', () => {
	it('reads the cached settings and falls back to Restaurant', async () => {
		expect(await readReceiptHeader()).toEqual({
			restaurantName: 'Maqaayadda Hodan',
			address: 'Makka Al-Mukarama Rd, Km4',
			phone: null,
			taxRegistrationNumber: null,
			footer: 'Mahadsanid!'
		});
		await cacheSettings([{ key: 'restaurantName', value: null }]);
		expect((await readReceiptHeader()).restaurantName).toBe('Restaurant');
	});
});

describe('MANDATORY (invariant 4) — printing is never inside the payment transaction', () => {
	it('orders.ts imports neither ./printing nor ./print-client', () => {
		const source = readFileSync(new URL('./orders.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/from '\.\/printing'/);
		expect(source).not.toMatch(/from '\.\/print-client'/);
		expect(source).not.toMatch(/from '\$lib\/pos\/printing'/);
	});

	it('src/lib/server/** never imports or names the print client or the printing module', () => {
		const root = new URL('../server/', import.meta.url).pathname;
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (/\.(ts|js|svelte)$/.test(name)) files.push(full);
			}
		};
		walk(root);
		expect(files.length).toBeGreaterThan(20);
		for (const file of files) {
			const source = readFileSync(file, 'utf8');
			expect(source, file).not.toMatch(/print-client/);
			expect(source, file).not.toMatch(/pos\/printing|from '[./]*printing'/);
		}
	});
});
