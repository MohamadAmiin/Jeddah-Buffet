// THE REPORT DOWNLOADS (tasks/sales-report-export T-07). Each section's
// columns are defined HERE and nowhere else (Contract C of the plan), every
// cell is typed so csv.ts applies the formula guard, and every figure is a
// stored one — this file sums nothing and rounds nothing.
//
// The reads run in ONE read-only transaction with a statement timeout, so a
// year-wide export cannot hold a pool connection for minutes while the till's
// sync waits for one; orders and lines are counted first and refused above
// EXPORT_ROW_CAP.

import { sql } from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import type { Minor } from '../../money';
import { formatAmountPlain, moneyFormatFor, type MoneyFormat } from '../../money/format';
import { formatTaxRate } from '../../money/tax';
import { count, money, text, toCsv, type CsvCell } from './csv';
import { salesReportRange, type TaxModeLiteral } from './sales';
import {
	byBusinessDate,
	countLines,
	countOrders,
	lineRows,
	orderRows,
	salesByTaxRate,
	sumDays,
	type PaymentKind
} from './detail';

export const EXPORT_SECTIONS = [
	'summary',
	'days',
	'payment-methods',
	'employees',
	'items',
	'categories',
	'tax-rates',
	'shifts',
	'orders',
	'lines'
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

export const EXPORT_ROW_CAP = 100_000;

export class ExportTooLarge extends Error {
	constructor(readonly rows: number) {
		super(`the export would hold ${rows} rows, above the cap of ${EXPORT_ROW_CAP}`);
	}
}

export class CurrencyNotSet extends Error {
	constructor() {
		super('the restaurant has no currency');
	}
}

const ORDER_TYPE_LABEL: Record<string, string> = {
	dine_in: 'Dine-in',
	takeaway: 'Takeaway',
	delivery: 'Delivery'
};
const KIND_LABEL: Record<PaymentKind, string> = {
	cash: 'Cash',
	card: 'Card',
	mobile: 'Mobile money'
};
const MODE_LABEL: Record<TaxModeLiteral, string> = {
	exclusive: 'Exclusive',
	inclusive: 'Inclusive'
};
const BASIS_LABEL: Record<TaxModeLiteral, string> = { exclusive: 'Net', inclusive: 'Incl. tax' };

type Ctx = {
	tx: DbTx;
	restaurantId: string;
	from: string;
	to: string;
	format: MoneyFormat;
	timeZone: string;
	restaurantName: string;
	generatedAt: string;
	rowCap: number;
};

type Sheet = { header: string[]; rows: CsvCell[][] };

const rate = (bp: number) => formatTaxRate(bp).replace('%', '');

function localClock(timeZone: string): (d: Date | null) => string | null {
	// sv-SE writes 'YYYY-MM-DD HH:MM:SS', the format of every other time in these files.
	const f = new Intl.DateTimeFormat('sv-SE', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	});
	return (d) => (d === null ? null : f.format(d));
}

async function summary(c: Ctx): Promise<Sheet> {
	const report = await salesReportRange(c.tx, c.restaurantId, c.from, c.to);
	const profit = sumDays(await byBusinessDate(c.tx, c.restaurantId, c.from, c.to));
	const code = c.format.code;
	const t = (metric: string, value: string): CsvCell[] => [text(metric), text(value), text(null)];
	const m = (metric: string, value: Minor): CsvCell[] => [text(metric), money(value), text(code)];
	const n = (metric: string, value: number): CsvCell[] => [
		text(metric),
		count(value),
		text('count')
	];
	const tender = (kind: PaymentKind) => report.byTender.find((r) => r.method === kind)!.amount;
	const type = (orderType: string) =>
		report.byOrderType.find((r) => r.orderType === orderType)!.amount;
	return {
		header: ['Metric', 'Value', 'Unit'],
		rows: [
			t('Restaurant', c.restaurantName),
			t('From', c.from),
			t('To', c.to),
			t('Time zone', c.timeZone),
			t('Generated at', c.generatedAt),
			n('Orders', report.totals.orderCount),
			m('Gross sales', report.totals.grossSales),
			m('Discounts', report.totals.discounts),
			m('Net sales', report.totals.netSales),
			m('Tax', report.totals.tax),
			m('Takings', report.totals.takings),
			m('Cash payments', tender('cash')),
			m('Card payments', tender('card')),
			m('Mobile payments', tender('mobile')),
			m('Dine-in sales', type('dine_in')),
			m('Takeaway sales', type('takeaway')),
			m('Delivery sales', type('delivery')),
			m('Cost of goods sold (5000)', profit.cogs),
			m('Waste & inventory adjustments (5100)', profit.waste),
			m('Comps & staff meals (5200)', profit.comps),
			m('Cost of sales', profit.costOfSales),
			m('Gross profit', profit.grossProfit),
			n('Shifts still open', profit.openShifts),
			n('Sales awaiting review', report.flagged.count)
		]
	};
}

