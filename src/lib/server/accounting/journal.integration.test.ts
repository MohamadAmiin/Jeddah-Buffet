import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { computeOrderTotals } from '../../money/order-totals';
import { minor, ROUNDING_RULE } from '../../money';
import {
	POSTING_EVENTS,
	saleLines,
	cogsLines,
	overShortLines,
	overShortEvent,
	SALE_EVENTS,
	purchaseEvent,
	purchaseLines,
	supplierPaymentLines,
	wasteLines,
	countShortfallLines,
	countSurplusLines,
	revaluationLines,
	openingStockLines,
	type PostingEvent,
	type RuleLine
} from './posting-rules';
import type { JournalSourceType } from './journal';
import { postEntry, postReversal, entryLines } from './journal';
import { db } from '../db/client';
import { onRestaurantCreated } from '../restaurants';
import { restaurants } from '../db/schema/restaurants';
import { journalEntries, journalEntryLines } from '../db/schema/accounting';
import { testDb, closeTestDb } from '../db/test/db';

function generator(seed: bigint) {
	let state = seed;
	return () => {
		state = (state * 1664525n + 1013904223n) & 0xffffffffn;
		return state;
	};
}
function between(next: () => bigint, lo: bigint, hi: bigint): bigint {
	const span = hi - lo + 1n;
	return lo + (next() % span);
}

afterAll(async () => {
	await closeTestDb();
});

let restaurantId: string;

async function makeRestaurant(name = 'Journal Cafe'): Promise<string> {
	const [row] = await testDb()
		.insert(restaurants)
		.values({ name })
		.returning({ id: restaurants.id });
	await db.transaction(async (tx) =>
		onRestaurantCreated(tx, row.id, {
			restaurantName: name,
			timeZone: 'Africa/Mogadishu'
		})
	);
	return row.id;
}

beforeEach(async () => {
	restaurantId = await makeRestaurant();
});

function underlyingMessage(err: unknown): string {
	const seen = new Set<unknown>();
	let cur: unknown = err;
	const messages: string[] = [];
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		if (cur instanceof Error) messages.push(cur.message);
		cur = (cur as { cause?: unknown }).cause;
	}
	return messages.join(' | ');
}

