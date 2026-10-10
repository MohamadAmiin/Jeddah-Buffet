import { describe, it, expect, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';
import { users } from '$lib/server/db/schema/users';
import { seedStaff } from '$lib/server/db/test/seed';
import { posDevices } from '$lib/server/db/schema/pos-devices';
import { auditLog } from '$lib/server/db/schema/audit';
import type { Principal } from '$lib/server/auth/session';
import { registerDevice, validateDeviceToken } from '$lib/server/auth/pos-device';
import { onRestaurantCreated, settingsComplete } from '$lib/server/restaurants';
import { load, actions } from './+page.server';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

/** A restaurant as registration leaves it ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â settings row, time zone, no idle lock ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â plus its owner and one device. */
async function makeRestaurant() {
	const [restaurant] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	await db.transaction((tx) =>
		onRestaurantCreated(tx, restaurant.id, {
			restaurantName: 'Cafe One',
			timeZone: 'Africa/Mogadishu'
		})
	);
	const [owner] = await db
		.insert(users)
		.values({
			restaurantId: restaurant.id,
			role: 'owner',
			displayName: 'The Owner',
			email: 'owner@cafe.com',
			passwordHash: 'not-a-real-hash'
		})
		.returning();
	const device = await db.transaction((tx) =>
		registerDevice(tx, {
			restaurantId: restaurant.id,
			actorUserId: owner.id,
			label: 'Counter tablet'
		})
	);
	return { restaurantId: restaurant.id, ownerId: owner.id, ...device };
}

function principal(userId: string, restaurantId: string, role: Principal['role']): Principal {
	return {
		userId,
		restaurantId,
		role,
		displayName: role === 'owner' ? 'The Owner' : 'Staff',
		email: role === 'owner' ? 'owner@cafe.com' : null,
		sessionId: 's-1',
		expiresAt: new Date(Date.now() + 60_000)
	};
}

/** A dashboard request: the principal and tenant the hook would have set, and an optional form body. */
function makeEvent(user: Principal, form?: Record<string, string>): RequestEvent {
	const url = new URL('http://localhost/device');
	const body = form ? new FormData() : undefined;
	for (const [key, value] of Object.entries(form ?? {})) body!.set(key, value);
	return {
		cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
		getClientAddress: () => '203.0.113.5',
		locals: { user, restaurantId: user.restaurantId, sessionToken: null, posDevice: null },
		params: {},
		request: new Request(url, form ? { method: 'POST', body } : undefined),
		route: { id: '/(dashboard)/device' },
		url
	} as unknown as RequestEvent;
}

/** The status a load or action threw, or undefined when it returned. */
async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		await run();
		return undefined;
	} catch (thrown) {
		return (thrown as { status?: number }).status;
	}
}

type DevicePageData = {
	devices: {
		id: string;
		deviceCode: string;
		label: string;
		registeredAt: Date;
		lastSeenAt: Date | null;
		revokedAt: Date | null;
	}[];
	settings: { complete: boolean; missing: string[] };
	idleLockSeconds: number | null;
	timeZone: string | null;
	printAgent: {
		origin: string;
		builtAt: string;
		files: { name: string; url: string; os: string; arch: string; verified: boolean }[];
	} | null;
};

async function loadAs(user: Principal): Promise<DevicePageData> {
	return (await load(makeEvent(user) as never)) as DevicePageData;
}

function revoke(event: RequestEvent) {
	return actions.revoke!(event as Parameters<NonNullable<typeof actions.revoke>>[0]);
}

function setIdleLock(event: RequestEvent) {
	return actions.setIdleLock!(event as Parameters<NonNullable<typeof actions.setIdleLock>>[0]);
}

// What settingsComplete() reports before the owner has chosen anything: T-08's
// idle lock, then T-36's tax mode, tax rate and currency, in that order.
const NOTHING_SET = {
	complete: false,
	missing: ['POS idle lock', 'tax mode', 'tax rate', 'currency']
};

