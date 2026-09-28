// T-28: the till's invoice-hint reader. GREATEST across `invoices.invoice_seq`
// AND `pos_sync_ops.invoice_seq` (every status: accepted, recorded_flagged
// AND unrecorded — an unrecorded sale burned its number just the same, and a
// hint that ignored it would let a re-bound till reuse a number already
// printed on a receipt). Scoped by (restaurant_id, device_id).
//
// Cast ::int in SQL because a sequence number is a COUNT, not money; Number()
// never touches a *_minor column.

import { sql } from 'drizzle-orm';
import type { Executor } from '../auth/session';

export async function lastInvoiceSeqForDevice(
	database: Executor,
	restaurantId: string,
	deviceId: string
): Promise<number> {
	const result = await database.execute<{ last_seq: number }>(sql`
		select greatest(
			coalesce((select max(invoice_seq) from invoices
			          where restaurant_id = ${restaurantId} and device_id = ${deviceId}), 0),
			coalesce((select max(invoice_seq) from pos_sync_ops
			          where restaurant_id = ${restaurantId} and device_id = ${deviceId}), 0)
		)::int as last_seq
	`);
	// ::int, so pg hands back a JavaScript number — no conversion needed.
	return result.rows[0]?.last_seq ?? 0;
}
