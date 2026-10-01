import { sql } from 'drizzle-orm';
import {
	pgTable,
	uuid,
	text,
	smallint,
	integer,
	timestamp,
	check,
	primaryKey,
	customType
} from 'drizzle-orm/pg-core';
import { restaurants } from './restaurants';

// THE RECEIPT LAYOUT the owner configures (spec 11, 4;
// tasks/settings-tax-payments-receipt): header and footer lines, and a logo
// printed at the top. Spec 33 open decision 3 (what a receipt must legally show)
// is STILL OPEN; nothing here makes a field mandatory.
//
// HEADER AND FOOTER LINES (receipt_lines): at most 5 per section, each 1–120
// characters with NO control characters. The writer (T-12) trims them, drops
// blank lines and renumbers them 1..n. Replacing a section is a plain DELETE +
// INSERT: this is layout configuration that nothing references, not a posted
// record (invariant 2 does not reach it).
//
// THE LOGO (receipt_logos) is a 1-bit raster, packed MSB first, with 1 meaning
// black:
//   - its width is a multiple of 8 from 8 to 384 dots and its height is 1–160
//     dots (gate decision 7), which fits 58 mm and 80 mm paper;
//   - byte_size = width/8 × height, so it is at most 7,680 bytes;
//   - sha256 is the lowercase hex fingerprint the till compares against its
//     cached copy.
// One row per restaurant: replacing the logo is an upsert and removing it is a
// DELETE.
//
// These numbers equal RECEIPT_LINE_MAX, RECEIPT_LINES_PER_SECTION,
// LOGO_MAX_WIDTH_DOTS and LOGO_MAX_HEIGHT_DOTS in src/lib/receipt-layout.ts
// (created by T-12). They are spelled identically and NOT imported, because
// drizzle-kit loads this file outside Vite.
//
// NO CONTROL BYTE REACHES THE PRINTER FROM HERE (invariant 9: opening the drawer
// without a sale needs the owner's PIN). receipt_lines_body_valid refuses control
// characters (!~ '[[:cntrl:]]'), so an ESC (0x1B) can never ride on receipt text
// and start the drawer pulse ESC p. The logo's bytes are PLAIN PIXEL DATA of an
// exact byte count: only the print agent turns them into ESC/POS (T-25), which is
// why a pixel pattern equal to the drawer pulse 1B 70 00 19 FA stays pixels and
// can never become a drawer command.

const tenant = () =>
	uuid('restaurant_id')
		.notNull()
		.references(() => restaurants.id, { onDelete: 'restrict' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// copied from menu.ts: bytea has no builder in drizzle-orm 0.45.2; per-file, like tenant()
const byteaColumn = customType<{ data: Uint8Array; driverData: Buffer }>({
	dataType: () => 'bytea',
	toDriver: (value) => Buffer.from(value),
	fromDriver: (value) => new Uint8Array(value)
});

export const receiptLines = pgTable(
	'receipt_lines',
	{
		restaurantId: tenant(),
		section: text('section').notNull(),
		position: smallint('position').notNull(),
		body: text('body').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		primaryKey({ name: 'receipt_lines_pk', columns: [t.restaurantId, t.section, t.position] }),
		check('receipt_lines_section_valid', sql`${t.section} in ('header', 'footer')`),
		check('receipt_lines_position_range', sql`${t.position} between 1 and 5`),
		check(
			'receipt_lines_body_valid',
			sql`char_length(${t.body}) between 1 and 120 and ${t.body} !~ '[[:cntrl:]]'`
		)
	]
);

// One logo per restaurant, so the restaurant id IS the primary key (the
// restaurant_settings idiom).
export const receiptLogos = pgTable(
	'receipt_logos',
	{
		restaurantId: uuid('restaurant_id')
			.primaryKey()
			.references(() => restaurants.id, { onDelete: 'restrict' }),
		widthDots: integer('width_dots').notNull(),
		heightDots: integer('height_dots').notNull(),
		byteSize: integer('byte_size').notNull(),
		bitmap: byteaColumn('bitmap').notNull(),
		sha256: text('sha256').notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		check(
			'receipt_logos_width_dots_valid',
			sql`${t.widthDots} between 8 and 384 and ${t.widthDots} % 8 = 0`
		),
		check('receipt_logos_height_dots_range', sql`${t.heightDots} between 1 and 160`),
		check(
			'receipt_logos_byte_size_matches',
			sql`${t.byteSize} = (${t.widthDots} / 8) * ${t.heightDots} and octet_length(${t.bitmap}) = ${t.byteSize}`
		),
		check('receipt_logos_sha256_format', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`)
	]
);
