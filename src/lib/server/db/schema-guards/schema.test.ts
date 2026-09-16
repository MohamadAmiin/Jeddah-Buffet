import { readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns, is } from 'drizzle-orm';
import {
	PgTable,
	bigint,
	getTableConfig,
	integer,
	numeric,
	pgTable,
	text
} from 'drizzle-orm/pg-core';

import * as restaurantsSchema from '../schema/restaurants';
import * as restaurantSettingsSchema from '../schema/restaurant-settings';
import * as usersSchema from '../schema/users';
import * as sessionsSchema from '../schema/sessions';
import * as auditSchema from '../schema/audit';
import * as posDevicesSchema from '../schema/pos-devices';
import * as menuSchema from '../schema/menu';
import { TABLES } from '../test/reset';

// Tables are DISCOVERED from the schema modules' exports, never from a
// hand-maintained list of table names — a hand-maintained list is a list someone
// forgets to update, which is exactly the failure these tests exist to prevent.
// Adding a table to an existing file is picked up automatically; adding a new
// FILE needs one import line here, and its file name in IMPORTED_SCHEMA_FILES.
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
	...auditSchema,
	...posDevicesSchema,
	...menuSchema
};

// Every file in src/lib/server/db/schema/ that is imported above. A schema file
// nobody imports is invisible to every guard in this file while every test stays
// green, so the 'imports every file' case below holds this list to the directory.
const IMPORTED_SCHEMA_FILES = [
	'audit.ts',
	'menu.ts',
	'pos-devices.ts',
	'restaurant-settings.ts',
	'restaurants.ts',
	'sessions.ts',
	'users.ts'
];

type GuardedTable = { name: string; table: PgTable };

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

// ── The column naming convention invariant 1 is enforced through ─────────────
//
// A column's type alone cannot say whether it is money — audit_log.id is a
// bigint and is not — so every money rule below keys off the column NAME. That
// makes the name a contract, and every schema task is held to it:
//
//   - a MONEY column's name ends in `_minor` and its type is `bigint`:
//     price_minor, total_minor, opening_cash_minor. $8.50 is 850.
//   - a RATE or percentage is an integer in BASIS POINTS and its name ends in
//     `_bp`: tax_rate_bp, where 825 means 8.25%. Never a float, never numeric.
//   - an INGREDIENT QUANTITY is numeric(12, 3) and its name contains `qty` or
//     `quantity`. It is the one fixed-point type the schema permits.
//
// Without the positive `_minor` rule a price typed numeric(12,2) passes, pg hands
// it back as a string, and the first arithmetic on it coerces to a float.

// ADDING TO THIS LIST IS A PLAN'S DECISION, NEVER A CONVENIENCE. Keyed
// `table.column`; each entry carries the reason that column may have a money-like
// name without the `_minor` or `_bp` suffix.
const MONEY_NAME_EXEMPT: Record<string, string> = {};

const MONEY_NAME =
	/(^|_)(price|amount|total|subtotal|cost|fee|tax|discount|charge|tip|balance|cash)(_|$)/;
const QUANTITY_NAME = /(^|_)(qty|quantity)(_|$)/;
const NUMERIC_TYPES = new Set([
	'bigint',
	'integer',
	'smallint',
	'real',
	'double precision',
	'money'
]);

/**
 * Every numeric-type offence in `list`, one message per broken rule.
 *
 * The rules do NOT short-circuit — independent `if`s, no `continue`. A
 * price_minor typed numeric(12, 2), the exact defect this guard exists to
 * catch, breaks the fixed-point rule AND the `_minor` rule, and only the second
 * message names bigint.
 */
function numericColumnOffenders(list: GuardedTable[]): string[] {
	const offenders: string[] = [];
	for (const { table, name } of list) {
		for (const column of Object.values(getTableColumns(table))) {
			const sql = column.getSQLType().toLowerCase();
			// drizzle renders `numeric(12, 3)` WITH a space after the comma, so every
			// fixed-point comparison is made against the whitespace-stripped form.
			const compact = sql.replace(/\s+/g, '');
			const columnName = column.name;
			const where = `${name}.${columnName} is "${sql}"`;
			const fixedPoint = compact.startsWith('numeric(') || compact.startsWith('decimal(');

			if (sql === 'real' || sql === 'double precision') {
				offenders.push(`${where} — money is bigint minor units, never a float`);
			}
			// `numeric` with no precision/scale is unconstrained: it would accept
			// anything and is never what this project wants.
			if (compact === 'numeric' || compact === 'decimal') {
				offenders.push(`${where} — numeric needs explicit precision and scale, e.g. numeric(12,3)`);
			}
			if (fixedPoint && compact !== 'numeric(12,3)') {
				offenders.push(
					`${where} — the only permitted fixed-point type is numeric(12, 3), for ingredient quantities`
				);
			}
			if (compact === 'numeric(12,3)' && !QUANTITY_NAME.test(columnName)) {
				offenders.push(
					`${where} — a numeric(12, 3) column is an ingredient quantity; name it <thing>_qty`
				);
			}
			if (columnName.endsWith('_minor') && sql !== 'bigint') {
				offenders.push(`${where} — money is integer minor units in bigint (invariant 1)`);
			}
			if (columnName.endsWith('_bp') && sql !== 'integer') {
				offenders.push(`${where} — a rate is an integer in basis points`);
			}
			// Restricted to numeric-ish types on purpose: a text column called tax_mode
			// is a setting, not an amount.
			if (
				MONEY_NAME.test(columnName) &&
				!columnName.endsWith('_minor') &&
				!columnName.endsWith('_bp') &&
				!(`${name}.${columnName}` in MONEY_NAME_EXEMPT) &&
				(NUMERIC_TYPES.has(sql) || fixedPoint)
			) {
				offenders.push(
					`${where} — a money column is named <thing>_minor and typed bigint; a rate is an integer named <thing>_bp`
				);
			}
		}
	}
	return offenders;
}

