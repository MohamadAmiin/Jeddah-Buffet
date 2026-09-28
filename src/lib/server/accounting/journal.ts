// The journal writer. Takes the caller's DbTx and NEVER opens one of its own
// (invariant 4: one all-or-nothing transaction at payment; spec 13). Drops
// every line whose amount is 0n before inserting, and returns null without
// inserting when nothing remains (a free order legitimately posts nothing;
// T-09's deferred triggers also fire on journal_entries so an empty header
// could never commit). No update and no delete path (invariant 2): a mistake
// is corrected with a REVERSING entry, created only by postReversal below.

import { and, asc, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { journalEntries, journalEntryLines, accounts } from '../db/schema/accounting';
import { accountIdByCode } from './chart';
import type { PostingEvent, RuleLine } from './posting-rules';
import { minor, toBigInt, type Minor } from '../../money';

/** Every source an entry may name; spelled exactly as
 * journal_entries_source_type_valid (tasks/inventory-cogs T-06, T-13). */
export const JOURNAL_SOURCE_TYPES = [
	'order',
	'pos_session',
	'purchase',
	'supplier_payment',
	'waste_entry',
	'stock_count',
	'opening_stock'
] as const;
export type JournalSourceType = (typeof JOURNAL_SOURCE_TYPES)[number];

export type JournalEntryInput = {
	restaurantId: string;
	/** The POS session's business date as 'YYYY-MM-DD' — never derived from a
	 * timestamp here (invariant 11). */
	businessDate: string;
	event: PostingEvent;
	sourceType: JournalSourceType;
	sourceId: string;
	memo: string;
	lines: RuleLine[];
};

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Post a journal entry inside the caller's transaction. Returns null (and
 * writes nothing) when every line's amount is 0n. */
export async function postEntry(
	tx: DbTx,
	entry: JournalEntryInput
): Promise<{ entryId: string } | null> {
	if (!BUSINESS_DATE.test(entry.businessDate)) {
		throw new TypeError(`businessDate must be YYYY-MM-DD; got ${entry.businessDate}`);
	}

	// 2. Shape-check every line as given, before dropping.
	entry.lines.forEach((line, index) => {
		const hasDebit = line.debit !== undefined;
		const hasCredit = line.credit !== undefined;
		if (hasDebit === hasCredit) {
			throw new Error(`line ${index + 1} (${line.code}) must carry exactly one of debit or credit`);
		}
		const amount = (hasDebit ? line.debit : line.credit) as bigint;
		if (typeof amount !== 'bigint') {
			throw new Error(`line ${index + 1} (${line.code}) amount must be a bigint`);
		}
		if (amount < 0n) {
			throw new Error(`line ${index + 1} (${line.code}) amount must be non-negative`);
		}
	});

	// 3. Drop zero-amount lines (writer's job — T-04's line CHECK rejects them).
	const kept = entry.lines.filter((line) => {
		const amount = (line.debit ?? line.credit) as bigint;
		return amount > 0n;
	});
	// 4. Nothing left → return null WITHOUT any SQL.
	if (kept.length === 0) return null;

	// 5. Resolve every distinct code to an account id BEFORE any insert.
	const codes = Array.from(new Set(kept.map((l) => l.code)));
	const accountByCode = new Map<string, string>();
	for (const code of codes) {
		accountByCode.set(code, await accountIdByCode(tx, entry.restaurantId, code));
	}

	// 6. Insert the header, return the id.
	const [header] = await tx
		.insert(journalEntries)
		.values({
			restaurantId: entry.restaurantId,
			event: entry.event,
			sourceType: entry.sourceType,
			sourceId: entry.sourceId,
			memo: entry.memo,
			businessDate: entry.businessDate,
			postedAt: new Date()
		})
		.returning({ id: journalEntries.id });

	// 7. Insert the lines in one statement, in the order they arrived.
	await tx.insert(journalEntryLines).values(
		kept.map((line, index) => ({
			restaurantId: entry.restaurantId,
			entryId: header.id,
			accountId: accountByCode.get(line.code)!,
			lineNo: index + 1,
			debitMinor: line.debit ?? 0n,
			creditMinor: line.credit ?? 0n
		}))
	);

	return { entryId: header.id };
}

