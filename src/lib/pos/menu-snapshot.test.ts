// The unit project runs in `node`, which has no indexedDB: fake-indexeddb — the
// pinned devDependency T-28 added; no new dependency here — provides the global
// for THIS file only.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { compareVersions, parseSnapshot, SnapshotError } from './menu-snapshot';
import {
	bindDevice,
	inTransaction,
	openPosDb,
	readBoundDeviceId,
	readCachedEmployees,
	readCachedSetting,
	readMenu,
	replaceMenu,
	syncMenu,
	withDb,
	type CachedEmployee
} from './store';

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

const item = {
	id: 'i1',
	categoryId: 'c1',
	name: 'Tea',
	priceMinor: '850',
	taxRateBp: null,
	taxRate: { id: 'rate-tax', name: 'Tax', rateBp: 825 },
	isAvailable: true,
	sortOrder: 0,
	modifierGroupIds: ['g1']
};

/** A GET /api/menu payload, as the server serialises it. */
function payload(overrides: Record<string, unknown> = {}) {
	return {
		version: 7,
		format: 2,
		restaurantId: 'restaurant-A',
		takenAt: '2026-09-15T18:00:00.000Z',
		currency: 'USD',
		currencyExponent: 2,
		taxMode: 'exclusive',
		taxRateBp: 825,
		defaultTaxRate: { id: 'rate-tax', name: 'Tax', rateBp: 825 },
		categories: [{ id: 'c1', name: 'Drinks', sortOrder: 0 }],
		items: [item],
		modifierGroups: [
			{
				id: 'g1',
				name: 'Milk',
				minSelect: 0,
				maxSelect: 1,
				modifiers: [{ id: 'm1', name: 'No milk', priceDeltaMinor: '-50' }]
			}
		],
		...overrides
	};
}

describe('compareVersions', () => {
	it.each([
		[182, 183, 'replace'],
		[183, 183, 'up-to-date'],
		[null, 1, 'replace'],
		// A local version AHEAD of the server's is corruption: take the server's anyway.
		[184, 183, 'replace']
	] as const)('local %s against server %s is %s', (local, server, expected) => {
		expect(compareVersions(local, server)).toBe(expected);
	});
});

describe('parseSnapshot — validates, never converts', () => {
	it('returns every *Minor field unchanged, as the string it arrived as', () => {
		const snapshot = parseSnapshot(payload());
		expect(snapshot.items[0].priceMinor).toBe('850');
		expect(snapshot.modifierGroups[0].modifiers[0].priceDeltaMinor).toBe('-50');
		// BigInt() on what it returned gives the amounts — in readMenu, the ONE place.
		expect(BigInt(snapshot.items[0].priceMinor)).toBe(850n);
		expect(BigInt(snapshot.modifierGroups[0].modifiers[0].priceDeltaMinor)).toBe(-50n);
	});

	it.each([850, 8.5, '8.50', 'abc'])(
		'rejects a priceMinor of %j with an error naming the field',
		(value) => {
			expect(() => parseSnapshot(payload({ items: [{ ...item, priceMinor: value }] }))).toThrow(
				/items\[0\]\.priceMinor/
			);
		}
	);

	it('keeps a price past 2^53 exact — the reason the string exists', () => {
		const big = parseSnapshot(payload({ items: [{ ...item, priceMinor: '9007199254740993' }] }));
		expect(BigInt(big.items[0].priceMinor)).toBe(9007199254740993n);
		// Through a JavaScript number, the same digits lose a unit.
		expect(BigInt(Number('9007199254740993'))).not.toBe(9007199254740993n);
	});

	it.each([undefined, 7.5, '7'])('rejects a version of %j', (version) => {
		expect(() => parseSnapshot(payload({ version }))).toThrow(/version/);
	});

	// tasks/settings-tax-payments-receipt T-18: named tax rates.
	it("parses format 2: the header's default rate and each item's resolved rate", () => {
		const snapshot = parseSnapshot(payload());
		expect(snapshot.format).toBe(2);
		expect(snapshot.defaultTaxRate).toEqual({ id: 'rate-tax', name: 'Tax', rateBp: 825 });
		expect(snapshot.items[0].taxRate).toEqual({ id: 'rate-tax', name: 'Tax', rateBp: 825 });

		// A PRESENT null is "no rate": no default picked, and an item with neither.
		const none = parseSnapshot(
			payload({ defaultTaxRate: null, items: [{ ...item, taxRate: null }] })
		);
		expect(none.defaultTaxRate).toBeNull();
		expect(none.items[0].taxRate).toBeNull();
	});

	it('reads a snapshot from a server before named rates as format 1 with null rates', () => {
		const snapshot = parseSnapshot(
			payload({
				format: undefined,
				defaultTaxRate: undefined,
				items: [{ ...item, taxRate: undefined }]
			})
		);
		expect(snapshot.format).toBe(1);
		expect(snapshot.defaultTaxRate).toBeNull();
		expect(snapshot.items[0].taxRate).toBeNull();
		expect(snapshot.taxRateBp).toBe(825);
	});

	it('refuses a present rate of the wrong shape', () => {
		const refusal = (overrides: Record<string, unknown>): Error => {
			try {
				parseSnapshot(payload(overrides));
			} catch (error) {
				expect(error).toBeInstanceOf(SnapshotError);
				return error as Error;
			}
			throw new Error('parseSnapshot accepted a malformed rate');
		};

		expect(refusal({ format: 'two' }).message).toMatch(/format/);
		expect(refusal({ defaultTaxRate: { id: 1, name: 'Tax', rateBp: 825 } }).message).toMatch(
			/defaultTaxRate\.id/
		);
		expect(
			refusal({ items: [{ ...item, taxRate: { id: 'r', name: 'VAT', rateBp: '500' } }] }).message
		).toMatch(/items\[0\]\.taxRate\.rateBp/);
		expect(refusal({ items: [{ ...item, taxRate: 500 }] }).message).toMatch(
			/items\[0\]\.taxRate is not an object/
		);
	});
});

