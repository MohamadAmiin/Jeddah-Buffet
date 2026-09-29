// STOCK COUNTS (spec 15, 24; tasks/inventory-cogs T-25).
//
// The owner counts the shelf; the difference from the SYSTEM quantity is posted
// as a count adjustment: a shortfall leaves at the average, Dr 5100 / Cr 1200; a
// surplus comes back at the average, Dr 1200 / Cr 5100. A count may cover only
// some ingredients; the rest are untouched.
//
// THE SYSTEM QUANTITY is the ledger total at posting time, read from the locked
// ingredient rows — the same ordered FOR UPDATE every writer takes, so no sale
// can move the quantity between the read and the adjustment. It is never
// computed from movements filtered by time.
//
// NO COUNT WHILE A SALE IS IN FLIGHT (CLAUDE.md, "Inventory 4"). A sale made
// before the count but synced after it would be deducted twice — once by the
// count's correction, once by its own consumption. So posting is refused while
// any POS session of the restaurant is open, or any sale.complete op is
// unrecorded and unresolved; the page says why it is waiting.
//
// A SURPLUS NEEDS A COST. An ingredient never delivered and never given opening
// stock has no average to value a surplus at, so such a count is refused and
// names the ingredients (CLAUDE.md, "Inventory 1": enter opening stock first).
// The count lines are append-only (migration 0014).
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import type { Executor } from '../auth/session';
import { stockCountLines, stockCounts } from '../db/schema/inventory';
import { posSessions } from '../db/schema/pos-sessions';
import { posSyncOps } from '../db/schema/pos-sync';
import { writeAudit } from '../audit';
import { postEntry } from '../accounting/journal';
import { countShortfallLines, countSurplusLines } from '../accounting/posting-rules';
import { minor, negate, sum, type Minor } from '../../money';
import { formatQty, qty, subQty, type Qty } from '../../money/quantity';
import { applyMovements, lockIngredients, type MovementRequest } from './movements';
import type { InventoryWriteContext } from './ingredients';

export const MAX_COUNT_LINES = 500;

export type CountBlockers = { openSessions: number; unresolvedSales: number };

export async function countBlockers(
	executor: Executor,
	restaurantId: string
): Promise<CountBlockers> {
	const [sessions] = await executor
		.select({ c: sql<number>`count(*)::int` })
		.from(posSessions)
		.where(and(eq(posSessions.restaurantId, restaurantId), eq(posSessions.status, 'open')));
	const [sales] = await executor
		.select({ c: sql<number>`count(*)::int` })
		.from(posSyncOps)
		.where(
			and(
				eq(posSyncOps.restaurantId, restaurantId),
				eq(posSyncOps.kind, 'sale.complete'),
				eq(posSyncOps.status, 'unrecorded'),
				isNull(posSyncOps.resolvedAt)
			)
		);
	return { openSessions: sessions.c, unresolvedSales: sales.c };
}

export type PostCountInput = {
	businessDate: string;
	note?: string | null;
	lines: readonly { ingredientId: string; countedQty: Qty }[];
};

export type PostCountResult =
	| { ok: true; countId: string; shortfallMinor: Minor; surplusMinor: Minor }
	| ({ ok: false; reason: 'blocked' } & CountBlockers)
	| {
			ok: false;
			reason: 'no_lines' | 'too_many_lines' | 'duplicate_ingredient' | 'invalid_qty';
	  }
	| { ok: false; reason: 'no_inbound_history'; ingredientIds: string[] };