/**
 * Reverse a posted entry (spec 22: "A mistake is fixed with a reversing entry
 * plus a correct new entry"). THE ONLY WAY a reversing entry is created.
 *
 * Inserts a mirror of the original — same event, source_type and source_id,
 * every line's debit and credit swapped, line_no preserved — pointing at it
 * through reverses_entry_id, on the business date GIVEN (the day the reversal
 * is made, never the original's — invariant 11, CLAUDE.md "Inventory 9"). The
 * original is never touched (invariant 2; 0012's append-only triggers would
 * refuse it anyway). The mirror balances because every line is swapped, and
 * the deferred trigger still checks it at COMMIT (invariant 3).
 *
 * The header read is scoped to the restaurant — entryLines is not — which is
 * what makes this tenant-safe: another restaurant's id is "not found". A
 * second reversal of the same entry fails with 23505 on
 * journal_entries_reverses_entry_unique; callers lock their business row first
 * so they can answer "already reversed" cleanly. Takes the caller's tx, never
 * opens one, never catches.
 */
export async function postReversal(
	tx: DbTx,
	input: { restaurantId: string; entryId: string; businessDate: string; memo: string }
): Promise<{ entryId: string }> {
	if (!BUSINESS_DATE.test(input.businessDate)) {
		throw new TypeError(`businessDate must be YYYY-MM-DD; got ${input.businessDate}`);
	}

	const [original] = await tx
		.select({
			event: journalEntries.event,
			sourceType: journalEntries.sourceType,
			sourceId: journalEntries.sourceId,
			reversesEntryId: journalEntries.reversesEntryId
		})
		.from(journalEntries)
		.where(
			and(eq(journalEntries.id, input.entryId), eq(journalEntries.restaurantId, input.restaurantId))
		);
	if (!original) throw new Error('journal entry not found');
	if (original.reversesEntryId !== null) throw new Error('a reversal cannot be reversed');

	const lines = await entryLines(tx, input.entryId);

	const accountByCode = new Map<string, string>();
	for (const code of new Set(lines.map((l) => l.code))) {
		accountByCode.set(code, await accountIdByCode(tx, input.restaurantId, code));
	}

	const [header] = await tx
		.insert(journalEntries)
		.values({
			restaurantId: input.restaurantId,
			event: original.event,
			sourceType: original.sourceType,
			sourceId: original.sourceId,
			memo: input.memo,
			businessDate: input.businessDate,
			reversesEntryId: input.entryId,
			postedAt: new Date()
		})
		.returning({ id: journalEntries.id });

	await tx.insert(journalEntryLines).values(
		lines.map((line) => ({
			restaurantId: input.restaurantId,
			entryId: header.id,
			accountId: accountByCode.get(line.code)!,
			lineNo: line.lineNo,
			debitMinor: toBigInt(line.credit),
			creditMinor: toBigInt(line.debit)
		}))
	);

	return { entryId: header.id };
}

/** Read the lines of a posted entry, joined to accounts for code/name. */
export async function entryLines(
	tx: Executor,
	entryId: string
): Promise<
	{
		lineNo: number;
		code: string;
		name: string;
		debit: Minor;
		credit: Minor;
	}[]
> {
	const rows = await tx
		.select({
			lineNo: journalEntryLines.lineNo,
			code: accounts.code,
			name: accounts.name,
			debitMinor: journalEntryLines.debitMinor,
			creditMinor: journalEntryLines.creditMinor
		})
		.from(journalEntryLines)
		.innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
		.where(eq(journalEntryLines.entryId, entryId))
		.orderBy(asc(journalEntryLines.lineNo));
	return rows.map((r) => ({
		lineNo: r.lineNo,
		code: r.code,
		name: r.name,
		debit: minor(r.debitMinor),
		credit: minor(r.creditMinor)
	}));
}
