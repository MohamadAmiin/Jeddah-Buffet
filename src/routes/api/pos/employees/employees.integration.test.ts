import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { seedStaff } from '$lib/server/db/test/seed';
import { eq } from 'drizzle-orm';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { restaurantSettings } from '$lib/server/db/schema/restaurant-settings';
import { users } from '$lib/server/db/schema/users';
import { hashPin } from '$lib/pin';
import {
	DEVICE_COOKIE,
	generateDeviceToken,
	registerDevice,
	revokeDevice
} from '$lib/server/auth/pos-device';
import {
	archivePaymentMethod,
	createPaymentMethod,
	onRestaurantCreated,
	replaceReceiptLines,
	setReceiptLogo,
	updateSettings
} from '$lib/server/restaurants';
import { DEFAULT_RECEIPT_LAYOUT, type ReceiptLayout } from '$lib/receipt-layout';
import { GET } from './+server';

const db = testDb();
let PIN_1234: string;

beforeAll(async () => {
	PIN_1234 = await hashPin('1234');
});

afterAll(async () => {
	await closeTestDb();
});

/** A restaurant WITH its settings row, its owner, an active cashier, and a registered till. */
async function makeRestaurant(name: string, email: string) {
	const [restaurant] = await db.insert(restaurants).values({ name }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, { restaurantName: name, timeZone: 'UTC' })
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: `${name} Owner`,
			email,
			passwordHash: 'not-a-real-hash'
		})
		.returning();

	await seedStaff(db, restaurant.id, {
		roleName: 'Cashier',
		displayName: 'Sam',
		pinHash: PIN_1234
	});

	const device = await db.transaction((tx) =>
		registerDevice(tx, { restaurantId: restaurant.id, actorUserId: owner.id, label: 'Till' })
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, ...device };
}

function makeEvent(cookies: Record<string, string>): RequestEvent {
	const jar = new Map(Object.entries(cookies));
	const url = new URL('http://localhost/api/pos/employees');
	return {
		cookies: {
			get: (name: string) => jar.get(name),
			getAll: () => [...jar].map(([name, value]) => ({ name, value })),
			set: (name: string, value: string) => jar.set(name, value),
			delete: (name: string) => jar.delete(name),
			serialize: () => ''
		},
		fetch: globalThis.fetch,
		getClientAddress: () => '203.0.113.5',
		locals: { user: null, restaurantId: null, sessionToken: null, posDevice: null },
		params: {},
		platform: undefined,
		request: new Request(url),
		route: { id: '/api/pos/employees' },
		setHeaders: () => {},
		url,
		isDataRequest: false,
		isSubRequest: false,
		isRemoteRequest: false
	} as unknown as RequestEvent;
}

/** GET, returning the status, the SERIALISED body parsed back, and the headers — or the thrown status. */
async function get(cookies: Record<string, string>) {
	try {
		const response = await GET(makeEvent(cookies));
		return {
			status: response.status,
			body: JSON.parse(await response.text()) as {
				device: { id: string; code: string };
				employees: Array<Record<string, unknown>>;
				lastInvoiceSeq: number;
				openSession: {
					id: string;
					openedByUserId: string;
					businessDate: string;
					openingCashMinor: string;
					openedAt: string;
				} | null;
				settings: {
					posIdleLockSeconds: number | null;
					timeZone: string | null;
					// tasks/settings-tax-payments-receipt T-20.
					paymentMethods: Array<{
						id: string;
						name: string;
						kind: string;
						merchantNumber: string | null;
					}>;
					receipt: ReceiptLayout;
				};
			},
			headers: response.headers
		};
	} catch (thrown) {
		const status = (thrown as { status?: number }).status;
		if (status === undefined) throw thrown;
		return { status, body: null, headers: null };
	}
}