// One rule builder per POSTING_EVENTS member: pos-sales' six unchanged, plus
// tasks/inventory-cogs' eight (T-13). Record<PostingEvent, ...> makes a missing
// event a type error, so the property test always covers every event.
type Built = { lines: RuleLine[]; sourceType: JournalSourceType };
function saleBuilder(kind: (typeof SALE_EVENTS)[number]) {
	return (next: () => bigint, i: number): Built => {
		const nLines = Number(between(next, 1n, 6n));
		const cartLines = [];
		for (let j = 0; j < nLines; j++) {
			const unitPriceMinor = minor(between(next, 0n, 100_000n));
			const quantity = between(next, 1n, 9n);
			const nDeltas = Number(between(next, 0n, 3n));
			const deltas = [];
			let deltaSum = 0n;
			for (let k = 0; k < nDeltas; k++) {
				const d = between(next, 0n, 2000n);
				deltas.push(minor(d));
				deltaSum += d;
			}
			const taxRateBp = Number(between(next, 0n, 10_000n));
			const base = (unitPriceMinor + deltaSum) * quantity;
			const discountMinor = minor(base > 0n ? between(next, 0n, base) : 0n);
			cartLines.push({
				unitPriceMinor,
				quantity,
				modifierDeltasMinor: deltas,
				taxRateBp,
				discountMinor
			});
		}
		const totals = computeOrderTotals(
			{ taxMode: i % 2 === 0 ? 'exclusive' : 'inclusive', lines: cartLines },
			ROUNDING_RULE
		);
		return { lines: saleLines(kind, totals), sourceType: 'order' };
	};
}
const amount = (next: () => bigint) => minor(between(next, 0n, 100_000n));
const BUILDERS: Record<PostingEvent, (next: () => bigint, i: number) => Built> = {
	cash_sale: saleBuilder('cash_sale'),
	card_sale: saleBuilder('card_sale'),
	mobile_sale: saleBuilder('mobile_sale'),
	cost_of_goods_sold: (next) => ({ lines: cogsLines(amount(next)), sourceType: 'pos_session' }),
	cash_shortage_at_close: (next) => {
		const d = minor(between(next, -100_000n, -1n));
		expect(overShortEvent(d)).toBe('cash_shortage_at_close');
		return { lines: overShortLines(d), sourceType: 'pos_session' };
	},
	cash_overage_at_close: (next) => {
		const d = minor(between(next, 1n, 100_000n));
		expect(overShortEvent(d)).toBe('cash_overage_at_close');
		return { lines: overShortLines(d), sourceType: 'pos_session' };
	},
	purchase_paid: (next, i) => {
		const paidBy = i % 2 === 0 ? 'cash' : 'bank';
		expect(purchaseEvent(paidBy)).toBe('purchase_paid');
		return { lines: purchaseLines(paidBy, amount(next)), sourceType: 'purchase' };
	},
	purchase_on_credit: (next) => {
		expect(purchaseEvent('credit')).toBe('purchase_on_credit');
		return { lines: purchaseLines('credit', amount(next)), sourceType: 'purchase' };
	},
	supplier_paid: (next, i) => ({
		lines: supplierPaymentLines(i % 2 === 0 ? 'cash' : 'bank', amount(next)),
		sourceType: 'supplier_payment'
	}),
	waste: (next) => ({ lines: wasteLines(amount(next)), sourceType: 'waste_entry' }),
	stock_count_shortfall: (next) => ({
		lines: countShortfallLines(amount(next)),
		sourceType: 'stock_count'
	}),
	stock_count_surplus: (next) => ({
		lines: countSurplusLines(amount(next)),
		sourceType: 'stock_count'
	}),
	inventory_revaluation: (next) => ({
		lines: revaluationLines(minor(between(next, -100_000n, 100_000n))),
		sourceType: 'purchase'
	}),
	opening_stock: (next) => ({
		lines: openingStockLines(amount(next)),
		sourceType: 'opening_stock'
	})
};

describe('MANDATORY (spec 29) — 300 generated events all balance at COMMIT', () => {
	it('every one of the POSTING_EVENTS commits and Sigma-debit = Sigma-credit per entry', async () => {
		const next = generator(20260929n);
		const kept: string[] = [];
		const posted = new Set<PostingEvent>();
		let reversed = 0;
		await db.transaction(async (tx) => {
			for (let i = 0; i < 300; i++) {
				const kind = POSTING_EVENTS[i % POSTING_EVENTS.length];
				const { lines, sourceType } = BUILDERS[kind](next, i);
				const result = await postEntry(tx, {
					restaurantId,
					businessDate: '2026-09-27',
					event: kind,
					sourceType,
					sourceId: randomUUID(),
					memo: `case ${i}`,
					lines
				});
				if (result) {
					kept.push(result.entryId);
					posted.add(kind);
				}
			}
			// tasks/inventory-cogs T-14: reverse a seeded half of them in the same
			// transaction; every mirror must balance at COMMIT too.
			for (const entryId of [...kept]) {
				if ((next() >> 16n) % 2n === 0n) continue;
				const reversal = await postReversal(tx, {
					restaurantId,
					entryId,
					businessDate: '2026-09-28',
					memo: `reverse ${entryId}`
				});
				kept.push(reversal.entryId);
				reversed++;
			}
		});
		expect(posted.size).toBe(POSTING_EVENTS.length);
		expect(reversed).toBeGreaterThan(50);

		const summary = await testDb().execute(sql`
			select entry_id::text as entry_id,
			       sum(debit_minor)::text as dr,
			       sum(credit_minor)::text as cr,
			       count(*) filter (where debit_minor > 0)::int as debits,
			       count(*) filter (where credit_minor > 0)::int as credits
			from journal_entry_lines
			group by entry_id
		`);
		expect(summary.rows.length).toBe(kept.length);
		for (const row of summary.rows as {
			entry_id: string;
			dr: string;
			cr: string;
			debits: number;
			credits: number;
		}[]) {
			expect(row.dr).toBe(row.cr);
			expect(row.debits).toBeGreaterThanOrEqual(1);
			expect(row.credits).toBeGreaterThanOrEqual(1);
		}
		const violations = await testDb().execute(sql`
			select count(*)::text as c from journal_entry_lines where (debit_minor > 0) = (credit_minor > 0)
		`);
		expect((violations.rows[0] as { c: string }).c).toBe('0');
	});
});

