/**
 * Pure helpers for the Customers pages (tasks/customer-credit T-21): the zod
 * schemas, the limit reader and the refusal messages. Nothing here touches the
 * database, and nothing here is imported into a .svelte component: zod stays on
 * the server.
 *
 * NO MONEY ARITHMETIC (invariant 1). A typed credit limit is read ONCE by the
 * menu page's parsePriceInput (imported, never copied); nothing here adds,
 * rounds or compares money.
 */
import { z } from 'zod';
import type { Minor } from '../../../lib/money';
import { parsePriceInput } from '../menu/helpers';

export { firstMessage } from '../menu/helpers';
export { amountText, CURRENCY_MESSAGE } from '../inventory/helpers';

export const NAME_MESSAGE = 'Enter a name of 1 to 80 characters.';
export const PHONE_MESSAGE = 'Enter a phone number of 3 to 32 characters.';
export const PHONE_TAKEN_MESSAGE = 'Another customer already has that phone number.';
export const LIMIT_MESSAGE = 'Enter the credit limit as an amount, or leave it empty for no limit.';
export const LIMIT_NEEDS_CURRENCY = 'Set the currency in Settings before entering a credit limit.';
export const NOT_FOUND_MESSAGE = 'That customer no longer exists. Reload the page.';
export const PAYMENT_NOT_FOUND_MESSAGE = 'That payment no longer exists. Reload the page.';
export const REASON_MESSAGE = 'Give a reason of 3 to 200 characters.';
export const ALREADY_REVERSED_MESSAGE = 'This payment was already reversed.';
export const SHIFT_CLOSED_MESSAGE =
	"This cash payment's shift is closed, so it can no longer be reversed.";
export const HAS_BALANCE_MESSAGE =
	'This customer still owes money (or a payment is unsettled). Archive them once the balance is zero.';
export const HAS_UNRECORDED_MESSAGE =
	'A credit sale to this customer is waiting on the Flagged sales page. Record or dismiss it first.';
export const ALREADY_ARCHIVED_MESSAGE = 'This customer is already archived.';
export const NOT_ARCHIVED_MESSAGE = 'This customer is not archived.';
export const RESTORE_PHONE_TAKEN_MESSAGE =
	'Another customer now has that phone number. Change one of them before restoring.';

/** The words for every refusal the customers module can return. */
export const REFUSALS: Record<string, string> = {
	invalid_name: NAME_MESSAGE,
	invalid_phone: PHONE_MESSAGE,
	invalid_limit: LIMIT_MESSAGE,
	phone_taken: PHONE_TAKEN_MESSAGE,
	not_found: NOT_FOUND_MESSAGE,
	has_balance: HAS_BALANCE_MESSAGE,
	has_unrecorded_charge: HAS_UNRECORDED_MESSAGE,
	already_archived: ALREADY_ARCHIVED_MESSAGE,
	not_archived: NOT_ARCHIVED_MESSAGE,
	already_reversed: ALREADY_REVERSED_MESSAGE,
	invalid_reason: REASON_MESSAGE,
	shift_closed: SHIFT_CLOSED_MESSAGE
};

export const FALLBACK_MESSAGE = 'That could not be saved. Reload the page and try again.';

export function refusalMessage(reason: string): string {
	return REFUSALS[reason] ?? FALLBACK_MESSAGE;
}

export const idSchema = z.uuid();

/** The shape only: the module cleans and bounds the name and the phone itself,
 * so the page and the till can never disagree about what a valid one is. */
export const customerSchema = z.object({
	name: z.string().max(400, NAME_MESSAGE),
	phone: z.string().max(200, PHONE_MESSAGE),
	creditLimit: z.string().max(40, LIMIT_MESSAGE)
});

export const reversePaymentSchema = z.object({
	paymentId: z.uuid(PAYMENT_NOT_FOUND_MESSAGE),
	reason: z.string().trim().min(3, REASON_MESSAGE).max(200, REASON_MESSAGE)
});

/**
 * A typed credit limit: empty means NO limit (null); otherwise an amount in the
 * restaurant's currency, read by parsePriceInput — never a float.
 */
export function readLimit(
	raw: string,
	exponent: number | null
): { ok: true; limit: Minor | null } | { ok: false; message: string } {
	if (raw.trim() === '') return { ok: true, limit: null };
	if (exponent === null) return { ok: false, message: LIMIT_NEEDS_CURRENCY };
	const parsed = parsePriceInput(raw, exponent);
	if (!parsed.ok) return { ok: false, message: LIMIT_MESSAGE };
	return { ok: true, limit: parsed.minor };
}