describe('GET /api/pos/employees', () => {
	// MANDATORY (spec 29 — a permission check test on every POS API route). A read,
	// and still guarded: this one ships password-equivalent material.
	it('answers exactly 403 — and returns nothing — without a live registered device', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const none = await get({});
		expect(none).toEqual({ status: 403, body: null, headers: null });

		const unknown = await get({ [DEVICE_COOKIE]: generateDeviceToken() });
		expect(unknown).toEqual({ status: 403, body: null, headers: null });

		await db.transaction((tx) =>
			revokeDevice(tx, {
				deviceId: a.deviceId,
				restaurantId: a.restaurantId,
				actorUserId: a.ownerId
			})
		);
		const revoked = await get({ [DEVICE_COOKIE]: a.token });
		expect(revoked).toEqual({ status: 403, body: null, headers: null });
	});

	it("returns only the device's restaurant's employees", async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const b = await makeRestaurant('Cafe B', 'b@cafe.com');
		await seedStaff(db, b.restaurantId, {
			roleName: 'Cashier',
			displayName: 'Should Not Appear'
		});
		const result = await get({ [DEVICE_COOKIE]: a.token });

		expect(result.status).toBe(200);
		const names = result.body!.employees.map((e) => e.displayName);
		expect(names).not.toContain('Should Not Appear');
		// Restaurant A has exactly its owner and its cashier.
		expect(result.body!.employees).toHaveLength(2);
	});

	// The leak this catches is a route that spreads a database row: asserted on the
	// SERIALISED body, not on the read model's return value.
	it('serialises exactly the seven keys of the read model, and exactly FIVE top-level keys', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const { body } = await get({ [DEVICE_COOKIE]: a.token });

		expect(Object.keys(body!).sort()).toEqual([
			'device',
			'employees',
			'lastInvoiceSeq',
			'openSession',
			'settings'
		]);
		// The device's uuid — what the till binds its cache to — and its printed code.
		expect(body!.device).toEqual({ id: a.deviceId, code: 'POS1' });
		for (const entry of body!.employees) {
			expect(Object.keys(entry).sort()).toEqual([
				'displayName',
				'id',
				'isActive',
				'isOwner',
				'permissions',
				'pinPhc',
				'roleName'
			]);
		}
	});

	// settings-tax-payments-receipt T-33: the legacy tender and footer keys left
	// the bundle with their columns (migration 0018). An EXACT key set, so a
	// retired key cannot come back unnoticed and a new one is a deliberate edit.
	it('serialises exactly the eight settings keys the till reads', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const { body } = await get({ [DEVICE_COOKIE]: a.token });

		expect(Object.keys(body!.settings).sort()).toEqual([
			'paymentMethods',
			'posIdleLockSeconds',
			'receipt',
			'receiptAddress',
			'receiptPhone',
			'restaurantName',
			'taxRegistrationNumber',
			'timeZone'
		]);
	});

	it('keeps an employee with no PIN and drops a deactivated one — both decided by the read model', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await seedStaff(db, a.restaurantId, {
			roleName: 'Cashier',
			displayName: 'New Hire'
		});
		await seedStaff(db, a.restaurantId, {
			roleName: 'Cashier',
			displayName: 'Gone',
			isActive: false
		});

		const { body } = await get({ [DEVICE_COOKIE]: a.token });
		const byName = new Map(body!.employees.map((e) => [e.displayName, e]));

		expect(byName.get('New Hire')?.pinPhc).toBeNull();
		expect(byName.has('Gone')).toBe(false);
	});

	it('passes the idle lock through as null until set, then as the stored integer', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');

		const before = await get({ [DEVICE_COOKIE]: a.token });
		// null, not a substituted number. The time zone is set at registration and
		// travels through so the till can render the business date.
		expect(before.body!.settings).toEqual({
			restaurantName: 'Cafe A',
			posIdleLockSeconds: null,
			timeZone: 'UTC',
			// T-21: the receipt header rides here too, null until the owner sets it.
			receiptAddress: null,
			receiptPhone: null,
			taxRegistrationNumber: null,
			// settings-tax-payments-receipt T-20: the built-in Cash row every new
			// restaurant gets from the seedCashMethod initializer (T-11), and
			// today's receipt layout — every switch on, no lines, no heading, no
			// logo (T-12).
			paymentMethods: [
				{ id: expect.any(String), name: 'Cash', kind: 'cash', merchantNumber: null }
			],
			receipt: DEFAULT_RECEIPT_LAYOUT
		});

		await db.transaction((tx) =>
			updateSettings(
				tx,
				a.restaurantId,
				{ posIdleLockSeconds: 120 },
				{ actorUserId: a.ownerId, ip: null, userAgent: null }
			)
		);
		const after = await get({ [DEVICE_COOKIE]: a.token });
		expect(after.body!.settings).toEqual({
			restaurantName: 'Cafe A',
			posIdleLockSeconds: 120,
			timeZone: 'UTC',
			receiptAddress: null,
			receiptPhone: null,
			taxRegistrationNumber: null,
			paymentMethods: [
				{ id: expect.any(String), name: 'Cash', kind: 'cash', merchantNumber: null }
			],
			receipt: DEFAULT_RECEIPT_LAYOUT
		});
	});

	it('tells every cache not to keep the response', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const { headers } = await get({ [DEVICE_COOKIE]: a.token });
		expect(headers!.get('cache-control')).toBe('no-store');
	});
});