describe('MANDATORY (spec 29) — the database rejects an unbalanced entry AT COMMIT', () => {
	it('a single Dr line is stored inside the tx and rejected at commit; both tables end at 0', async () => {
		await expect(
			db.transaction(async (tx) => {
				await postEntry(tx, {
					restaurantId,
					businessDate: '2026-09-27',
					event: 'cash_sale',
					sourceType: 'order',
					sourceId: randomUUID(),
					memo: 'lone-debit',
					lines: [{ code: '1000', debit: minor(500n) }]
				});
			})
		).rejects.toThrow();

		const eCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntries);
		expect(eCount[0].c).toBe('0');
		const lCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntryLines);
		expect(lCount[0].c).toBe('0');
	});
});

describe('shape errors and business date validation', () => {
	it('a line with both sides, neither side, or a negative amount rejects and writes nothing', async () => {
		for (const bad of [
			[{ code: '1000', debit: minor(1n), credit: minor(1n) }],
			[{ code: '1000' }],
			[{ code: '1000', debit: minor(-1n) }]
		]) {
			await expect(
				db.transaction(async (tx) => {
					await postEntry(tx, {
						restaurantId,
						businessDate: '2026-09-27',
						event: 'cash_sale',
						sourceType: 'order',
						sourceId: randomUUID(),
						memo: 'shape',
						lines: bad
					});
				})
			).rejects.toThrow();
		}
		const eCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntries);
		expect(eCount[0].c).toBe('0');
	});

	it('businessDate must be YYYY-MM-DD; a slash or an ISO timestamp throws TypeError before any SQL', async () => {
		for (const bad of ['2026/09/27', new Date().toISOString()]) {
			await expect(
				db.transaction(async (tx) => {
					await postEntry(tx, {
						restaurantId,
						businessDate: bad,
						event: 'cash_sale',
						sourceType: 'order',
						sourceId: randomUUID(),
						memo: 'bad-date',
						lines: [
							{ code: '1000', debit: minor(1n) },
							{ code: '4000', credit: minor(1n) }
						]
					});
				})
			).rejects.toThrow(/YYYY-MM-DD/);
		}
	});

	it('unknown code rejects before any insert; no header was written', async () => {
		await expect(
			db.transaction(async (tx) => {
				await postEntry(tx, {
					restaurantId,
					businessDate: '2026-09-27',
					event: 'cash_sale',
					sourceType: 'order',
					sourceId: randomUUID(),
					memo: 'unknown',
					lines: [
						{ code: '9999', debit: minor(100n) },
						{ code: '4000', credit: minor(100n) }
					]
				});
			})
		).rejects.toThrow(/9999/);
		const eCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntries);
		expect(eCount[0].c).toBe('0');
	});
});

