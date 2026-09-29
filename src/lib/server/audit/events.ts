import type { UserRole } from '../db/schema/users';

// The events this plan emits, as a DISCRIMINATED UNION with the exact shape of
// each one's `details`. Nothing else may be written.
//
// A typed union rather than Record<string, unknown> is the mechanism; "never put
// a password in details" as a comment is only a wish. Later plans EXTEND this
// union — they do not widen it to accept arbitrary objects.
export type AuditEvent =
	| {
			event: 'restaurant.registered';
			details: { restaurantName: string; timeZone: string; signupKey: string | null };
	  }
	| { event: 'user.created'; details: { role: UserRole; displayName: string } }
	| { event: 'login.success'; details: { email: string } }
	| { event: 'login.failed'; details: { email: string; reason: 'bad_password' } }
	| { event: 'login.locked_out'; details: { email: string; failedCount: number } }
	| { event: 'login.rejected_locked'; details: { email: string } }
	| { event: 'logout'; details: Record<string, never> }
	| {
			event: 'settings.updated';
			details: { changes: Record<string, { old: unknown; new: unknown }> };
	  }
	| { event: 'user.password_reset_by_operator'; details: { via: 'cli' } }
	| { event: 'pos.device.registered'; details: { deviceCode: string; label: string } }
	| { event: 'pos.device.revoked'; details: { deviceCode: string; label: string } }
	| { event: 'pos.pin.success'; details: { deviceCode: string; roleName: string } }
	| {
			event: 'pos.pin.failed';
			details: {
				deviceCode: string;
				reason: 'bad_pin' | 'rejected_locked';
				failedCount: number;
			};
	  }
	| {
			event: 'pos.pin.locked_out';
			details: { deviceCode: string; failedCount: number; lockedForMs: number };
	  }
	| { event: 'employee.created'; details: { roleName: string; displayName: string } }
	| { event: 'employee.pin_set'; details: { roleName: string } }
	| {
			event: 'employee.updated';
			details: { changes: Record<string, { old: unknown; new: unknown }> };
	  }
	| { event: 'employee.deactivated'; details: { roleName: string; displayName: string } }
	| { event: 'employee.reactivated'; details: { roleName: string; displayName: string } }
	| {
			event: 'employee.lockout_cleared';
			details: { displayName: string; failedCount: number; wasLocked: boolean };
	  }
	| { event: 'role.created'; details: { name: string; permissionKeys: string[] } }
	| { event: 'role.updated'; details: { changes: Record<string, { old: unknown; new: unknown }> } }
	| { event: 'role.archived'; details: { name: string } }
	| {
			event: 'menu.price_changed';
			details: {
				target: 'item' | 'modifier';
				targetId: string;
				name: string;
				oldPriceMinor: string;
				newPriceMinor: string;
			};
	  }
	// ── POS sales (tasks/pos-sales T-15) ──
	//
	// writeAudit calls assertNoSecrets(details) inside the action's own
	// transaction and throws on any KEY at any depth matching
	// /pass|pin|token|hash|secret|cookie|authorization/i, so keys such as
	// pinLogin, deviceToken or opToken would roll back the very sale being
	// recorded. Every `details` shape below uses deviceCode (the printed
	// POS1, never a token), opId (the pos_sync_ops.id bigint as a decimal
	// string), kind (the op kind literal), or a reason enum — no key that
	// matches the forbidden regex. The event NAME may contain 'pin'
	// (pos.pin.offline_*): the guard reads DETAILS keys, not event names,
	// and pos.pin.failed already exists.
	//
	// Amounts in details are decimal strings of the integer minor value
	// (bigint cannot cross jsonb; invariant 1).
	//
	// pos.pin.offline_failed carries no failedCount: the offline path runs
	// no lockout counter — spec 7's five-attempt lock lives in the server
	// verifier; the device only records the attempt.
	| {
			event: 'pos.session.opened';
			details: {
				deviceCode: string;
				businessDate: string;
				openingCashMinor: string;
				attached: boolean;
			};
	  }
	| {
			event: 'pos.session.closed';
			details: {
				deviceCode: string;
				businessDate: string;
				expectedCashMinor: string;
				countedCashMinor: string;
				differenceMinor: string;
			};
	  }
	| {
			event: 'sale.recorded';
			details: {
				deviceCode: string;
				invoiceNumber: string;
				orderType: 'dine_in' | 'takeaway';
				method: 'cash' | 'card' | 'mobile';
				totalMinor: string;
			};
	  }
	| {
			event: 'sale.flagged';
			details: { deviceCode: string; invoiceNumber: string; flags: string[] };
	  }
	| {
			event: 'sale.abandoned';
			details: { deviceCode: string; invoiceNumber: string; reason: 'rejected' | 'cancelled' };
	  }
	| {
			event: 'sync.op_unrecorded';
			details: { deviceCode: string; kind: string; flag: string; detail: string };
	  }
	| {
			event: 'sync.op_retried';
			details: { opId: string; outcome: 'accepted' | 'recorded_flagged' | 'unrecorded' };
	  }
	| { event: 'sync.op_dismissed'; details: { opId: string; reason: string } }
	| { event: 'pos.pin.offline_success'; details: { deviceCode: string } }
	| { event: 'pos.pin.offline_failed'; details: { deviceCode: string; reason: 'bad_pin' } }
	// tasks/inventory-cogs (T-15). Amounts and quantities are decimal STRINGS —
	// jsonb cannot hold a bigint — and no key may contain "pin" (shipping,
	// mapping, grouping…) or any other word assertNoSecrets refuses.
	| {
			event: 'ingredient.created';
			details: { ingredientId: string; name: string; baseUnit: string };
	  }
	| {
			event: 'ingredient.updated';
			details: { ingredientId: string; changes: Record<string, { old: unknown; new: unknown }> };
	  }
	| { event: 'ingredient.archived'; details: { ingredientId: string; name: string } }
	| {
			event: 'purchase_unit.added';
			details: { ingredientId: string; unitName: string; baseQtyPerUnit: string };
	  }
	| { event: 'purchase_unit.archived'; details: { ingredientId: string; unitName: string } }
	| {
			event: 'recipe.changed';
			details: {
				ownerKind: 'item' | 'modifier';
				ownerId: string;
				ownerName: string;
				before: { ingredientId: string; qty: string }[];
				after: { ingredientId: string; qty: string }[];
			};
	  }
	| {
			event: 'purchase.recorded';
			details: {
				purchaseId: string;
				supplierName: string;
				paidBy: 'cash' | 'bank' | 'credit';
				totalMinor: string;
				lineCount: number;
			};
	  }
	| {
			event: 'purchase.reversed';
			details: { purchaseId: string; totalMinor: string; reason: string; revaluationMinor: string };
	  }
	| {
			event: 'supplier.paid';
			details: {
				paymentId: string;
				purchaseId: string;
				amountMinor: string;
				paidFrom: 'cash' | 'bank';
			};
	  }
	| {
			event: 'supplier.payment_reversed';
			details: { paymentId: string; purchaseId: string; amountMinor: string; reason: string };
	  }
	| {
			event: 'waste.recorded';
			details: {
				wasteId: string;
				ingredientId: string;
				qty: string;
				reason: string;
				costMinor: string;
			};
	  }
	| {
			event: 'stock.counted';
			details: {
				countId: string;
				lineCount: number;
				shortfallMinor: string;
				surplusMinor: string;
			};
	  }
	| {
			event: 'opening_stock.recorded';
			details: { entryId: string; ingredientId: string; qty: string; valueMinor: string };
	  };

