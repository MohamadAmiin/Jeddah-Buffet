// THE INVENTORY REPORTS (spec 26, 27; tasks/inventory-cogs T-26).
//
// Read-only, plain indexed SQL (spec 27 — no summary table, no materialized
// view). Every query names restaurant_id in its WHERE. Everything is grouped by
// BUSINESS DATE, never by created_at::date (invariant 11). Nothing recomputes a
// cost: a movement's cost_minor and the posted journal lines ARE the numbers;
// the only arithmetic is sum(). bigint sums come back from pg as text (the
// client installs no type parsers) and are read with BigInt(), never Number().
//
// THE TRIPWIRE. The ingredient caches are a copy of the ledger (invariant 6).
// currentStock compares each cache with its movements' totals, and
// reconciliation compares the summed stock value with account 1200. Any
// difference is shown, never repaired here (CLAUDE.md, "Inventory 13").
//
// The one display conversion is the overview's: the average per purchase unit
// is valueAt(qty(baseQtyPerUnit), avgMicro) — per one base unit when the
// ingredient has no purchase unit.
import { sql } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import { ROUNDING_RULE, minor, subtract, type Minor } from '../../money';
import { parseQty, qty, type Qty } from '../../money/quantity';
import { valueAt } from '../../money/costing';

function big(text: string | null | undefined): bigint {
	return BigInt(text ?? '0');
}

// ── Current stock and the tripwire ──────────────────────────────────────────

export type StockRow = {
	id: string;
	name: string;
	baseUnit: string;
	archived: boolean;
	onHandQty: Qty;
	avgMicro: bigint;
	valueMinor: Minor;
	negative: boolean;
	ledgerQty: Qty;
	ledgerValueMinor: Minor;
	drift: boolean;
	perUnit: { unitName: string; costMinor: Minor };
};

export async function currentStock(executor: Executor, restaurantId: string): Promise<StockRow[]> {
	const result = await executor.execute<{
		id: string;
		name: string;
		base_unit: string;
		archived: boolean;
		on_hand_qty: string;
		avg_micro: string;
		value_minor: string;
		ledger_qty: string;
		ledger_value: string;
		unit_name: string | null;
		base_qty_per_unit: string | null;
	}>(sql`
		with ledger as (
			select ingredient_id, sum(qty) as qty, sum(cost_minor) as cost
			from stock_movements
			where restaurant_id = ${restaurantId}
			group by ingredient_id
		)
		select i.id, i.name, i.base_unit, i.archived_at is not null as archived,
		       i.on_hand_qty::text as on_hand_qty,
		       i.avg_unit_cost_micro::text as avg_micro,
		       i.inventory_value_minor::text as value_minor,
		       coalesce(l.qty, 0)::numeric(12,3)::text as ledger_qty,
		       coalesce(l.cost, 0)::text as ledger_value,
		       u.name as unit_name,
		       u.base_qty_per_unit::text as base_qty_per_unit
		from ingredients i
		left join ledger l on l.ingredient_id = i.id
		left join lateral (
			select pu.name, pu.base_qty_per_unit
			from ingredient_purchase_units pu
			where pu.ingredient_id = i.id and pu.restaurant_id = i.restaurant_id
			  and pu.archived_at is null
			order by pu.created_at, pu.id
			limit 1
		) u on true
		where i.restaurant_id = ${restaurantId}
		  and (i.archived_at is null or i.on_hand_qty <> 0 or i.inventory_value_minor <> 0)
		order by lower(i.name), i.id
	`);
	return result.rows.map((r) => {
		const onHandQty = parseQty(r.on_hand_qty);
		const valueMinor = minor(big(r.value_minor));
		const ledgerQty = parseQty(r.ledger_qty);
		const ledgerValueMinor = minor(big(r.ledger_value));
		const avgMicro = big(r.avg_micro);
		const perUnitQty = r.base_qty_per_unit === null ? qty(1000n) : parseQty(r.base_qty_per_unit);
		return {
			id: r.id,
			name: r.name,
			baseUnit: r.base_unit,
			archived: r.archived,
			onHandQty,
			avgMicro,
			valueMinor,
			negative: onHandQty < 0n,
			ledgerQty,
			ledgerValueMinor,
			drift: onHandQty !== ledgerQty || valueMinor !== ledgerValueMinor,
			perUnit: {
				unitName: r.unit_name ?? r.base_unit,
				costMinor: valueAt(perUnitQty, avgMicro, ROUNDING_RULE)
			}
		};
	});
}

export type Reconciliation = {
	stockValueMinor: Minor;
	ledger1200Minor: Minor;
	differenceMinor: Minor;
	driftCount: number;
};