describe('shape behaviours', () => {
	it('a sale with tax 0 posts exactly two lines and line_no is contiguous', async () => {
		let entryId = '';
		await db.transaction(async (tx) => {
			const result = await postEntry(tx, {
				restaurantId,
				businessDate: '2026-09-27',
				event: 'cash_sale',
				sourceType: 'order',
				sourceId: randomUUID(),
				memo: 'zero-tax',
				lines: saleLines('cash_sale', {
					subtotal: minor(1000n),
					discount: minor(0n),
					tax: minor(0n),
					total: minor(1000n)
				})
			});
			entryId = result!.entryId;
		});
		const lines = await entryLines(testDb(), entryId);
		expect(lines).toEqual([
			{ lineNo: 1, code: '1000', name: 'Cash on Hand', debit: 1000n, credit: 0n },
			{ lineNo: 2, code: '4000', name: 'Sales Revenue', debit: 0n, credit: 1000n }
		]);
	});

	it('a free order returns null and writes nothing', async () => {
		let result: { entryId: string } | null = null;
		await db.transaction(async (tx) => {
			result = await postEntry(tx, {
				restaurantId,
				businessDate: '2026-09-27',
				event: 'cash_sale',
				sourceType: 'order',
				sourceId: randomUUID(),
				memo: 'free',
				lines: saleLines('cash_sale', {
					subtotal: minor(0n),
					discount: minor(0n),
					tax: minor(0n),
					total: minor(0n)
				})
			});
		});
		expect(result).toBeNull();
		const eCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntries);
		expect(eCount[0].c).toBe('0');
	});

	it('business_date lands as the string given; posted_at is close to now', async () => {
		const before = Date.now();
		let entryId = '';
		await db.transaction(async (tx) => {
			const result = await postEntry(tx, {
				restaurantId,
				businessDate: '2026-09-27',
				event: 'cash_sale',
				sourceType: 'order',
				sourceId: randomUUID(),
				memo: 'bd',
				lines: saleLines('cash_sale', {
					subtotal: minor(100n),
					discount: minor(0n),
					tax: minor(0n),
					total: minor(100n)
				})
			});
			entryId = result!.entryId;
		});
		const [row] = await testDb()
			.select({ bd: journalEntries.businessDate, at: journalEntries.postedAt })
			.from(journalEntries)
			.where(eq(journalEntries.id, entryId));
		expect(row.bd).toBe('2026-09-27');
		expect(Math.abs(row.at.getTime() - before)).toBeLessThan(60_000);
	});

	it('rolls back within the caller transaction when a later step throws', async () => {
		await expect(
			db.transaction(async (tx) => {
				await postEntry(tx, {
					restaurantId,
					businessDate: '2026-09-27',
					event: 'cash_sale',
					sourceType: 'order',
					sourceId: randomUUID(),
					memo: 'rollback',
					lines: saleLines('cash_sale', {
						subtotal: minor(100n),
						discount: minor(0n),
						tax: minor(0n),
						total: minor(100n)
					})
				});
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		const eCount = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntries);
		expect(eCount[0].c).toBe('0');
	});

	it('entryLines on an unknown id returns []', async () => {
		expect(await entryLines(testDb(), '00000000-0000-0000-0000-000000000000')).toEqual([]);
	});
});

describe('trigger-message tripwire', () => {
	it('an unbalanced entry rejects with the balance trigger message T-09 raises', async () => {
		try {
			await db.transaction(async (tx) => {
				await postEntry(tx, {
					restaurantId,
					businessDate: '2026-09-27',
					event: 'cash_sale',
					sourceType: 'order',
					sourceId: randomUUID(),
					memo: 'tripwire',
					lines: [{ code: '1000', debit: minor(100n) }]
				});
			});
			throw new Error('expected the transaction to reject');
		} catch (err) {
			expect(underlyingMessage(err)).toMatch(/is not balanced|has no lines/);
		}
	});
});

describe('postReversal (tasks/inventory-cogs T-14)', () => {
	/** Drizzle wraps the pg error; find the one carrying a SQLSTATE. */
	function pgError(err: unknown): { code?: string; constraint?: string } {
		let cur: unknown = err;
		const seen = new Set<unknown>();
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			if ((cur as { code?: unknown }).code) return cur as { code: string; constraint?: string };
			cur = (cur as { cause?: unknown }).cause;
		}
		return {};
	}

	async function counts(): Promise<{ entries: string; lines: string }> {
		const [e] = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntries);
		const [l] = await testDb()
			.select({ c: sql<string>`count(*)::text` })
			.from(journalEntryLines);
		return { entries: e.c, lines: l.c };
	}

	async function postCreditPurchase(): Promise<string> {
		let entryId = '';
		await db.transaction(async (tx) => {
			const result = await postEntry(tx, {
				restaurantId,
				businessDate: '2026-09-27',
				event: 'purchase_on_credit',
				sourceType: 'purchase',
				sourceId: randomUUID(),
				memo: 'delivery',
				lines: purchaseLines('credit', minor(11000n))
			});
			entryId = result!.entryId;
		});
		return entryId;
	}

	it('mirrors a purchase on credit: Dr 2000 / Cr 1200 on the given date; the original is unchanged', async () => {
		const originalId = await postCreditPurchase();
		const [before] = await testDb()
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.id, originalId));
		const beforeLines = await entryLines(testDb(), originalId);

		let reversalId = '';
		await db.transaction(async (tx) => {
			reversalId = (
				await postReversal(tx, {
					restaurantId,
					entryId: originalId,
					businessDate: '2026-09-28',
					memo: 'wrong delivery'
				})
			).entryId;
		});

		expect(await entryLines(testDb(), reversalId)).toEqual([
			{ lineNo: 1, code: '1200', name: 'Inventory', debit: 0n, credit: 11000n },
			{ lineNo: 2, code: '2000', name: 'Accounts Payable', debit: 11000n, credit: 0n }
		]);
		const [reversal] = await testDb()
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.id, reversalId));
		expect(reversal.event).toBe('purchase_on_credit');
		expect(reversal.sourceType).toBe(before.sourceType);
		expect(reversal.sourceId).toBe(before.sourceId);
		expect(reversal.reversesEntryId).toBe(originalId);
		expect(reversal.businessDate).toBe('2026-09-28');
		expect(reversal.memo).toBe('wrong delivery');

		const [after] = await testDb()
			.select()
			.from(journalEntries)
			.where(eq(journalEntries.id, originalId));
		expect(after).toEqual(before);
		expect(await entryLines(testDb(), originalId)).toEqual(beforeLines);
	});

	it('a second reversal of the same entry fails with 23505 and writes nothing', async () => {
		const originalId = await postCreditPurchase();
		await db.transaction(async (tx) => {
			await postReversal(tx, {
				restaurantId,
				entryId: originalId,
				businessDate: '2026-09-28',
				memo: 'first'
			});
		});
		const before = await counts();
		let caught: unknown;
		try {
			await db.transaction(async (tx) => {
				await postReversal(tx, {
					restaurantId,
					entryId: originalId,
					businessDate: '2026-09-28',
					memo: 'second'
				});
			});
		} catch (err) {
			caught = err;
		}
		expect(pgError(caught)).toMatchObject({
			code: '23505',
			constraint: 'journal_entries_reverses_entry_unique'
		});
		expect(await counts()).toEqual(before);
	});

	it('a reversal cannot be reversed', async () => {
		const originalId = await postCreditPurchase();
		let reversalId = '';
		await db.transaction(async (tx) => {
			reversalId = (
				await postReversal(tx, {
					restaurantId,
					entryId: originalId,
					businessDate: '2026-09-28',
					memo: 'first'
				})
			).entryId;
		});
		await expect(
			db.transaction(async (tx) => {
				await postReversal(tx, {
					restaurantId,
					entryId: reversalId,
					businessDate: '2026-09-28',
					memo: 'undo the undo'
				});
			})
		).rejects.toThrow('a reversal cannot be reversed');
	});

	it("another restaurant's entry is not found and nothing is written", async () => {
		const originalId = await postCreditPurchase();
		const otherRestaurant = await makeRestaurant('Other Cafe');
		const before = await counts();
		await expect(
			db.transaction(async (tx) => {
				await postReversal(tx, {
					restaurantId: otherRestaurant,
					entryId: originalId,
					businessDate: '2026-09-28',
					memo: 'cross-tenant'
				});
			})
		).rejects.toThrow('journal entry not found');
		expect(await counts()).toEqual(before);
	});

	it('a bad business date throws TypeError before any query', async () => {
		const originalId = await postCreditPurchase();
		let caught: unknown;
		try {
			await db.transaction(async (tx) => {
				await postReversal(tx, {
					restaurantId,
					entryId: originalId,
					businessDate: '2026-9-28',
					memo: 'bad date'
				});
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TypeError);
		expect((caught as Error).message).toMatch(/YYYY-MM-DD/);
	});
});
