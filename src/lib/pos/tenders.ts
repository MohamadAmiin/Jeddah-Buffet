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

export type TenderKind = 'cash' | 'card' | 'mobile';

/** One key on the pay screen. `key` is what the radio group selects by: the
 * literal `cash` for the cash option, the method's id for every other. `id` is
 * null only on the synthetic Cash. `icon` names an Icon.svelte glyph. */
export type TenderOption = {
	key: string;
	id: string | null;
	name: string;
	kind: TenderKind;
	merchantNumber: string | null;
	icon: 'cash' | 'card' | 'phone';
};

/** The cash option's key — the only key that is not a method id. */
export const CASH_TENDER_KEY = 'cash';

/** The reason written on every card and mobile key while the till is offline. */
export const OFFLINE_REASON = '◆ Cash only while offline';

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
 * own id. Dropped: a second cash row, a kind that is not cash, card or mobile,
 * and a repeated id (an id equal to the cash key included — it could not be
 * selected apart from Cash). A cash option's merchant number is always null.
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
	return options;
}

/**
 * THE offline rule, by kind (invariant 5): cash is never disabled; card and
 * mobile are disabled offline with OFFLINE_REASON. Null means the key is live.
 */
export function tenderReason(kind: TenderKind, online: boolean): string | null {
	if (kind === 'cash') return null;
	return online ? null : OFFLINE_REASON;
}
