// THE PAY SCREEN'S TENDER LIST, AND THE OFFLINE RULE — pure, imports nothing.
// (tasks/settings-tax-payments-receipt T-22; spec 6, 13, 24, 33 decision 4.)
//
// The till offers the owner's NAMED payment methods (EVC Plus, Zaad, a card
// terminal …) as cached from the settings bundle by settings.ts (T-21): enabled,
// live methods only, cash first, then the owner's order. A method the owner
// switched off or archived is not in the cache, so it is not offered at all —
// there is no "Not accepted in settings" reason any more.
//
// Everything that DECIDES is keyed on the method's KIND (`cash` | `card` |
// `mobile`), never on its name (Risk 1; CLAUDE.md "Payment methods — decided
// 2026-10-01"): the offline rule here, the outcome, the drawer and what may
// print on the pay screen. An owner may call a mobile method "Card" and nothing
// changes because of it.
//
// The offline rule (invariant 5; Settings 1, decision 1): a completed offline
// CASH sale is a recorded fact, so cash is always available; every card- and
// mobile-kind method is DISABLED while the till is offline, with the reason in
// words on the key BEFORE the tap, so nothing ever fails after it. Card and
// mobile are never auto-completed offline.
//
// Cash is ALWAYS the first option, under the key CASH_TENDER_KEY: the cached
// Cash row when the till has one, else a synthetic Cash with no id — a till
// that has not signed in since this plan shipped, or whose cache is garbled.
// The synthetic sends no id and no name, and the server resolves the
// restaurant's Cash row (the pre-plan path, T-15). The merchant number
// (Settings 6) is the restaurant's own number customers send money to; a cash
// option never has one (the payment_methods_cash_rules CHECK forbids it).
//
// This module takes the cached methods STRUCTURALLY — plain strings, a `kind`
// that is only a string — so a garbled cache cannot break the type, and drops
// what it cannot offer: a second cash row, a kind it does not know, a repeated
// id. It never touches IndexedDB, the network or the DOM.

export type TenderKind = 'cash' | 'card' | 'mobile' | 'credit';

/**
 * THE class of a tender (invariant 5, amended 2026-11-12 by tasks/customer-
 * credit) — the ONE place the till decides it:
 *   - `fact`: cash and credit. The sale is complete on the device the moment
 *     Pay is pressed: it sells offline, prints at once, and the server records
 *     it (flagged if need be) but never rejects it. Cash puts money in the
 *     drawer; credit charges a registered customer's account and moves none.
 *   - `request`: card and mobile — and ANY kind this code does not know, which
 *     fails closed. Nothing prints until the server confirms; offline it is
 *     disabled.
 * Every "is this sale already final?" decision under src/lib/pos and
 * src/routes/(pos) calls this; a comparison with 'cash' is for what only cash
 * does (the drawer, the keypad, the change line) — tenders.test.ts holds the
 * allow-list.
 */
export function tenderClass(kind: string | null | undefined): 'fact' | 'request' {
	return kind === 'cash' || kind === 'credit' ? 'fact' : 'request';
}

/** One key on the pay screen. `key` is what the radio group selects by: the
 * literal `cash` for the cash option, the method's id for every other. `id` is
 * null only on the synthetic Cash. `icon` names an Icon.svelte glyph. */
export type TenderOption = {
	key: string;
	id: string | null;
	name: string;
	kind: TenderKind;
	merchantNumber: string | null;
	icon: 'cash' | 'card' | 'phone' | 'user-plus';
};

/** The cash option's key — the only key that is not a method id. */
export const CASH_TENDER_KEY = 'cash';

/** The reason written on every card and mobile key while the till is offline. */
export const OFFLINE_REASON = '◆ Cash only while offline';

/** Why the credit key is dead, in words (a disabled control says why). */
export const CREDIT_NEEDS_PERMISSION = 'Needs permission to take payments';
export const CREDIT_NO_CUSTOMERS = 'No customers on this till yet';

const SYNTHETIC_CASH: TenderOption = {
	key: CASH_TENDER_KEY,
	id: null,
	name: 'Cash',
	kind: 'cash',
	merchantNumber: null,
	icon: 'cash'
};

/**
 * The options the pay screen offers, from the cached methods in their cached
 * order: Cash FIRST and always (the first cached cash row, or the synthetic
 * one when there is none), then every card- and mobile-kind method under its
 * own id, then — LAST — the built-in Customer credit row when the cache holds
 * one (the server sends it only while the owner has credit switched on).
 * Dropped: a second cash row, a second credit row, a kind that is not cash,
 * card, mobile or credit, and a repeated id (an id equal to the cash key
 * included — it could not be selected apart from Cash). A cash or credit
 * option's merchant number is always null.
 */
export function tenderOptions(
	methods: ReadonlyArray<{ id: string; name: string; kind: string; merchantNumber: string | null }>
): TenderOption[] {
	const cashRow = methods.find((m) => m.kind === 'cash');
	const cash: TenderOption =
		cashRow === undefined
			? SYNTHETIC_CASH
			: { ...SYNTHETIC_CASH, id: cashRow.id, name: cashRow.name };

	const seen = new Set<string>([CASH_TENDER_KEY]);
	if (cashRow !== undefined) seen.add(cashRow.id);

	const options: TenderOption[] = [cash];
	for (const m of methods) {
		if (m.kind !== 'card' && m.kind !== 'mobile') continue;
		if (seen.has(m.id)) continue;
		seen.add(m.id);
		options.push({
			key: m.id,
			id: m.id,
			name: m.name,
			kind: m.kind,
			merchantNumber: m.merchantNumber,
			icon: m.kind === 'card' ? 'card' : 'phone'
		});
	}
	const creditRow = methods.find((m) => m.kind === 'credit' && !seen.has(m.id));
	if (creditRow !== undefined) {
		options.push({
			key: creditRow.id,
			id: creditRow.id,
			name: creditRow.name,
			kind: 'credit',
			merchantNumber: null,
			icon: 'user-plus'
		});
	}
	return options;
}

/**
 * THE offline rule, by kind (invariant 5): cash is never disabled; card and
 * mobile are disabled offline with OFFLINE_REASON. Credit is a fact like cash,
 * so it is NEVER disabled for being offline — only when the signed-in employee
 * may not take payments, or when this till has no customer cached to charge.
 * Null means the key is live.
 */
export function tenderReason(
	kind: TenderKind,
	online: boolean,
	credit: { mayTakePayment: boolean; customersCached: boolean } = {
		mayTakePayment: true,
		customersCached: true
	}
): string | null {
	if (kind === 'cash') return null;
	if (kind === 'credit') {
		if (!credit.mayTakePayment) return CREDIT_NEEDS_PERMISSION;
		if (!credit.customersCached) return CREDIT_NO_CUSTOMERS;
		return null;
	}
	return online ? null : OFFLINE_REASON;
}