describe("the till's sale bootstrap (T-28)", () => {
	it('reports lastInvoiceSeq 0 and openSession null for a device that has never sold', async () => {
		const a = await makeRestaurant('Cafe Boot', 'boot@cafe.com');
		const { body } = await get({ [DEVICE_COOKIE]: a.token });
		expect(body!.lastInvoiceSeq).toBe(0);
		expect(body!.openSession).toBeNull();
	});

	// menu-and-printing T-21: the receipt header rides INSIDE settings, so the
	// response keeps its five top-level keys.
	it('passes the receipt header through as stored, null until set', async () => {
		const a = await makeRestaurant('Cafe Receipt', 'receipt@cafe.com');
		const before = (await get({ [DEVICE_COOKIE]: a.token })).body!.settings as Record<
			string,
			unknown
		>;
		expect(before.receiptAddress).toBeNull();
		expect(before.receiptPhone).toBeNull();
		expect(before.taxRegistrationNumber).toBeNull();

		await db
			.update(restaurantSettings)
			.set({
				receiptAddress: 'Km4',
				receiptPhone: '61 555 0142',
				taxRegistrationNumber: 'TIN-1'
			})
			.where(eq(restaurantSettings.restaurantId, a.restaurantId));
		const { body } = await get({ [DEVICE_COOKIE]: a.token });
		expect(body!.settings).toMatchObject({
			receiptAddress: 'Km4',
			receiptPhone: '61 555 0142',
			taxRegistrationNumber: 'TIN-1'
		});
		expect(Object.keys(body!).sort()).toEqual([
			'device',
			'employees',
			'lastInvoiceSeq',
			'openSession',
			'settings'
		]);
	});
});