describe('parseSnapshot — optional category and photo id (menu-and-printing T-15)', () => {
	it('reads a null category', () => {
		const snapshot = parseSnapshot(payload({ items: [{ ...item, categoryId: null }] }));
		expect(snapshot.items[0].categoryId).toBeNull();
	});

	it('reads a missing imageId as null and a string as itself', () => {
		// `item` has no imageId key at all — the shape a server before T-07 sends.
		expect(parseSnapshot(payload()).items[0].imageId).toBeNull();
		expect(
			parseSnapshot(payload({ items: [{ ...item, imageId: 'img-1' }] })).items[0].imageId
		).toBe('img-1');
		expect(
			parseSnapshot(payload({ items: [{ ...item, imageId: null }] })).items[0].imageId
		).toBeNull();
	});

	it('refuses a numeric imageId with a SnapshotError naming items[0].imageId', () => {
		let thrown: unknown;
		try {
			parseSnapshot(payload({ items: [{ ...item, imageId: 5 }] }));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SnapshotError);
		expect((thrown as Error).message).toMatch(/items\[0\]\.imageId/);
	});
});

// A structural tripwire on store.ts (the idiom route-guards.test.ts and
// components.test.ts use): the properties that matter here fail silently.
describe("store.ts's menu path, as written", () => {
	const source = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');

	it('replaces rows and version in ONE transaction over menu and settings, with no fetch inside it', () => {
		const start = source.indexOf("transaction(['menu', 'settings'], 'readwrite')");
		expect(start).toBeGreaterThan(-1);
		expect(source).toContain('.abort(');
		const inside = source.slice(start, source.indexOf('\n}\n', start));
		// Any network call — `fetch(`, `await fetch(` or the injected `fetchFn(` — inside
		// the transaction lets it auto-commit during the await, leaving half a menu.
		const networkCall = /fetch\w*\(/;
		expect(inside, 'a network call sits inside the menu transaction').not.toMatch(networkCall);
		// The positive control: the same pattern DOES see syncMenu's real calls, which
		// are spelled `await fetchFn(`, so this tripwire cannot pass by misspelling.
		const syncMenuBody = source.slice(source.indexOf('export async function syncMenu'), start);
		expect(syncMenuBody).toMatch(networkCall);
	});

	it('adds the menu store in a NEW case and leaves case 0 alone', () => {
		// T-22 (tasks/pos-sales) bumped DB_VERSION to 3 and added case 2; the menu
		// case is still case 1 and case 0 stays as it was.
		expect(source).toContain('const DB_VERSION = 3');
		const switchAt = source.indexOf('switch (oldVersion)');
		const case0At = source.indexOf('case 0:', switchAt);
		const case1At = source.indexOf('case 1:', switchAt);
		const case2At = source.indexOf('case 2:', switchAt);
		expect(switchAt).toBeGreaterThan(-1);
		expect(case1At).toBeGreaterThan(case0At);
		expect(case2At).toBeGreaterThan(case1At);
		const case1Body = source.slice(case1At, case2At);
		expect(case1Body).toContain("'menu'");
		const case0 = source.slice(case0At, case1At);
		for (const store of ["'employees'", "'settings'", "'offline_logins'"]) {
			expect(case0).toContain(store);
		}
		expect(case0).not.toContain("'menu'");
	});

	it('holds no number conversion of money', () => {
		expect(source).not.toContain('Number(');
		expect(source).not.toContain('parseFloat');
	});
});

describe('the menu in IndexedDB', () => {
	it('upgrades a version-1 till in place: four stores, its cached employees intact', async () => {
		const sam: CachedEmployee = {
			id: 'e1',
			displayName: 'Sam',
			isOwner: false,
			roleName: 'Cashier',
			permissions: [],
			isActive: true,
			pinPhc: null
		};
		// A database exactly as T-28 left it, at version 1.
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('matcami-pos', 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				db.createObjectStore('employees', { keyPath: 'id' });
				db.createObjectStore('settings', { keyPath: 'key' });
				db.createObjectStore('offline_logins', { keyPath: 'clientOpId' });
			};
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction('employees', 'readwrite');
				tx.objectStore('employees').put(sam);
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
			};
			request.onerror = () => reject(request.error);
		});

		const db = await openPosDb();
		const stores = Array.from(db.objectStoreNames).sort();
		db.close();

		// T-22 adds four more stores; the upgrade still preserves employees.
		expect(stores).toEqual([
			'employees',
			'invoice_sequence',
			'menu',
			'offline_logins',
			'orders',
			'session',
			'settings',
			'sync_queue'
		]);
		expect(await readCachedEmployees()).toEqual([sam]);
	});

	it('stores the strings and reads the amounts back through the ONE conversion', async () => {
		await replaceMenu(parseSnapshot(payload()));

		const menu = await readMenu();

		expect(menu!.version).toBe(7);
		expect(menu!.restaurantId).toBe('restaurant-A');
		expect(menu!.items[0].priceMinor).toBe(850n);
		expect(menu!.modifierGroups[0].modifiers[0].priceDeltaMinor).toBe(-50n);
		expect([menu!.currency, menu!.currencyExponent, menu!.taxMode, menu!.taxRateBp]).toEqual([
			'USD',
			2,
			'exclusive',
			825
		]);
		expect(await readCachedSetting('menuVersion')).toBe(7);
	});

	it('leaves the OLD version and the OLD rows when a replace fails mid-write', async () => {
		await replaceMenu(parseSnapshot(payload()));

		await expect(
			replaceMenu(parseSnapshot(payload({ version: 8, items: [] })), true)
		).rejects.toThrow();

		const menu = await readMenu();
		expect(menu!.version).toBe(7);
		expect(menu!.items.map((i) => i.name)).toEqual(['Tea']);
	});

	it("downloads only on a mismatch, and treats another restaurant's copy as none", async () => {
		const calls: string[] = [];
		const server = { version: 7, restaurantId: 'restaurant-A' };
		const fakeFetch = (async (url: string) => {
			calls.push(url);
			const body = url === '/api/menu/version' ? server : payload({ ...server });
			return new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof fetch;

		expect(await syncMenu(fakeFetch)).toBe('replaced');
		expect(calls).toEqual(['/api/menu/version', '/api/menu']);

		calls.length = 0;
		expect(await syncMenu(fakeFetch)).toBe('up-to-date');
		expect(calls).toEqual(['/api/menu/version']);

		// The tablet changed hands: the SAME version number, a different restaurant.
		server.restaurantId = 'restaurant-B';
		calls.length = 0;
		expect(await syncMenu(fakeFetch)).toBe('replaced');
		expect(calls).toEqual(['/api/menu/version', '/api/menu']);
		expect((await readMenu())!.restaurantId).toBe('restaurant-B');
	});

	it('writes nothing when the snapshot is malformed', async () => {
		await replaceMenu(parseSnapshot(payload()));
		const fakeFetch = (async (url: string) =>
			new Response(
				JSON.stringify(
					url === '/api/menu/version'
						? { version: 8, restaurantId: 'restaurant-A' }
						: payload({ version: 8, items: [{ ...item, priceMinor: 900 }] })
				),
				{ status: 200 }
			)) as unknown as typeof fetch;

		await expect(syncMenu(fakeFetch)).rejects.toThrow(/priceMinor/);
		expect((await readMenu())!.version).toBe(7);
	});

	// tasks/settings-tax-payments-receipt T-18: named tax rates (menu format 2).
	it('round-trips format, the default rate and the item rate through replaceMenu and readMenu', async () => {
		await replaceMenu(parseSnapshot(payload()));

		const menu = await readMenu();

		expect(menu!.format).toBe(2);
		expect(menu!.defaultTaxRate).toEqual({ id: 'rate-tax', name: 'Tax', rateBp: 825 });
		expect(menu!.items[0].taxRate).toEqual({ id: 'rate-tax', name: 'Tax', rateBp: 825 });
		expect(menu!.taxRateBp).toBe(825);
	});

	it('reads a copy written by the previous build', async () => {
		// The rows exactly as the build before named rates wrote them: a header with
		// no format and no defaultTaxRate, an item with no taxRate.
		await withDb((db) =>
			inTransaction(db, ['menu', 'settings'], 'readwrite', (tx) => {
				const menu = tx.objectStore('menu');
				menu.put({
					id: 'snapshot',
					kind: 'snapshot',
					data: { currency: 'USD', currencyExponent: 2, taxMode: 'exclusive', taxRateBp: 825 }
				});
				menu.put({
					id: 'item:i1',
					kind: 'item',
					data: {
						id: 'i1',
						categoryId: 'c1',
						imageId: null,
						name: 'Tea',
						priceMinor: '850',
						taxRateBp: null,
						isAvailable: true,
						sortOrder: 0,
						modifierGroupIds: []
					}
				});
				const settings = tx.objectStore('settings');
				settings.put({ key: 'menuVersion', value: 7 });
				settings.put({ key: 'menuRestaurantId', value: 'restaurant-A' });
			})
		);

		const menu = await readMenu();

		expect(menu!.format).toBe(1);
		expect(menu!.defaultTaxRate).toBeNull();
		expect(menu!.items[0].taxRate).toBeNull();
		expect(menu!.items[0].priceMinor).toBe(850n);
	});

	it('replaces a format-1 copy at an EQUAL version', async () => {
		await replaceMenu(parseSnapshot(payload({ format: undefined })));
		expect((await readMenu())!.format).toBe(1);

		const calls: string[] = [];
		const server = { version: 7, restaurantId: 'restaurant-A' };
		const fakeFetch = (async (url: string) => {
			calls.push(url);
			const body = url === '/api/menu/version' ? server : payload({ ...server });
			return new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof fetch;

		expect(await syncMenu(fakeFetch)).toBe('replaced');
		expect(calls).toEqual(['/api/menu/version', '/api/menu']);
		expect((await readMenu())!.format).toBe(2);

		calls.length = 0;
		expect(await syncMenu(fakeFetch)).toBe('up-to-date');
		expect(calls).toEqual(['/api/menu/version']);
	});

	it('drops the menu with everything else when the device changes', async () => {
		await bindDevice('device-A');
		await replaceMenu(parseSnapshot(payload()));
		expect(await readMenu()).not.toBeNull();

		await bindDevice('device-B');

		expect(await readMenu()).toBeNull();
	});

	it('forgets the device when the menu endpoint answers 403: a revoked till keeps no bundle', async () => {
		await bindDevice('device-A');
		await replaceMenu(parseSnapshot(payload()));
		const revoked = (async () =>
			new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;

		await expect(syncMenu(revoked)).rejects.toThrow(/403/);

		expect(await readBoundDeviceId()).toBeNull();
		expect(await readMenu()).toBeNull();
	});
});