export type AuditEventName = AuditEvent['event'];

export const AUDIT_EVENT_NAMES = [
	'restaurant.registered',
	'user.created',
	'login.success',
	'login.failed',
	'login.locked_out',
	'login.rejected_locked',
	'logout',
	'settings.updated',
	'user.password_reset_by_operator',
	'pos.device.registered',
	'pos.device.revoked',
	'pos.pin.success',
	'pos.pin.failed',
	'pos.pin.locked_out',
	'employee.created',
	'employee.pin_set',
	'employee.updated',
	'employee.deactivated',
	'employee.reactivated',
	'employee.lockout_cleared',
	'role.created',
	'role.updated',
	'role.archived',
	'menu.price_changed',
	'pos.session.opened',
	'pos.session.closed',
	'sale.recorded',
	'sale.flagged',
	'sale.abandoned',
	'sync.op_unrecorded',
	'sync.op_retried',
	'sync.op_dismissed',
	'pos.pin.offline_success',
	'pos.pin.offline_failed',
	'ingredient.created',
	'ingredient.updated',
	'ingredient.archived',
	'purchase_unit.added',
	'purchase_unit.archived',
	'recipe.changed',
	'purchase.recorded',
	'purchase.reversed',
	'supplier.paid',
	'supplier.payment_reversed',
	'waste.recorded',
	'stock.counted',
	'opening_stock.recorded'
] as const satisfies readonly AuditEventName[];

type AssertTrue<T extends true> = T;

export type _NoMissingAuditEventNames = AssertTrue<
	Exclude<AuditEventName, (typeof AUDIT_EVENT_NAMES)[number]> extends never ? true : false
>;