describe('the /device page', () => {
	// MANDATORY (spec 29 ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â permission checks; this repository applies the rule to
	// every route). 403 exactly ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â never a 404, never a 303 ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â from the load AND from
	// both actions, each a separately reachable endpoint.
	it.each(['staff'] as const)(
		'refuses a %s with 403 on the load and on both actions, and changes nothing',
		async () => {
			const a = await makeRestaurant();
			const staff = await seedStaff(db, a.restaurantId, { displayName: 'Staff' });
			const asStaff = principal(staff.id, a.restaurantId, 'staff');

			expect(await statusOf(() => load(makeEvent(asStaff) as never))).toBe(403);
			expect(await statusOf(() => revoke(makeEvent(asStaff, { deviceId: a.deviceId })))).toBe(403);
			expect(
				await statusOf(() => setIdleLock(makeEvent(asStaff, { posIdleLockSeconds: '120' })))
			).toBe(403);

			expect(await validateDeviceToken(db, a.token)).not.toBeNull();
			expect(await settingsComplete(db, a.restaurantId)).toEqual(NOTHING_SET);
		}
	);

	it('returns the devices, the settings gate and the stored idle lock to the owner', async () => {
		const a = await makeRestaurant();

		const result = await loadAs(principal(a.ownerId, a.restaurantId, 'owner'));

		expect(result.devices).toHaveLength(1);
		expect(result.devices[0].deviceCode).toBe('POS1');
		expect(result.devices[0].label).toBe('Counter tablet');
		expect(result.devices[0].revokedAt).toBeNull();
		expect(result.devices[0].lastSeenAt).toBeNull();
		expect(result.settings).toEqual(NOTHING_SET);
		// Null, exactly as stored ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â no number the owner never chose.
		expect(result.idleLockSeconds).toBeNull();
	});

	it('never lets the device token or its hash leave the server', async () => {
		const a = await makeRestaurant();
		const [{ tokenHash }] = await db
			.select({ tokenHash: posDevices.tokenHash })
			.from(posDevices)
			.where(eq(posDevices.id, a.deviceId));

		// Exactly what SvelteKit serialises into the page HTML and __data.json.
		const serialised = JSON.stringify(await loadAs(principal(a.ownerId, a.restaurantId, 'owner')));

		expect(serialised).not.toContain(tokenHash);
		expect(serialised).not.toContain(a.token);
		expect(serialised).not.toMatch(/token/i);
	});

	it('still returns a revoked device, with revokedAt set, so the page can tell', async () => {
		const a = await makeRestaurant();
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');
		await revoke(makeEvent(asOwner, { deviceId: a.deviceId }));

		const result = await loadAs(asOwner);

		expect(result.devices).toHaveLength(1);
		expect(result.devices[0].id).toBe(a.deviceId);
		expect(result.devices[0].revokedAt).toBeInstanceOf(Date);
	});

	// MANY TILLS (decision of 2026-10-08): every device the restaurant registered,
	// live ones first, and revoking one leaves the others exactly as they were.
	it('lists every till, live first, and revoking one leaves the rest live', async () => {
		const a = await makeRestaurant();
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');
		const second = await db.transaction((tx) =>
			registerDevice(tx, { restaurantId: a.restaurantId, actorUserId: a.ownerId, label: 'Bar' })
		);
		const third = await db.transaction((tx) =>
			registerDevice(tx, { restaurantId: a.restaurantId, actorUserId: a.ownerId, label: 'Patio' })
		);
		expect([second.deviceCode, third.deviceCode]).toEqual(['POS2', 'POS3']);

		await revoke(makeEvent(asOwner, { deviceId: second.deviceId }));
		const result = await loadAs(asOwner);

		expect(result.devices.map((d) => [d.deviceCode, d.revokedAt === null])).toEqual([
			['POS3', true],
			['POS1', true],
			['POS2', false]
		]);
		expect(await validateDeviceToken(db, a.token)).not.toBeNull();
		expect(await validateDeviceToken(db, third.token)).not.toBeNull();
		expect(await validateDeviceToken(db, second.token)).toBeNull();
	});

	it('saves an idle lock of 120 through updateSettings, with its audit row, taking it off the missing list', async () => {
		const a = await makeRestaurant();
		const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

		const result = await setIdleLock(makeEvent(asOwner, { posIdleLockSeconds: '120' }));

		expect(result).toEqual({ message: 'Auto-lock saved.' });
		// The idle lock has left the list; the three T-36 settings are chosen on
		// /settings, not on this page, so they remain.
		expect(await settingsComplete(db, a.restaurantId)).toEqual({
			complete: false,
			missing: ['tax mode', 'tax rate', 'currency']
		});
		expect((await loadAs(asOwner)).idleLockSeconds).toBe(120);
		const updated = () => db.select().from(auditLog).where(eq(auditLog.event, 'settings.updated'));
		expect(await updated()).toHaveLength(1);

		// The same value again changes nothing and writes no second audit row.
		const again = await setIdleLock(makeEvent(asOwner, { posIdleLockSeconds: '120' }));
		expect(again).toEqual({ message: 'No change to save.' });
		expect(await updated()).toHaveLength(1);
	});

	it.each(['29', '1801', '', 'abc', '120.5'])(
		'refuses an idle lock of %j with 400 and leaves the setting unset',
		async (value) => {
			const a = await makeRestaurant();
			const asOwner = principal(a.ownerId, a.restaurantId, 'owner');

			const result = await setIdleLock(makeEvent(asOwner, { posIdleLockSeconds: value }));

			expect((result as { status?: number }).status).toBe(400);
			expect(await settingsComplete(db, a.restaurantId)).toEqual(NOTHING_SET);
		}
	);
});