/** Σ stock value vs account 1200's balance, and how many ingredients drift. */
export async function reconciliation(
	executor: Executor,
	restaurantId: string
): Promise<Reconciliation> {
	const result = await executor.execute<{ stock: string; ledger: string }>(sql`
		select
			(select coalesce(sum(inventory_value_minor), 0) from ingredients
			 where restaurant_id = ${restaurantId})::text as stock,
			(select coalesce(sum(l.debit_minor - l.credit_minor), 0)
			 from journal_entry_lines l
			 join accounts a on a.id = l.account_id and a.restaurant_id = l.restaurant_id
			 where l.restaurant_id = ${restaurantId} and a.code = '1200')::text as ledger
	`);
	const stock = big(result.rows[0].stock);
	const ledger = big(result.rows[0].ledger);
	const drift = (await currentStock(executor, restaurantId)).filter((r) => r.drift).length;
	return {
		stockValueMinor: minor(stock),
		ledger1200Minor: minor(ledger),
		differenceMinor: subtract(minor(stock), minor(ledger)),
		driftCount: drift
	};
}

export async function negativeStock(executor: Executor, restaurantId: string) {
	const result = await executor.execute<{
		id: string;
		name: string;
		base_unit: string;
		on_hand_qty: string;
	}>(sql`
		select id, name, base_unit, on_hand_qty::text as on_hand_qty
		from ingredients
		where restaurant_id = ${restaurantId} and on_hand_qty < 0
		order by lower(name), id
	`);
	return result.rows.map((r) => ({
		id: r.id,
		name: r.name,
		baseUnit: r.base_unit,
		onHandQty: parseQty(r.on_hand_qty)
	}));
}

// ── The movement log ─────────────────────────────────────────────────────────

export type MovementLogRow = {
	movementType: string;
	qty: Qty;
	costMinor: Minor;
	sourceType: string;
	sourceId: string;
	businessDate: string;
	occurredAt: Date;
};

export async function movementLog(
	executor: Executor,
	restaurantId: string,
	ingredientId: string,
	options: { limit?: number } = {}
): Promise<MovementLogRow[]> {
	const limit = options.limit ?? 200;
	const result = await executor.execute<{
		movement_type: string;
		qty: string;
		cost_minor: string;
		source_type: string;
		source_id: string;
		business_date: string;
		occurred_at: string;
	}>(sql`
		select movement_type, qty::text as qty, cost_minor::text as cost_minor, source_type,
		       source_id, business_date::text as business_date, occurred_at
		from stock_movements
		where restaurant_id = ${restaurantId} and ingredient_id = ${ingredientId}
		order by occurred_at desc, id desc
		limit ${limit}
	`);
	return result.rows.map((r) => ({
		movementType: r.movement_type,
		qty: parseQty(r.qty),
		costMinor: minor(big(r.cost_minor)),
		sourceType: r.source_type,
		sourceId: r.source_id,
		businessDate: r.business_date,
		occurredAt: new Date(r.occurred_at)
	}));
}

// ── Consumption, waste, COGS by business date ───────────────────────────────

export type ConsumptionRow = {
	businessDate: string;
	ingredientId: string;
	name: string;
	baseUnit: string;
	qty: Qty;
	costMinor: Minor;
};

/** What the sales used, per business date and ingredient: Σ −qty and Σ −cost. */
export async function consumptionByDate(
	executor: Executor,
	restaurantId: string,
	from: string,
	to: string
): Promise<ConsumptionRow[]> {
	const result = await executor.execute<{
		business_date: string;
		ingredient_id: string;
		name: string;
		base_unit: string;
		qty: string;
		cost: string;
	}>(sql`
		select m.business_date::text as business_date, m.ingredient_id, i.name, i.base_unit,
		       (-sum(m.qty))::numeric(12,3)::text as qty, (-sum(m.cost_minor))::text as cost
		from stock_movements m
		join ingredients i on i.id = m.ingredient_id and i.restaurant_id = m.restaurant_id
		where m.restaurant_id = ${restaurantId} and m.movement_type = 'sale_consumption'
		  and m.business_date between ${from} and ${to}
		group by m.business_date, m.ingredient_id, i.name, i.base_unit
		order by m.business_date, lower(i.name)
	`);
	return result.rows.map((r) => ({
		businessDate: r.business_date,
		ingredientId: r.ingredient_id,
		name: r.name,
		baseUnit: r.base_unit,
		qty: parseQty(r.qty),
		costMinor: minor(big(r.cost))
	}));
}

export type WasteRow = {
	wasteId: string;
	businessDate: string;
	ingredientId: string;
	name: string;
	baseUnit: string;
	qty: Qty;
	reason: string;
	note: string | null;
	costMinor: Minor;
};

