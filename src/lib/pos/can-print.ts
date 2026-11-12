// THE ONE RULE FOR WHAT MAY PRINT (menu-and-printing T-18).
//
// Every print path — the original receipt, the kitchen ticket and every
// reprint — asks this function first. A card receipt printed before the server
// confirmed the sale is a receipt for money the books may never hold (risk
// panel BLOCKER, tasks/menu-and-printing): completeSale writes the local order
// as `completed` for EVERY tender before the server answers, so "completed" on
// its own is not enough.
//
// The rule, by tender (invariant 5):
//   - CASH: a completed cash sale is a recorded FACT, whatever its sync status
//     — offline, pending, even `unrecorded` (the owner reviews it; the customer
//     still paid). It prints.
//   - CREDIT (tasks/customer-credit): a bill charged to a registered customer
//     is the same kind of fact — it prints at once, with its ON CREDIT lines.
//   - CARD / MOBILE: fail CLOSED. Print only once the server said `accepted` or
//     `recorded_flagged`; `rejected` is refused for good; anything else — no
//     status yet, `unrecorded`, a status this code does not know — waits.
import type { LocalOrder } from './store';
import type { Cart } from './orders';
import { tenderClass } from './tenders';

export type CanPrint =
	| { ok: true }
	| {
			ok: false;
			reason: 'not_completed' | 'no_snapshot' | 'awaiting_confirmation' | 'refused' | 'abandoned';
	  };

export function canPrint(order: LocalOrder<Cart>): CanPrint {
	if (order.state === 'abandoned') return { ok: false, reason: 'abandoned' };
	if (order.state !== 'completed') return { ok: false, reason: 'not_completed' };
	if (!order.sale) return { ok: false, reason: 'no_snapshot' };

	// A FACT tender — cash, and a charge to a customer's credit (tasks/customer-
	// credit): complete on the device, printable whatever the server said.
	const method = order.sale.payload.payments[0]?.method;
	if (tenderClass(method) === 'fact') return { ok: true };

	// Card and mobile — and any tender this code does not recognise: closed.
	if (order.syncStatus === 'accepted' || order.syncStatus === 'recorded_flagged') {
		return { ok: true };
	}
	if (order.syncStatus === 'rejected') return { ok: false, reason: 'refused' };
	return { ok: false, reason: 'awaiting_confirmation' };
}
