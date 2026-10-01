// T-37: the read side of the review queue. Lists and counts pos_sync_ops rows
// that are not accepted and not yet resolved (neither retried nor dismissed),
// and summarises a stored payload for display. It never returns the raw
// payload to a page and never retries or dismisses anything — those are
// orders/sync.ts's retryOp and dismissOp, called by the route.

import { sql } from 'drizzle-orm';
import type { Executor } from '../auth/session';
import { minor } from '../../money';
import { formatMoney, type MoneyFormat } from '../../money/format';
import { formatInvoiceNumber, type OpKind } from '../../sync-ops';

export type FlaggedOp = {
	id: string;
	kind: OpKind;
	status: 'recorded_flagged' | 'unrecorded';
	flag: string | null;
	error: string | null;
	clientOpId: string;
	deviceCode: string;
	invoiceNumber: string | null;
	employeeName: string | null;
	occurredAt: Date;
	receivedAt: Date;
	businessDate: string | null;
	orderId: string | null;
	payload: unknown;
};

type Row = {
	id: string;
	kind: OpKind;
	status: 'recorded_flagged' | 'unrecorded';
	flag: string | null;
	error: string | null;
	client_op_id: string;
	device_code: string;
	invoice_seq: number | null;
	display_name: string | null;
	occurred_at: Date | string;
	received_at: Date | string;
	business_date: string | null;
	order_id: string | null;
	payload: unknown;
};

export async function listUnresolvedOps(
	database: Executor,
	restaurantId: string
): Promise<FlaggedOp[]> {
	const result = await database.execute<Row>(sql`
		select
			x.id::text as id,
			x.kind,
			x.status,
			x.flag,
			x.error,
			x.client_op_id,
			d.device_code,
			x.invoice_seq,
			u.display_name,
			x.occurred_at,
			x.received_at,
			s.business_date::text as business_date,
			x.order_id,
			x.payload
		from pos_sync_ops x
		join pos_devices d on d.id = x.device_id
		left join users u on u.id = x.employee_user_id and u.restaurant_id = ${restaurantId}
		left join pos_sessions s on s.id = x.pos_session_id and s.restaurant_id = ${restaurantId}
		where x.restaurant_id = ${restaurantId}
			and x.status <> 'accepted'
			and x.resolved_at is null
		order by x.received_at desc
	`);
	return result.rows.map((r) => {
		let invoiceNumber: string | null = null;
		if (r.invoice_seq !== null) {
			try {
				invoiceNumber = formatInvoiceNumber(r.device_code, r.invoice_seq);
			} catch {
				invoiceNumber = null;
			}
		}
		return {
			id: r.id,
			kind: r.kind,
			status: r.status,
			flag: r.flag,
			error: r.error,
			clientOpId: r.client_op_id,
			deviceCode: r.device_code,
			invoiceNumber,
			employeeName: r.display_name ?? null,
			occurredAt: new Date(r.occurred_at),
			receivedAt: new Date(r.received_at),
			businessDate: r.business_date ?? null,
			orderId: r.order_id,
			// The column holds the whole envelope, so retryOp can replay it; the
			// summary wants the op's own payload inside it.
			payload: isRecord(r.payload) && 'payload' in r.payload ? r.payload.payload : null
		};
	});
}

export async function countUnresolvedOps(
	database: Executor,
	restaurantId: string
): Promise<number> {
	const result = await database.execute<{ count: number }>(sql`
		select count(*)::int as count
		from pos_sync_ops x
		where x.restaurant_id = ${restaurantId}
			and x.status <> 'accepted'
			and x.resolved_at is null
	`);
	return result.rows[0]?.count ?? 0;
}

export type OpSummary = { lines: string[]; total: string | null; tender: string | null };

const UNREADABLE: OpSummary = { lines: ['Payload could not be read'], total: null, tender: null };
const DIGITS = /^-?\d+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function money(value: unknown, format: MoneyFormat | null): string | null {
	if (typeof value !== 'string' || !DIGITS.test(value) || format === null) return null;
	return formatMoney(minor(BigInt(value)), format);
}

export function summarizeOp(kind: OpKind, payload: unknown, format: MoneyFormat | null): OpSummary {
	try {
		if (!isRecord(payload)) return { ...UNREADABLE, lines: [...UNREADABLE.lines] };
		switch (kind) {
			case 'sale.complete': {
				if (!Array.isArray(payload.lines)) return { ...UNREADABLE, lines: [...UNREADABLE.lines] };
				const lines: string[] = [];
				for (const line of payload.lines) {
					if (
						!isRecord(line) ||
						typeof line.itemName !== 'string' ||
						typeof line.quantity !== 'number' ||
						!Number.isInteger(line.quantity)
					) {
						return { ...UNREADABLE, lines: [...UNREADABLE.lines] };
					}
					let text = `${line.quantity} × ${line.itemName}`;
					if (Array.isArray(line.modifiers)) {
						for (const m of line.modifiers) {
							if (isRecord(m) && typeof m.modifierName === 'string') text += ` + ${m.modifierName}`;
						}
					}
					lines.push(text);
				}
				const total = isRecord(payload.totals) ? money(payload.totals.totalMinor, format) : null;
				let tender: string | null = null;
				if (Array.isArray(payload.payments) && isRecord(payload.payments[0])) {
					const p = payload.payments[0];
					const amount = money(p.amountMinor, format);
					if (typeof p.method === 'string' && p.method.length > 0 && amount !== null) {
						tender = `${p.method[0].toUpperCase()}${p.method.slice(1)} ${amount}`;
					}
				}
				return { lines, total, tender };
			}
			case 'session.open': {
				const float = money(payload.openingCashMinor, format);
				if (float === null) return { ...UNREADABLE, lines: [...UNREADABLE.lines] };
				return { lines: [`Shift open · float ${float}`], total: null, tender: null };
			}
			case 'session.close': {
				const counted = money(payload.countedCashMinor, format);
				if (counted === null) return { ...UNREADABLE, lines: [...UNREADABLE.lines] };
				return { lines: [`Shift close · counted ${counted}`], total: null, tender: null };
			}
			case 'sale.abandoned': {
				if (typeof payload.reason !== 'string') {
					return { ...UNREADABLE, lines: [...UNREADABLE.lines] };
				}
				return { lines: [`Abandoned ${payload.reason}`], total: null, tender: null };
			}
			case 'pin.login':
				return { lines: ['PIN login'], total: null, tender: null };
			default:
				return { ...UNREADABLE, lines: [...UNREADABLE.lines] };
		}
	} catch {
		return { ...UNREADABLE, lines: [...UNREADABLE.lines] };
	}
}
