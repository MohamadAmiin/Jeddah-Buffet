// The unit project runs in `node`, which has no indexedDB: fake-indexeddb — the
// pinned devDependency T-28 added; no new dependency here — provides the global
// for THIS file only.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { compareVersions, parseSnapshot } from './menu-snapshot';
import {
	bindDevice,
	openPosDb,
	readCachedEmployees,
	readCachedSetting,
	readMenu,
	replaceMenu,
	syncMenu,
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
	isAvailable: true,
	sortOrder: 0,
	modifierGroupIds: ['g1']
};

/** A GET /api/menu payload, as the server serialises it. */
function payload(overrides: Record<string, unknown> = {}) {
	return {
		version: 7,
		restaurantId: 'restaurant-A',
		takenAt: '2026-09-15T18:00:00.000Z',
		currency: 'USD',
		currencyExponent: 2,
		taxMode: 'exclusive',
		taxRateBp: 825,
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
		expect(source).toContain('const DB_VERSION = 2');
		// The case labels are searched for AFTER the switch: upgrade()'s own comment
		// mentions `case 1:` above it, which a whole-file search would find first.
		const switchAt = source.indexOf('switch (oldVersion)');
		const case0At = source.indexOf('case 0:', switchAt);
		const case1At = source.indexOf('case 1:', switchAt);
		expect(switchAt).toBeGreaterThan(-1);
		expect(case1At).toBeGreaterThan(case0At);
		expect(source.slice(case1At, source.indexOf('}', case1At))).toContain("'menu'");
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
			role: 'cashier',
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

		expect(stores).toEqual(['employees', 'menu', 'offline_logins', 'settings']);
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

	it('drops the menu with everything else when the device changes', async () => {
		await bindDevice('device-A');
		await replaceMenu(parseSnapshot(payload()));
		expect(await readMenu()).not.toBeNull();

		await bindDevice('device-B');

		expect(await readMenu()).toBeNull();
	});
});