async function days(c: Ctx): Promise<Sheet> {
	const code = c.format.code;
	const rows = await byBusinessDate(c.tx, c.restaurantId, c.from, c.to);
	return {
		header: [
			'Business date',
			'Orders',
			`Gross sales (${code})`,
			`Discounts (${code})`,
			`Net sales (${code})`,
			`Tax (${code})`,
			`Takings (${code})`,
			`Cost of goods sold (${code})`,
			`Waste & adjustments (${code})`,
			`Comps & staff meals (${code})`,
			`Cost of sales (${code})`,
			`Gross profit (${code})`,
			'Open shifts'
		],
		rows: rows.map((r) => [
			text(r.businessDate),
			count(r.orderCount),
			money(r.grossSales),
			money(r.discounts),
			money(r.netSales),
			money(r.tax),
			money(r.takings),
			money(r.cogs),
			money(r.waste),
			money(r.comps),
			money(r.costOfSales),
			money(r.grossProfit),
			count(r.openShifts)
		])
	};
}

async function grouped(c: Ctx, section: ExportSection): Promise<Sheet> {
	const code = c.format.code;
	const report = await salesReportRange(c.tx, c.restaurantId, c.from, c.to);
	switch (section) {
		case 'payment-methods':
			return {
				header: ['Method', 'Type', 'Archived', 'Payments', `Amount (${code})`],
				rows: report.byPaymentMethod.map((r) => [
					text(r.name),
					text(KIND_LABEL[r.kind]),
					text(r.archived ? 'Yes' : 'No'),
					count(r.count),
					money(r.amount)
				])
			};
		case 'employees':
			return {
				header: ['Employee', 'Orders', `Amount (${code})`],
				rows: report.byEmployee.map((r) => [text(r.displayName), count(r.count), money(r.amount)])
			};
		case 'items':
			return {
				header: ['Item', 'Basis', 'Quantity', `Amount (${code})`],
				rows: report.byItem.map((r) => [
					text(r.itemName),
					text(BASIS_LABEL[r.taxMode]),
					count(r.quantity),
					money(r.amount)
				])
			};
		case 'categories':
			return {
				header: ['Category (current)', 'Basis', 'Quantity', `Amount (${code})`],
				rows: report.byCategory.map((r) => [
					text(r.name),
					text(BASIS_LABEL[r.taxMode]),
					count(r.quantity),
					money(r.amount)
				])
			};
		case 'shifts': {
			const clock = localClock(c.timeZone);
			return {
				header: [
					'Device',
					'Business date',
					'Status',
					'Opened at',
					'Closed at',
					`Opening cash (${code})`,
					`Expected cash (${code})`,
					`Counted cash (${code})`,
					`Difference (${code})`
				],
				rows: report.sessions.map((s) => [
					text(s.deviceCode),
					text(s.businessDate),
					text(s.status === 'open' ? 'Open' : 'Closed'),
					text(clock(s.openedAt)),
					text(clock(s.closedAt)),
					money(s.openingCash),
					money(s.expectedCash),
					money(s.countedCash),
					money(s.difference)
				])
			};
		}
		default:
			throw new Error(`not a grouped section: ${section}`);
	}
}

async function taxRates(c: Ctx): Promise<Sheet> {
	const code = c.format.code;
	const rows = await salesByTaxRate(c.tx, c.restaurantId, c.from, c.to);
	return {
		header: ['Tax rate', 'Rate (%)', 'Basis', 'Lines', 'Quantity', `Amount (${code})`],
		rows: rows.map((r) => [
			text(r.taxRateName ?? 'Rate not recorded'),
			text(rate(r.taxRateBp)),
			text(BASIS_LABEL[r.taxMode]),
			count(r.lineCount),
			count(r.quantity),
			money(r.amount)
		])
	};
}

