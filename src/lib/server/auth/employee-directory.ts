import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from './session';
import { users, type UserRole } from '../db/schema/users';

// THE POS EMPLOYEE DIRECTORY — and the one read in this codebase that returns a
// credential derivative ON PURPOSE.
//
// listPosEmployees returns each employee's PIN hash, as `pinPhc`. That is the
// most surprising line in the module and it is deliberate: spec 6 requires a
// registered device to verify a PIN OFFLINE from hashes cached on it, so the
// hash has to reach the device or offline employee switching cannot exist. Do not
// "fix" this by removing the field, or by changing the hash here.
//
// The compensating controls (spec 6, 7 and 8), all built by this plan:
//   - the bundle is served ONLY to a registered device: GET /api/pos/employees
//     resolves the device cookie first and answers 403 otherwise;
//   - the owner can revoke that device from the dashboard;
//   - every action that moves money needs an owner-PIN approval.
// The residual risk is recorded and ACCEPTED (CLAUDE.md, "Decisions already made",
// and the GAP heading in tasks/pos-access-and-menu/RESEARCH.md): a 4–6 digit PIN
// has at most 10^6 values, so whoever holds the tablet holds unlimited offline
// guesses whatever the algorithm. It is not an oversight.
//
// IT MUST NEVER REACH A DASHBOARD PAGE OR A LOAD FUNCTION'S RETURN VALUE.
// SvelteKit serialises load data into the page HTML and into __data.json — the
// same reasoning the Principal comment in ./session.ts gives for never projecting
// users.*. Its only caller is GET /api/pos/employees.
//
// The field is named `pinPhc` on purpose: SECRET_KEY_PATTERN in ../audit matches
// it, so if one of these objects is ever passed to writeAudit the write THROWS
// instead of putting a credential derivative into an append-only table. The name
// is a tripwire.
//
// It takes a restaurantId and knows nothing about devices. That a revoked device
// receives nothing is asserted at the ROUTE, not here — do not add a device
// parameter to this function.

export type PosEmployee = {
	id: string;
	displayName: string;
	role: UserRole;
	isActive: boolean;
	pinPhc: string | null;
};

/**
 * Every ACTIVE employee of one restaurant — the owner included, because the
 * owner's POS PIN approves sensitive actions and that must work offline too — in
 * a stable order (role, then name) so the list does not reshuffle between syncs.
 *
 * Five columns, named explicitly; email, the password hash and both lockout
 * pairs never leave the server. An employee with no PIN is returned with
 * `pinPhc: null`: the till shows them as unavailable, because hiding them would
 * make "why is Sam missing from the till?" unanswerable from the screen.
 */
export async function listPosEmployees(
	database: Executor,
	restaurantId: string
): Promise<PosEmployee[]> {
	return database
		.select({
			id: users.id,
			displayName: users.displayName,
			role: users.role,
			isActive: users.isActive,
			pinPhc: users.pinHash
		})
		.from(users)
		.where(and(eq(users.restaurantId, restaurantId), eq(users.isActive, true)))
		.orderBy(asc(users.role), asc(users.displayName));
}