describe('payment methods and the receipt layout (settings-tax-payments-receipt T-20)', () => {
	const ctxOf = (r: { ownerId: string }) => ({ actorUserId: r.ownerId, ip: null, userAgent: null });

	it('ships the enabled, live methods only, cash first, four keys each', async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await db.transaction(async (tx) => {
			expect(
				await createPaymentMethod(
					tx,
					a.restaurantId,
					{ name: 'EVC Plus', kind: 'mobile', merchantNumber: '61 234 5678', enabled: true },
					ctxOf(a)
				)
			).toMatchObject({ ok: true });
			// Disabled: stays out of the bundle.
			expect(
				await createPaymentMethod(
					tx,
					a.restaurantId,
					{ name: 'Visa terminal', kind: 'card', merchantNumber: null, enabled: false },
					ctxOf(a)
				)
			).toMatchObject({ ok: true });
			// Archived: stays out of the bundle, enabled or not.
			const zaad = await createPaymentMethod(
				tx,
				a.restaurantId,
				{ name: 'Zaad', kind: 'mobile', merchantNumber: '63 345 6789', enabled: true },
				ctxOf(a)
			);
			if (!zaad.ok) throw new Error(zaad.reason);
			expect(await archivePaymentMethod(tx, a.restaurantId, zaad.id, ctxOf(a))).toEqual({
				ok: true
			});
			expect(
				await createPaymentMethod(
					tx,
					a.restaurantId,
					{ name: 'Card', kind: 'card', merchantNumber: null, enabled: true },
					ctxOf(a)
				)
			).toMatchObject({ ok: true });
		});

		const { body } = await get({ [DEVICE_COOKIE]: a.token });
		const methods = body!.settings.paymentMethods;
		// Cash first, then sort_order — the reader's order, untouched here.
		expect(methods.map((m) => m.name)).toEqual(['Cash', 'EVC Plus', 'Card']);
		// Exactly four keys: the row is mapped by name, never spread, so enabled,
		// sortOrder and archivedAt cannot leak.
		for (const method of methods) {
			expect(Object.keys(method).sort()).toEqual(['id', 'kind', 'merchantNumber', 'name']);
		}
		expect(methods[1]).toMatchObject({ kind: 'mobile', merchantNumber: '61 234 5678' });
	});

	it("never ships another restaurant's methods", async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		const b = await makeRestaurant('Cafe B', 'b@cafe.com');
		await db.transaction(async (tx) => {
			expect(
				await createPaymentMethod(
					tx,
					b.restaurantId,
					{ name: 'Zaad', kind: 'mobile', merchantNumber: '63 345 6789', enabled: true },
					ctxOf(b)
				)
			).toMatchObject({ ok: true });
		});

		const { body } = await get({ [DEVICE_COOKIE]: a.token });
		expect(body!.settings.paymentMethods.map((m) => m.name)).toEqual(['Cash']);
		expect(body!.settings.paymentMethods.map((m) => m.name)).not.toContain('Zaad');
	});

	it("ships the layout and only the logo's fingerprint", async () => {
		const a = await makeRestaurant('Cafe A', 'a@cafe.com');
		await db.transaction(async (tx) => {
			expect(
				await replaceReceiptLines(tx, a.restaurantId, 'header', ['Open daily 7-23'], ctxOf(a))
			).toEqual({ ok: true, changed: true });
			expect(
				await replaceReceiptLines(tx, a.restaurantId, 'footer', ['Mahadsanid!'], ctxOf(a))
			).toEqual({ ok: true, changed: true });
			expect(
				await updateSettings(
					tx,
					a.restaurantId,
					{
						receiptShow: { businessDate: false },
						receiptPaymentNumbersHeading: 'PAY BY MOBILE MONEY'
					},
					ctxOf(a)
				)
			).toMatchObject({ ok: true, changed: true });
			expect(
				await setReceiptLogo(
					tx,
					a.restaurantId,
					{ widthDots: 16, heightDots: 2, bitmap: new Uint8Array([0xff, 0x00, 0x81, 0x7e]) },
					ctxOf(a)
				)
			).toEqual({ ok: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
		});

		const { body } = await get({ [DEVICE_COOKIE]: a.token });
		expect(body!.settings.receipt).toEqual({
			headerLines: ['Open daily 7-23'],
			footerLines: ['Mahadsanid!'],
			// The one switch turned off; every other one still true.
			show: { ...DEFAULT_RECEIPT_LAYOUT.show, businessDate: false },
			paymentNumbersHeading: 'PAY BY MOBILE MONEY',
			logo: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), widthDots: 16, heightDots: 2 }
		});
		// The bitmap never rides in the bundle: GET /api/pos/receipt-logo serves it,
		// and only when this fingerprint changes.
		expect(Object.keys(body!.settings.receipt.logo!).sort()).toEqual([
			'heightDots',
			'sha256',
			'widthDots'
		]);
		expect(JSON.stringify(body!.settings)).not.toContain('bitmap');
	});
});
