// Today's business date for a dashboard write, in the restaurant's own time zone
// (spec 17; invariant 11). Computed IN SQL from restaurant_settings.time_zone —
// never with JavaScript dates, whose zone is the server's.
import { sql } from 'drizzle-orm';
import type { Executor } from '../auth/session';

export async function todayInZone(executor: Executor, restaurantId: string): Promise<string> {
	const result = await executor.execute<{ today: string }>(sql`
		select to_char(now() at time zone s.time_zone, 'YYYY-MM-DD') as today
		from restaurant_settings s
		where s.restaurant_id = ${restaurantId}
	`);
	const row = result.rows[0];
	if (!row) throw new Error(`restaurant settings not found: ${restaurantId}`);
	return row.today;
}
