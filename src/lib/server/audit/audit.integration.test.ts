import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { testDb, closeTestDb } from '../db/test/db';
import { restaurants } from '../db/schema/restaurants';
import { auditLog } from '../db/schema/audit';
import { writeAudit } from './index';

const db = testDb();

afterAll(async () => {
	await closeTestDb();
});

async function makeRestaurant(): Promise<string> {
	const [row] = await db.insert(restaurants).values({ name: 'Cafe One' }).returning();
	return row.id;
}

async function countAuditRows(): Promise<number> {
	const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log`);
	return result.rows[0].n;
}

describe('writeAudit runs inside the caller transaction (invariant 10)', () => {
	// THE important test. It is what stops a later refactor moving writeAudit
	// outside the transaction "for clarity": either the action and its audit row
	// both commit, or neither does.
	it('leaves NO row behind when the surrounding transaction rolls back', async () => {
		const restaurantId = await makeRestaurant();
		const before = await countAuditRows();

		const boom = new Error('the action failed after the audit row was written');
		await expect(
			db.transaction(async (tx) => {
				await writeAudit(tx, {
					restaurantId,
					actorUserId: null,
					subjectUserId: null,
					event: 'logout',
					details: {},
					ip: null,
					userAgent: null
				});
				// The row exists inside the transaction...
				const inside = await tx.execute<{ n: number }>(
					sql`select count(*)::int as n from audit_log`
				);
				expect(inside.rows[0].n).toBe(before + 1);
				// ...and then the action fails.
				throw boom;
			})
		).rejects.toThrow(boom);

		expect(await countAuditRows()).toBe(before);
	});

	it('leaves exactly one row when the transaction commits', async () => {
		const restaurantId = await makeRestaurant();
		const before = await countAuditRows();

		await db.transaction(async (tx) => {
			await writeAudit(tx, {
				restaurantId,
				actorUserId: null,
				subjectUserId: null,
				event: 'login.success',
				details: { email: 'owner@cafe.com' },
				ip: '203.0.113.7',
				userAgent: 'test-agent'
			});
		});

		expect(await countAuditRows()).toBe(before + 1);

		// Read through the TYPED query, the way application code will: drizzle maps
		// timestamptz to Date, whereas a raw db.execute() hands back the string
		// postgres sent.
		const [row] = await db.select().from(auditLog).limit(1);
		expect(row.event).toBe('login.success');
		expect(row.ip).toBe('203.0.113.7');
		expect(row.userAgent).toBe('test-agent');
		expect(row.details).toEqual({ email: 'owner@cafe.com' });
		expect(row.occurredAt).toBeInstanceOf(Date);
		// audit_log.id is bigint mode 'bigint', so it is a JS bigint, not a number.
		expect(typeof row.id).toBe('bigint');
	});

	it('honours an explicit occurredAt, for offline events synced later', async () => {
		const restaurantId = await makeRestaurant();
		const deviceTime = new Date('2026-01-02T03:04:05.000Z');

		await db.transaction(async (tx) => {
			await writeAudit(tx, {
				restaurantId,
				actorUserId: null,
				subjectUserId: null,
				event: 'logout',
				details: {},
				ip: null,
				userAgent: null,
				occurredAt: deviceTime
			});
		});

		const [row] = await db.select().from(auditLog).limit(1);
		expect(row.occurredAt.toISOString()).toBe(deviceTime.toISOString());
		// created_at is when the row was WRITTEN, which is not the device time.
		expect(row.createdAt.getTime()).toBeGreaterThan(row.occurredAt.getTime());
	});

	it('refuses to write a details object carrying a secret, before any SQL runs', async () => {
		const restaurantId = await makeRestaurant();
		const before = await countAuditRows();

		await expect(
			db.transaction(async (tx) => {
				await writeAudit(tx, {
					restaurantId,
					actorUserId: null,
					subjectUserId: null,
					// Deliberately wrong shape: this is the leak the guard exists to stop.
					event: 'settings.updated',
					details: { changes: { password: { old: 'a', new: 'b' } } },
					ip: null,
					userAgent: null
				});
			})
		).rejects.toThrow(/looks like a secret/);

		expect(await countAuditRows()).toBe(before);
	});
});
