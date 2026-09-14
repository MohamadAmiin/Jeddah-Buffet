import { describe, it, expect } from 'vitest';
import { getTableColumns, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';

import * as restaurantsSchema from '../schema/restaurants';
import * as restaurantSettingsSchema from '../schema/restaurant-settings';
import * as usersSchema from '../schema/users';
import * as sessionsSchema from '../schema/sessions';
import * as auditSchema from '../schema/audit';

// Tables are DISCOVERED from the schema modules' exports, never from a
// hand-maintained list of table names — a hand-maintained list is a list someone
// forgets to update, which is exactly the failure these tests exist to prevent.
// Adding a table to an existing file is picked up automatically; adding a new
// FILE needs one import line here.
//
// These guards live OUTSIDE src/lib/server/db/schema/ deliberately: drizzle-kit
// readdirSync()s that folder with no extension filter and require()s everything
// in it, so a test file there makes pnpm db:generate and pnpm db:studio abort
// with "Vitest cannot be imported in a CommonJS module".
const modules = {
	...restaurantsSchema,
	...restaurantSettingsSchema,
	...usersSchema,
	...sessionsSchema,
	...auditSchema
};

const tables = Object.entries(modules)
	.filter(([, value]) => is(value, PgTable))
	.map(([exportName, table]) => ({
		exportName,
		table: table as PgTable,
		name: getTableConfig(table as PgTable).name
	}));

// ADDING TO THIS LIST IS A PLAN'S DECISION, NEVER A CONVENIENCE. Each entry
// carries the reason it is exempt.
const TENANT_COLUMN_EXEMPT: Record<string, string> = {
	// It IS the tenant.
	restaurants: 'the tenant itself',
	// Its primary key is the restaurant id, under the name restaurant_id.
	restaurant_settings: 'its primary key IS restaurant_id',
	// A session belongs to a user who belongs to a restaurant. Duplicating the
	// tenant here would create two places that can disagree.
	sessions: 'belongs to a user, who belongs to a restaurant'
};

describe('schema guards every future aggregate inherits', () => {
	it('discovers the tables it is meant to guard', () => {
		expect(tables.map((t) => t.name).sort()).toEqual([
			'audit_log',
			'restaurant_settings',
			'restaurants',
			'sessions',
			'users'
		]);
	});

	it('every tenant table has a restaurant_id column', () => {
		const offenders: string[] = [];
		for (const { table, name } of tables) {
			if (name in TENANT_COLUMN_EXEMPT) continue;
			const columnNames = Object.values(getTableColumns(table)).map((c) => c.name);
			if (!columnNames.includes('restaurant_id')) offenders.push(name);
		}
		expect(
			offenders,
			`These tables have no restaurant_id: ${offenders.join(', ')}. Every tenant table carries ` +
				'restaurant_id NOT NULL. If a table genuinely should not, add it to ' +
				'TENANT_COLUMN_EXEMPT with the reason — that is a plan decision, not a convenience.'
		).toEqual([]);
	});

	// The single most valuable assertion in this file. A bare timestamp() is the
	// tutorial idiom, it emits "timestamp without time zone", and node-postgres
	// then parses the value in the Node process's local zone — so on a server
	// running at UTC+3 every expiry and lock time silently reads three hours early,
	// and once the POS session table copies the idiom, business-date grouping is
	// off by the host offset with nothing failing loudly.
	it('every timestamp column is timestamptz (invariant 11)', () => {
		const offenders: string[] = [];
		for (const { table, name } of tables) {
			for (const column of Object.values(getTableColumns(table))) {
				const sqlType = column.getSQLType();
				if (!sqlType.startsWith('timestamp')) continue;
				if (!sqlType.includes('with time zone')) {
					offenders.push(`${name}.${column.name} is "${sqlType}"`);
				}
			}
		}
		expect(
			offenders,
			`Not timestamptz: ${offenders.join('; ')}. Use timestamp(col, { withTimezone: true }).`
		).toEqual([]);
	});

	// Money is integer minor units in bigint (invariant 1); ingredient quantities
	// are numeric(12,3). Anything else is a bug. This plan creates no such column,
	// so the test passes trivially today and earns its keep the first time a later
	// plan adds a price.
	it('no floating-point or unconstrained decimal column exists (invariant 1)', () => {
		const offenders: string[] = [];
		for (const { table, name } of tables) {
			for (const column of Object.values(getTableColumns(table))) {
				const sqlType = column.getSQLType().toLowerCase();
				const where = `${name}.${column.name} is "${sqlType}"`;

				if (sqlType === 'real' || sqlType === 'double precision') {
					offenders.push(`${where} — money is bigint minor units, never a float`);
					continue;
				}
				// `numeric` with no precision/scale is unconstrained: it would accept
				// anything and is never what this project wants.
				if (sqlType === 'numeric' || sqlType === 'decimal') {
					offenders.push(
						`${where} — numeric needs explicit precision and scale, e.g. numeric(12,3)`
					);
				}
			}
		}
		expect(offenders, `Forbidden numeric types: ${offenders.join('; ')}`).toEqual([]);
	});
});
