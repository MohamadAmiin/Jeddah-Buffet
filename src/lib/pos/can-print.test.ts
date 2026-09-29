import { describe, expect, it } from 'vitest';
import type { LocalOrder, SaleSnapshot } from './store';
import type { Cart } from './orders';
import { canPrint } from './can-print';

// MANDATORY — invariant 5's fail-closed rule for card and mobile, and "a
// completed cash sale is a fact" (menu-and-printing T-18).

function snapshot(method: 'cash' | 'card' | 'mobile'): SaleSnapshot {
	return {
		payload: {
			orderId: 'o1',
			posSessionId: 's1',
			orderType: 'takeaway',
			tableLabel: null,
			taxMode: 'exclusive',
			currencyCode: 'USD',
			menuVersion: 1,
			invoiceSeq: 1,
			invoiceNumber: 'POS1-000001',
			openedAt: '2026-09-29T09:00:00.000Z',
			lines: [],
			totals: { subtotalMinor: '800', discountMinor: '0', taxMinor: '80', totalMinor: '880' },
			payments: [
				{
					paymentId: 'p1',
					method,
					amountMinor: '880',
					tenderedMinor: method === 'cash' ? '1000' : null,
					changeMinor: method === 'cash' ? '120' : null
				}
			]
		} as SaleSnapshot['payload'],
		lineAmountsMinor: ['800'],
		cashierName: 'Sam',
		completedAt: '2026-09-29T09:01:00.000Z',
		businessDate: '2026-09-29'
	};
}

function order(over: Partial<LocalOrder<Cart>>): LocalOrder<Cart> {
	return {
		id: 'o1',
		deviceId: 'd1',
		state: 'completed',
		cart: {} as Cart,
		completedAt: '2026-09-29T09:01:00.000Z',
		...over
	};
}

describe('canPrint', () => {
	it('a completed cash sale prints whatever its sync status — a fact, not a request', () => {
		expect(canPrint(order({ sale: snapshot('cash') }))).toEqual({ ok: true });
		expect(canPrint(order({ sale: snapshot('cash'), syncStatus: 'unrecorded' }))).toEqual({
			ok: true
		});
		expect(canPrint(order({ sale: snapshot('cash'), syncStatus: 'recorded_flagged' }))).toEqual({
			ok: true
		});
	});

	it('a card sale waits for the server, prints once accepted or recorded_flagged, is refused when rejected', () => {
		expect(canPrint(order({ sale: snapshot('card') }))).toEqual({
			ok: false,
			reason: 'awaiting_confirmation'
		});
		expect(canPrint(order({ sale: snapshot('card'), syncStatus: 'accepted' }))).toEqual({
			ok: true
		});
		expect(canPrint(order({ sale: snapshot('card'), syncStatus: 'recorded_flagged' }))).toEqual({
			ok: true
		});
		expect(canPrint(order({ sale: snapshot('card'), syncStatus: 'rejected' }))).toEqual({
			ok: false,
			reason: 'refused'
		});
		// Fail closed: unrecorded is not a confirmation.
		expect(canPrint(order({ sale: snapshot('card'), syncStatus: 'unrecorded' }))).toEqual({
			ok: false,
			reason: 'awaiting_confirmation'
		});
	});

	it('mobile behaves exactly as card', () => {
		expect(canPrint(order({ sale: snapshot('mobile') }))).toEqual({
			ok: false,
			reason: 'awaiting_confirmation'
		});
		expect(canPrint(order({ sale: snapshot('mobile'), syncStatus: 'accepted' }))).toEqual({
			ok: true
		});
		expect(canPrint(order({ sale: snapshot('mobile'), syncStatus: 'rejected' }))).toEqual({
			ok: false,
			reason: 'refused'
		});
	});

	it('an abandoned order, a cart, and a completed order with no snapshot never print', () => {
		expect(canPrint(order({ state: 'abandoned', sale: snapshot('card') }))).toEqual({
			ok: false,
			reason: 'abandoned'
		});
		expect(canPrint(order({ state: 'cart' }))).toEqual({ ok: false, reason: 'not_completed' });
		expect(canPrint(order({}))).toEqual({ ok: false, reason: 'no_snapshot' });
	});
});