async function ordersSheet(c: Ctx): Promise<Sheet> {
	const total = await countOrders(c.tx, c.restaurantId, c.from, c.to);
	if (total > c.rowCap) throw new ExportTooLarge(total);
	const code = c.format.code;
	const rows = await orderRows(c.tx, c.restaurantId, c.from, c.to, { order: 'asc' });
	return {
		header: [
			'Business date',
			'Device',
			'Invoice number',
			'Paid at',
			'Received at',
			'Order type',
			'Table',
			'Employee',
			'Tax mode',
			'Lines',
			`Subtotal (${code})`,
			`Discount (${code})`,
			`Tax (${code})`,
			`Total (${code})`,
			'Payment type',
			'Payment method',
			'Flag',
			'Note'
		],
		rows: rows.map((r) => [
			text(r.businessDate),
			text(r.deviceCode),
			text(r.invoiceNumber),
			text(r.paidAt),
			text(r.receivedAt),
			text(ORDER_TYPE_LABEL[r.orderType] ?? r.orderType),
			text(r.tableLabel),
			text(r.employeeName ?? 'Unknown employee'),
			text(MODE_LABEL[r.taxMode]),
			count(r.lineCount),
			money(r.subtotal),
			money(r.discount),
			money(r.tax),
			money(r.total),
			text(r.payments.map((p) => KIND_LABEL[p.kind]).join('; ')),
			text(r.payments.map((p) => p.name ?? KIND_LABEL[p.kind]).join('; ')),
			text(r.flagReason),
			text(r.note)
		])
	};
}

async function linesSheet(c: Ctx): Promise<Sheet> {
	const total = await countLines(c.tx, c.restaurantId, c.from, c.to);
	if (total > c.rowCap) throw new ExportTooLarge(total);
	const code = c.format.code;
	const plain = (v: Minor) => formatAmountPlain(v, c.format);
	const rows = await lineRows(c.tx, c.restaurantId, c.from, c.to);
	return {
		header: [
			'Business date',
			'Device',
			'Invoice number',
			'Paid at',
			'Order type',
			'Tax mode',
			'Line',
			'Item',
			'Quantity',
			`Unit price (${code})`,
			'Modifiers',
			`Modifier total (${code})`,
			'Tax rate',
			'Rate (%)',
			`Line discount (${code})`,
			`Line amount (${code})`,
			'Basis'
		],
		rows: rows.map((r) => [
			text(r.businessDate),
			text(r.deviceCode),
			text(r.invoiceNumber),
			text(r.paidAt),
			text(ORDER_TYPE_LABEL[r.orderType] ?? r.orderType),
			text(MODE_LABEL[r.taxMode]),
			count(r.lineNo),
			text(r.itemName),
			count(r.quantity),
			money(r.unitPrice),
			text(
				r.modifiers
					.map((mod) => `${mod.name} (${mod.delta >= 0n ? '+' : ''}${plain(mod.delta)})`)
					.join('; ') || null
			),
			money(r.modifierTotal),
			text(r.taxRateName ?? 'Rate not recorded'),
			text(rate(r.taxRateBp)),
			money(r.discount),
			money(r.lineAmount),
			text(BASIS_LABEL[r.taxMode])
		])
	};
}

/** One section of the range's sales report as a CSV file. */
export async function buildExport(
	database: Db,
	restaurantId: string,
	range: { from: string; to: string },
	section: ExportSection,
	opts: { rowCap?: number; now?: Date } = {}
): Promise<{ filename: string; csv: string }> {
	const now = opts.now ?? new Date();
	return database.transaction(async (tx) => {
		await tx.execute(sql`set transaction read only`);
		await tx.execute(sql`set local statement_timeout = '30s'`);

		const settings = await tx.execute<{
			name: string;
			time_zone: string;
			currency_code: string | null;
			generated_at: string;
		}>(sql`
			select r.name, rs.time_zone, rs.currency_code,
				to_char(${now.toISOString()}::timestamptz at time zone rs.time_zone,
					'YYYY-MM-DD HH24:MI:SS') as generated_at
			from restaurants r
			join restaurant_settings rs on rs.restaurant_id = r.id
			where r.id = ${restaurantId}
		`);
		const row = settings.rows[0];
		if (!row) throw new Error(`no restaurant ${restaurantId}`);
		if (row.currency_code === null) throw new CurrencyNotSet();

		const c: Ctx = {
			tx,
			restaurantId,
			from: range.from,
			to: range.to,
			format: moneyFormatFor(row.currency_code),
			timeZone: row.time_zone,
			restaurantName: row.name,
			generatedAt: row.generated_at,
			rowCap: opts.rowCap ?? EXPORT_ROW_CAP
		};
		const sheet =
			section === 'summary'
				? await summary(c)
				: section === 'days'
					? await days(c)
					: section === 'tax-rates'
						? await taxRates(c)
						: section === 'orders'
							? await ordersSheet(c)
							: section === 'lines'
								? await linesSheet(c)
								: await grouped(c, section);
		return {
			filename: `matcami-sales-${range.from}_${range.to}-${section}.csv`,
			csv: toCsv(sheet.header, sheet.rows, c.format)
		};
	});
}