// The print agent download card (tasks/print-agent-installer T-13).
describe('the /device page — the print agent installers', () => {
	const NAMES = [
		['matcami-print-agent-linux-x64.zip', 'linux', 'x64'],
		['matcami-print-agent-windows-x64.exe', 'windows', 'x64'],
		['matcami-print-agent-macos-arm64.zip', 'macos', 'arm64'],
		['matcami-print-agent-macos-x64.zip', 'macos', 'x64']
	] as const;

	/** A built downloads folder: four small files and their manifest. */
	function buildFolder(): string {
		const dir = mkdtempSync(join(tmpdir(), 'matcami-device-agent-'));
		const files = NAMES.map(([name, os, arch]) => {
			const data = Buffer.from(`fake ${name}`);
			writeFileSync(join(dir, name), data);
			return {
				name,
				os,
				arch,
				bytes: data.length,
				sha256: createHash('sha256').update(data).digest('hex'),
				// As the build writes it today: only Linux has been run on its own OS.
				verified: os === 'linux'
			};
		});
		writeFileSync(
			join(dir, 'manifest.json'),
			JSON.stringify({
				schema: 1,
				origin: 'https://pos.example.com',
				agentVersion: 2,
				builtAt: '2026-10-10T09:00:00.000Z',
				sourceSha: 'a'.repeat(64),
				nodeVersion: 'v24.21.0',
				buildKey: 'b'.repeat(64),
				files
			})
		);
		return dir;
	}

	function withDownloads<T>(dir: string, run: () => Promise<T>): Promise<T> {
		const previous = process.env.PRINT_AGENT_DIST;
		process.env.PRINT_AGENT_DIST = dir;
		return run().finally(() => {
			if (previous === undefined) delete process.env.PRINT_AGENT_DIST;
			else process.env.PRINT_AGENT_DIST = previous;
			rmSync(dir, { recursive: true, force: true });
		});
	}

	it('gives the owner every installer with its download URL', async () => {
		const a = await makeRestaurant();
		const owner = principal(a.ownerId, a.restaurantId, 'owner');
		const result = await withDownloads(buildFolder(), () => loadAs(owner));
		expect(result.printAgent?.origin).toBe('https://pos.example.com');
		expect(result.printAgent?.files.map((f) => f.url)).toEqual(
			NAMES.map(([name]) => `/downloads/print-agent/${name}`)
		);
		// The Windows and the two Mac builds stay "not yet checked" until T-18 records a run.
		expect(result.printAgent?.files.map((f) => f.verified)).toEqual([true, false, false, false]);
	});

	it('before any build there is no card data — printAgent is null', async () => {
		const a = await makeRestaurant();
		const owner = principal(a.ownerId, a.restaurantId, 'owner');
		const empty = mkdtempSync(join(tmpdir(), 'matcami-device-empty-'));
		const result = await withDownloads(empty, () => loadAs(owner));
		expect(result.printAgent).toBeNull();
	});

	it('a staff caller is refused (403) before any manifest is read', async () => {
		const a = await makeRestaurant();
		const staff = await seedStaff(db, a.restaurantId, { displayName: 'Staff' });
		const asStaff = principal(staff.id, a.restaurantId, 'staff');
		// A manifest that would be logged as invalid the moment anything read it.
		const dir = mkdtempSync(join(tmpdir(), 'matcami-device-staff-'));
		writeFileSync(join(dir, 'manifest.json'), '{"not": "a manifest"}');
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const status = await withDownloads(dir, () =>
				statusOf(() => load(makeEvent(asStaff) as never))
			);
			expect(status).toBe(403);
			expect(logged).not.toHaveBeenCalled();
		} finally {
			logged.mockRestore();
		}
	});
});