describe('schema guards every future aggregate inherits', () => {
	it('discovers the tables it is meant to guard', () => {
		expect(tables.map((t) => t.name).sort()).toEqual([
			'audit_log',
			'menu_categories',
			'menu_item_modifier_groups',
			'menu_items',
			'modifier_groups',
			'modifiers',
			'pos_devices',
			'restaurant_settings',
			'restaurants',
			'sessions',
			'users'
		]);
	});

	// Adding a schema file fails this until the file is imported at the top of this
	// guard AND listed in IMPORTED_SCHEMA_FILES — otherwise its tables escape the
	// tenant, timestamp and money guards below with every test still green.
	it('imports every file in src/lib/server/db/schema', () => {
		const onDisk = readdirSync(new URL('../schema', import.meta.url))
			.filter((file) => file.endsWith('.ts'))
			.sort();
		expect(
			onDisk,
			'A schema file is not imported by this guard. Import it above and add its file name ' +
				'to IMPORTED_SCHEMA_FILES, or its tables are never checked.'
		).toEqual([...IMPORTED_SCHEMA_FILES].sort());
	});

	// A table that exists but is never truncated leaks rows between integration
	// test files, and the symptoms point away from the cause.
	it('truncates every table it guards', () => {
		expect([...TABLES].sort()).toEqual(tables.map((t) => t.name).sort());
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
	// are numeric(12,3). Every money rule keys off the column name, so audit_log.id
	// — a bigint that is not money — is correctly left alone.
	it('every money column is bigint minor units, and no float or unconstrained decimal exists (invariant 1)', () => {
		const offenders = numericColumnOffenders(tables);
		expect(offenders, `Forbidden numeric columns: ${offenders.join('; ')}`).toEqual([]);
	});

	// MANDATORY (spec 29 — money arithmetic and rounding): the schema-level half,
	// the guard that stops a money value being stored as anything but integer minor
	// units. Fixture columns are declared HERE and never spread into `modules`, so
	// the tenant and timestamp guards never see them.
	it('flags every column shape invariant 1 forbids and passes the ones it permits', () => {
		const fixture = pgTable('fixture_money', {
			priceMinorAsFixedPoint: numeric('price_minor', { precision: 12, scale: 2 }),
			priceWithoutSuffix: bigint('price', { mode: 'bigint' }),
			taxRateWithoutSuffix: integer('tax_rate'),
			quantityWithoutSuffix: numeric('flour', { precision: 12, scale: 3 }),
			totalAmountMinor: bigint('total_amount_minor', { mode: 'bigint' }),
			taxRateBp: integer('tax_rate_bp'),
			flourQty: numeric('flour_qty', { precision: 12, scale: 3 }),
			taxMode: text('tax_mode')
		});
		const offenders = numericColumnOffenders([{ name: 'fixture_money', table: fixture }]);
		const about = (column: string) =>
			offenders.filter((message) => message.startsWith(`fixture_money.${column} is `));

		// The case the guard did not catch before T-04. Two messages (the rules do
		// not short-circuit), and the one asserted on is the one that names bigint —
		// the fixed-point message alone would not have caught the defect.
		expect(about('price_minor')).toHaveLength(2);
		expect(
			about('price_minor').some((m) => m.includes('money is integer minor units in bigint'))
		).toBe(true);

		expect(about('price')).toHaveLength(1); // right type, wrong name
		expect(about('tax_rate')).toHaveLength(1); // a rate must be _bp
		expect(about('flour')).toHaveLength(1); // a quantity must be named so

		expect(about('total_amount_minor')).toEqual([]);
		expect(about('tax_rate_bp')).toEqual([]);
		expect(about('flour_qty')).toEqual([]);
		expect(about('tax_mode')).toEqual([]);
	});

	// MANDATORY (spec 29 — money arithmetic): the menu's two money columns, as a
	// committed assertion rather than a manual "change it and watch it go red".
	it('every money column on the menu tables is bigint minor units (invariant 1)', () => {
		// The negative half: the menu's column names typed as fixed-point decimals.
		// Declared HERE, never under src/lib/server/db/schema/ and never in `modules`.
		const fixture = pgTable('fixture_menu', {
			priceMinor: numeric('price_minor', { precision: 12, scale: 2 }),
			priceDeltaMinor: numeric('price_delta_minor', { precision: 12, scale: 2 })
		});
		const offenders = numericColumnOffenders([{ name: 'fixture_menu', table: fixture }]);
		for (const column of ['price_minor', 'price_delta_minor']) {
			const messages = offenders.filter((m) => m.startsWith(`fixture_menu.${column} is `));
			expect(messages.some((m) => m.includes('money is integer minor units in bigint'))).toBe(true);
		}

		// The positive half, over the REAL schema.
		expect(menuSchema.menuItems.priceMinor.getSQLType()).toBe('bigint');
		expect(menuSchema.modifiers.priceDeltaMinor.getSQLType()).toBe('bigint');
		expect(numericColumnOffenders(tables)).toEqual([]);
	});
});
