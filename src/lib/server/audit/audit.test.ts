import { describe, it, expect } from 'vitest';
import { assertNoSecrets } from './index';
import type { AuditEvent } from './events';

type DetailsOf<E extends AuditEvent['event']> = Extract<AuditEvent, { event: E }>['details'];

describe('assertNoSecrets', () => {
	it.each([
		['a top-level password', { password: 'x' }],
		['a nested pin hash', { user: { pinHash: 'x' } }],
		['a session token', { sessionToken: 'x' }],
		['a bare token', { token: 'x' }],
		['a secret', { mySecret: 'x' }],
		['a cookie', { cookie: 'a=b' }],
		['an authorization header', { authorization: 'Bearer x' }],
		['a password_hash in snake case', { password_hash: 'x' }],
		['one inside an array', { items: [{ ok: 1 }, { apiToken: 'x' }] }],
		['one three levels down', { a: { b: { c: { passphrase: 'x' } } } }]
	])('throws for %s', (_label, details) => {
		expect(() => assertNoSecrets(details)).toThrow(/looks like a secret/);
	});

	it('names the path to the offending key, never its value', () => {
		expect(() => assertNoSecrets({ user: { pinHash: 'super-secret-value' } })).toThrow(
			/details\.user\.pinHash/
		);
		try {
			assertNoSecrets({ user: { pinHash: 'super-secret-value' } });
		} catch (error) {
			expect((error as Error).message).not.toContain('super-secret-value');
		}
	});

	it.each([
		['an email', { email: 'a@b.c' }],
		['a settings diff', { changes: { name: { old: 'A', new: 'B' } } }],
		['a role and display name', { role: 'owner', displayName: 'Owner' }],
		['an empty object', {}],
		['a failed count', { email: 'a@b.c', failedCount: 5 }],
		// The POS event shapes. A key such as failedPinCount would trip the guard and
		// roll back the very lockout the row was recording — these cases are what
		// would have caught it.
		['a POS pin failure', { deviceCode: 'POS1', reason: 'bad_pin', failedCount: 3 }],
		['a POS lockout', { deviceCode: 'POS1', failedCount: 5, lockedForMs: 300000 }],
		['a POS device registration', { deviceCode: 'POS1', label: 'Counter tablet' }],
		['an employee record', { role: 'cashier', displayName: 'Sam' }]
	])('passes for %s', (_label, details) => {
		expect(() => assertNoSecrets(details)).not.toThrow();
	});

	it('does not trip on non-object values', () => {
		expect(() => assertNoSecrets(null)).not.toThrow();
		expect(() => assertNoSecrets('a string')).not.toThrow();
		expect(() => assertNoSecrets(42)).not.toThrow();
	});

	// The T-15 details shapes. Every key uses deviceCode / opId / kind / reason
	// (not pinLogin, deviceToken, or opToken), which is the reason writeAudit
	// can be called from inside recordSale (T-19) without ever rolling back
	// the sale it is recording.
	it.each([
		[
			'pos.session.opened',
			{
				deviceCode: 'POS1',
				businessDate: '2026-09-28',
				openingCashMinor: '50000',
				attached: false
			}
		],
		[
			'pos.session.closed',
			{
				deviceCode: 'POS1',
				businessDate: '2026-09-28',
				expectedCashMinor: '200000',
				countedCashMinor: '199000',
				differenceMinor: '-1000'
			}
		],
		[
			'sale.recorded',
			{
				deviceCode: 'POS1',
				invoiceNumber: 'POS1-000001',
				orderType: 'takeaway' as const,
				method: 'cash' as const,
				totalMinor: '1100'
			}
		],
		[
			'sale.flagged',
			{
				deviceCode: 'POS1',
				invoiceNumber: 'POS1-000001',
				flags: ['employee_not_permitted']
			}
		],
		[
			'sale.abandoned',
			{
				deviceCode: 'POS1',
				invoiceNumber: 'POS1-000002',
				reason: 'rejected' as const
			}
		],
		[
			'sync.op_unrecorded',
			{
				deviceCode: 'POS1',
				kind: 'sale.complete',
				flag: 'unknown_session',
				detail: 'no session found'
			}
		],
		['sync.op_retried', { opId: '42', outcome: 'accepted' as const }],
		['sync.op_dismissed', { opId: '42', reason: 'Test sale during training' }],
		['pos.pin.offline_success', { deviceCode: 'POS1' }],
		['pos.pin.offline_failed', { deviceCode: 'POS1', reason: 'bad_pin' as const }]
	])('passes for the T-15 shape %s', (_name, details) => {
		expect(() => assertNoSecrets(details)).not.toThrow();
	});

	// tasks/inventory-cogs T-15: every inventory shape type-checks as its member
	// (`satisfies`) and passes the guard, so no inventory write can be rolled
	// back by its own audit row.
	const id = '00000000-0000-0000-0000-000000000001';
	it.each([
		[
			'ingredient.created',
			{ ingredientId: id, name: 'Flour', baseUnit: 'g' } satisfies DetailsOf<'ingredient.created'>
		],
		[
			'ingredient.updated',
			{
				ingredientId: id,
				changes: { name: { old: 'Flour', new: 'Bread flour' } }
			} satisfies DetailsOf<'ingredient.updated'>
		],
		[
			'ingredient.archived',
			{ ingredientId: id, name: 'Flour' } satisfies DetailsOf<'ingredient.archived'>
		],
		[
			'purchase_unit.added',
			{
				ingredientId: id,
				unitName: 'kg',
				baseQtyPerUnit: '1000.000'
			} satisfies DetailsOf<'purchase_unit.added'>
		],
		[
			'purchase_unit.archived',
			{ ingredientId: id, unitName: 'kg' } satisfies DetailsOf<'purchase_unit.archived'>
		],
		[
			'recipe.changed',
			{
				ownerKind: 'item',
				ownerId: id,
				ownerName: 'Burger',
				before: [],
				after: [{ ingredientId: id, qty: '150.000' }]
			} satisfies DetailsOf<'recipe.changed'>
		],
		[
			'purchase.recorded',
			{
				purchaseId: id,
				supplierName: 'Market',
				paidBy: 'credit',
				totalMinor: '11000',
				lineCount: 2
			} satisfies DetailsOf<'purchase.recorded'>
		],
		[
			'purchase.reversed',
			{
				purchaseId: id,
				totalMinor: '11000',
				reason: 'Entered twice',
				revaluationMinor: '0'
			} satisfies DetailsOf<'purchase.reversed'>
		],
		[
			'supplier.paid',
			{
				paymentId: id,
				purchaseId: id,
				amountMinor: '5000',
				paidFrom: 'bank'
			} satisfies DetailsOf<'supplier.paid'>
		],
		[
			'supplier.payment_reversed',
			{
				paymentId: id,
				purchaseId: id,
				amountMinor: '5000',
				reason: 'Wrong amount'
			} satisfies DetailsOf<'supplier.payment_reversed'>
		],
		[
			'waste.recorded',
			{
				wasteId: id,
				ingredientId: id,
				qty: '150.000',
				reason: 'spoilage',
				costMinor: '82'
			} satisfies DetailsOf<'waste.recorded'>
		],
		[
			'stock.counted',
			{
				countId: id,
				lineCount: 12,
				shortfallMinor: '300',
				surplusMinor: '0'
			} satisfies DetailsOf<'stock.counted'>
		],
		[
			'opening_stock.recorded',
			{
				entryId: id,
				ingredientId: id,
				qty: '2000.000',
				valueMinor: '1100'
			} satisfies DetailsOf<'opening_stock.recorded'>
		]
	])('passes for the inventory shape %s', (_name, details) => {
		expect(() => assertNoSecrets(details)).not.toThrow();
	});
});
