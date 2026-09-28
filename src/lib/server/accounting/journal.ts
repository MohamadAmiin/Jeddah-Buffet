// The journal writer. Takes the caller's DbTx and NEVER opens one of its own
// (invariant 4: one all-or-nothing transaction at payment; spec 13). Drops
// every line whose amount is 0n before inserting, and returns null without
// inserting when nothing remains (a free order legitimately posts nothing;
// T-09's deferred triggers also fire on journal_entries so an empty header
// could never commit). No update and no delete path (invariant 2): a mistake
// is corrected with a REVERSING entry posted through this same function.

import { asc, eq } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { journalEntries, journalEntryLines, accounts } from '../db/schema/accounting';
import { accountIdByCode } from './chart';
import type { PostingEvent, RuleLine } from './posting-rules';
import { minor, type Minor } from '../../money';

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