export async function postCount(
	tx: DbTx,
	ctx: InventoryWriteContext,
	input: PostCountInput
): Promise<PostCountResult> {
	if (input.lines.length === 0) return { ok: false, reason: 'no_lines' };
	if (input.lines.length > MAX_COUNT_LINES) return { ok: false, reason: 'too_many_lines' };
	const ids = input.lines.map((l) => l.ingredientId);
	if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate_ingredient' };
	if (input.lines.some((l) => typeof l.countedQty !== 'bigint' || l.countedQty < 0n)) {
		return { ok: false, reason: 'invalid_qty' };
	}

	// Re-checked inside the transaction: the page's earlier check is advice.
	const blockers = await countBlockers(tx, ctx.restaurantId);
	if (blockers.openSessions > 0 || blockers.unresolvedSales > 0) {
		return { ok: false, reason: 'blocked', ...blockers };
	}

	// The system quantities, under the one ordered lock every writer takes.
	const locked = await lockIngredients(tx, ctx.restaurantId, ids);
	const lines = input.lines.map((line) => {
		const system = locked.get(line.ingredientId)!.state.qty;
		return { ...line, system, difference: subQty(line.countedQty, system) };
	});
	const unvaluable = lines
		.filter((l) => l.difference > 0n && !locked.get(l.ingredientId)!.hasInboundHistory)
		.map((l) => l.ingredientId);
	if (unvaluable.length > 0) {
		return { ok: false, reason: 'no_inbound_history', ingredientIds: unvaluable };
	}

	const countId = randomUUID();
	await tx.insert(stockCounts).values({
		id: countId,
		restaurantId: ctx.restaurantId,
		businessDate: input.businessDate,
		countedAt: new Date(),
		note: input.note?.trim() || null,
		recordedByUserId: ctx.actorUserId
	});

	const changed = lines.filter((l) => l.difference !== 0n);
	const requests: MovementRequest[] = changed.map((l) =>
		l.difference < 0n
			? {
					kind: 'out',
					type: 'count_adjustment',
					ingredientId: l.ingredientId,
					qty: qty(-l.difference)
				}
			: { kind: 'in', type: 'count_adjustment', ingredientId: l.ingredientId, qty: l.difference }
	);
	const { movements } = await applyMovements(
		tx,
		{
			restaurantId: ctx.restaurantId,
			sourceType: 'stock_count',
			sourceId: countId,
			businessDate: input.businessDate,
			occurredAt: new Date(),
			recordedByUserId: ctx.actorUserId
		},
		requests
	);
	// A count adjustment never produces a revaluation row, so the movements line
	// up one-to-one with the changed lines.
	const costByIngredient = new Map<string, bigint>(
		movements.map((m) => [m.ingredientId, m.costMinor])
	);

	await tx.insert(stockCountLines).values(
		lines.map((l) => ({
			restaurantId: ctx.restaurantId,
			countId,
			ingredientId: l.ingredientId,
			systemQty: formatQty(l.system),
			countedQty: formatQty(l.countedQty),
			differenceQty: formatQty(l.difference),
			costMinor: costByIngredient.get(l.ingredientId) ?? 0n
		}))
	);

	// Summed by the money module (invariant 1): a shortfall is the magnitude of
	// the negative costs, a surplus the sum of the positive ones.
	const signedCosts = [...costByIngredient.values()].map((cost) => minor(cost));
	const shortfallMinor = sum(signedCosts.filter((cost) => cost < 0n).map((cost) => negate(cost)));
	const surplusMinor = sum(signedCosts.filter((cost) => cost > 0n));
	// Each is null (nothing written) when zero.
	await postEntry(tx, {
		restaurantId: ctx.restaurantId,
		businessDate: input.businessDate,
		event: 'stock_count_shortfall',
		sourceType: 'stock_count',
		sourceId: countId,
		memo: 'Stock count shortfall',
		lines: countShortfallLines(shortfallMinor)
	});
	await postEntry(tx, {
		restaurantId: ctx.restaurantId,
		businessDate: input.businessDate,
		event: 'stock_count_surplus',
		sourceType: 'stock_count',
		sourceId: countId,
		memo: 'Stock count surplus',
		lines: countSurplusLines(surplusMinor)
	});

	await writeAudit(tx, {
		restaurantId: ctx.restaurantId,
		actorUserId: ctx.actorUserId,
		subjectUserId: null,
		ip: ctx.ip,
		userAgent: ctx.userAgent,
		event: 'stock.counted',
		details: {
			countId,
			lineCount: lines.length,
			shortfallMinor: shortfallMinor.toString(),
			surplusMinor: surplusMinor.toString()
		}
	});
	return { ok: true, countId, shortfallMinor, surplusMinor };
}
