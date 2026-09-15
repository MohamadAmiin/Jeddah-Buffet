import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from './session';
import { users, type UserRole } from '../db/schema/users';
import { writeAudit } from '../audit';
import { hashPin } from '../../pin';

// THE DASHBOARD'S EMPLOYEE WRITE MODEL (spec 7, 31).
//
// Separate from employee-directory.ts ON PURPOSE: that file is the POS read model,
// which ships cached PIN hashes to a registered device. This one never reads a
// hash at all — hasPin is computed in SQL — and it is the only writer of pin_hash.
//
// PINs are hashed with the ISOMORPHIC src/lib/pin (PBKDF2-SHA256), never with
// hashPassword: spec 6 needs the same hash verified in the browser, from the bundle
// cached on the till, and argon2id has no browser build.
//
// users is not a posted record: invariant 2 covers orders, invoices, payments,
// stock movements and journal rows. Changing a PIN hash is an ordinary UPDATE, and
// it is audited in the same transaction (invariant 10).

export type EmployeeRow = {
	id: string;
	role: UserRole;
	displayName: string;
	hasPin: boolean;
	isActive: boolean;
};

type AuditContext = { actorUserId: string; ip: string | null; userAgent: string | null };

/** Everyone on the restaurant's staff, owner included, by role then name. */
export async function listEmployees(
	database: Executor,
	restaurantId: string
): Promise<EmployeeRow[]> {
	return database
		.select({
			id: users.id,
			role: users.role,
			displayName: users.displayName,
			// Computed IN SQL, so the hash never enters application memory.
			hasPin: sql<boolean>`${users.pinHash} is not null`,
			isActive: users.isActive
		})
		.from(users)
		.where(eq(users.restaurantId, restaurantId))
		.orderBy(asc(users.role), asc(users.displayName));
}

/**
 * Create a cashier or a waiter with a PIN. email and password_hash are NULL, and
 * must be: the users_non_owner_has_no_credentials CHECK rejects a non-owner with
 * either. The employee.created row is written with the same tx.
 */
export async function createEmployee(
	tx: DbTx,
	restaurantId: string,
	input: { role: 'cashier' | 'waiter'; displayName: string; pin: string },
	ctx: AuditContext
): Promise<{ id: string }> {
	const pinHash = await hashPin(input.pin);
	const [row] = await tx
		.insert(users)
		.values({
			restaurantId,
			role: input.role,
			displayName: input.displayName,
			email: null,
			passwordHash: null,
			pinHash
		})
		.returning({ id: users.id });

	// details carries the role and name only — never the PIN, and no key the audit
	// writer's secret scan would refuse.
	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: row.id,
		event: 'employee.created',
		details: { role: input.role, displayName: input.displayName },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});
	return { id: row.id };
}

/**
 * Set (or replace) an employee's PIN — the owner's own included, which is how the
 * owner's approval PIN (spec 7, 8) gets set. The tenant is in the WHERE: the user
 * id arrives from a form and is not trusted on its own. The PIN lockout pair is
 * reset with it, so a new PIN never arrives already locked. The owner's email and
 * password_hash are not touched.
 */
export async function setEmployeePin(
	tx: DbTx,
	restaurantId: string,
	userId: string,
	pin: string,
	ctx: AuditContext
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
	const pinHash = await hashPin(pin);
	const [row] = await tx
		.update(users)
		.set({ pinHash, failedPinCount: 0, pinLockedUntil: null, updatedAt: sql`now()` })
		.where(and(eq(users.id, userId), eq(users.restaurantId, restaurantId)))
		.returning({ id: users.id, role: users.role });
	if (!row) return { ok: false, reason: 'not_found' };

	await writeAudit(tx, {
		restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: row.id,
		event: 'employee.pin_set',
		details: { role: row.role },
		ip: ctx.ip,
		userAgent: ctx.userAgent
	});
	return { ok: true };
}