/** Each waste entry with the (positive) cost of its movement. */
export async function wasteByDate(
	executor: Executor,
	restaurantId: string,
	from: string,
	to: string
): Promise<WasteRow[]> {
	const result = await executor.execute<{
		id: string;
		business_date: string;
		ingredient_id: string;
		name: string;
		base_unit: string;
		qty: string;
		reason: string;
		note: string | null;
		cost: string;
	}>(sql`
		select w.id, w.business_date::text as business_date, w.ingredient_id, i.name, i.base_unit,
		       w.qty::text as qty, w.reason, w.note,
		       coalesce((select -sum(m.cost_minor) from stock_movements m
		                 where m.restaurant_id = w.restaurant_id and m.source_type = 'waste_entry'
		                   and m.source_id = w.id), 0)::text as cost
		from waste_entries w
		join ingredients i on i.id = w.ingredient_id and i.restaurant_id = w.restaurant_id
		where w.restaurant_id = ${restaurantId} and w.business_date between ${from} and ${to}
		order by w.business_date, w.created_at, w.id
	`);
	return result.rows.map((r) => ({
		wasteId: r.id,
		businessDate: r.business_date,
		ingredientId: r.ingredient_id,
		name: r.name,
		baseUnit: r.base_unit,
		qty: parseQty(r.qty),
		reason: r.reason,
		note: r.note,
		costMinor: minor(big(r.cost))
	}));
}

export type CogsRow = { businessDate: string; cogsMinor: Minor; revaluationMinor: Minor };

/** Σ (debit − credit) on 5000 per business date: sales' COGS and, apart, revaluations. */
export async function cogsByDate(
	executor: Executor,
	restaurantId: string,
	from: string,
	to: string
): Promise<CogsRow[]> {
	const result = await executor.execute<{ business_date: string; cogs: string; reval: string }>(sql`
		select e.business_date::text as business_date,
		       coalesce(sum(l.debit_minor - l.credit_minor)
		                filter (where e.event = 'cost_of_goods_sold'), 0)::text as cogs,
		       coalesce(sum(l.debit_minor - l.credit_minor)
		                filter (where e.event = 'inventory_revaluation'), 0)::text as reval
		from journal_entries e
		join journal_entry_lines l on l.entry_id = e.id and l.restaurant_id = e.restaurant_id
		join accounts a on a.id = l.account_id and a.restaurant_id = l.restaurant_id
		where e.restaurant_id = ${restaurantId} and a.code = '5000'
		  and e.event in ('cost_of_goods_sold', 'inventory_revaluation')
		  and e.business_date between ${from} and ${to}
		group by e.business_date
		order by e.business_date
	`);
	return result.rows.map((r) => ({
		businessDate: r.business_date,
		cogsMinor: minor(big(r.cogs)),
		revaluationMinor: minor(big(r.reval))
	}));
}

// ── Counts ───────────────────────────────────────────────────────────────────

export type CountSummary = {
	id: string;
	businessDate: string;
	countedAt: Date;
	note: string | null;
	lineCount: number;
	shortfallMinor: Minor;
	surplusMinor: Minor;
};

export async function listCounts(
	executor: Executor,
	restaurantId: string
): Promise<CountSummary[]> {
	const result = await executor.execute<{
		id: string;
		business_date: string;
		counted_at: string;
		note: string | null;
		line_count: number;
		shortfall: string;
		surplus: string;
	}>(sql`
		select c.id, c.business_date::text as business_date, c.counted_at, c.note,
		       count(l.id)::int as line_count,
		       coalesce(-sum(l.cost_minor) filter (where l.cost_minor < 0), 0)::text as shortfall,
		       coalesce(sum(l.cost_minor) filter (where l.cost_minor > 0), 0)::text as surplus
		from stock_counts c
		left join stock_count_lines l on l.count_id = c.id and l.restaurant_id = c.restaurant_id
		where c.restaurant_id = ${restaurantId}
		group by c.id
		order by c.counted_at desc, c.id desc
	`);
	return result.rows.map((r) => ({
		id: r.id,
		businessDate: r.business_date,
		countedAt: new Date(r.counted_at),
		note: r.note,
		lineCount: r.line_count,
		shortfallMinor: minor(big(r.shortfall)),
		surplusMinor: minor(big(r.surplus))
	}));
}

export type CountLineRow = {
	ingredientId: string;
	name: string;
	baseUnit: string;
	systemQty: Qty;
	countedQty: Qty;
	differenceQty: Qty;
	costMinor: Minor;
};

export async function countDifferences(
	executor: Executor,
	restaurantId: string,
	countId: string
): Promise<CountLineRow[]> {
	const result = await executor.execute<{
		ingredient_id: string;
		name: string;
		base_unit: string;
		system_qty: string;
		counted_qty: string;
		difference_qty: string;
		cost_minor: string;
	}>(sql`
		select l.ingredient_id, i.name, i.base_unit, l.system_qty::text as system_qty,
		       l.counted_qty::text as counted_qty, l.difference_qty::text as difference_qty,
		       l.cost_minor::text as cost_minor
		from stock_count_lines l
		join ingredients i on i.id = l.ingredient_id and i.restaurant_id = l.restaurant_id
		where l.restaurant_id = ${restaurantId} and l.count_id = ${countId}
		order by lower(i.name), l.ingredient_id
	`);
	return result.rows.map((r) => ({
		ingredientId: r.ingredient_id,
		name: r.name,
		baseUnit: r.base_unit,
		systemQty: parseQty(r.system_qty),
		countedQty: parseQty(r.counted_qty),
		differenceQty: parseQty(r.difference_qty),
		costMinor: minor(big(r.cost_minor))
	}));
}
