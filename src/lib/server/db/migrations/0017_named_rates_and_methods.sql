-- Named tax rates and payment methods (tasks/settings-tax-payments-receipt T-07): the
-- database rules drizzle-kit cannot write, and the data that carries every
-- restaurant's existing answers into the tables 0016 created.
--
-- Created with `drizzle-kit generate --custom`, the only form that registers the
-- file in migrations/meta/_journal.json — a .sql file dropped into this folder by
-- hand is silently never applied. CLAUDE.md reserves --custom for DATA; a trigger
-- is the one other thing drizzle-kit cannot express, and migrations 0004, 0012
-- and 0014 are the precedents. This file has NO other DDL: its snapshot
-- (meta/0017_snapshot.json) is a copy of 0016's, so a table or column change
-- written here would be a drift the next `pnpm db:generate` re-emits.
--
-- 1. THE TRIGGERS. tax_rates and payment_methods are archive-only: a queued
--    offline sale names a rate and a method by id, and that id must still resolve
--    when the sale arrives a week later (invariant 5), so a row is archived
--    (archived_at), never deleted. A payment method's kind is permanent: the kind
--    picks the posting row (Dr 1000 cash, 1020 card, 1030 mobile — spec 24), and
--    payments.method copies it, so changing it would relabel every posted sale
--    taken with that method. Like 0012 and 0014, the triggers deliberately do not
--    cover TRUNCATE: TRUNCATE fires only statement-level triggers, the integration
--    harness resets the test database by truncating (test/reset.ts), and the
--    runtime role matcami_app holds no TRUNCATE privilege.
--
-- 2. THE BACKFILL carries each restaurant's existing answers across and invents
--    none (the plan's Risk 7). Every restaurant gets the built-in Cash method;
--    accepts_card / accepts_mobile = true becomes one enabled method of that kind;
--    a NON-NULL restaurant tax rate becomes the default rate named "Tax", and a
--    NULL one becomes no rate and no default — a silent 0% would post
--    Cr 2100 Tax Payable = 0 on every sale, which no reversing entry can recover
--    (spec 33 open decision 3 stays open); each distinct per-item rate that
--    differs from the restaurant rate becomes its own rate, and items point at
--    their rate by id; the receipt footer becomes footer line 1. It only COPIES:
--    the legacy columns stay as they are until migration 0018 drops them. Every
--    statement is idempotent (ON CONFLICT … DO NOTHING, or an UPDATE guarded by
--    "IS NULL"), except the closing menu_version bump, which runs once per
--    migration run.
--
-- 3. THE SALE TABLES ARE NEVER TOUCHED. This file reads and writes no order, no
--    order line, no payment and no invoice: payments and invoices are append-only
--    (0012) and paid orders and their lines are permanent (invariant 2). Sale rows
--    recorded before this migration keep NULL method and rate ids forever, and
--    every reader LEFT JOINs and falls back to the stored kind or rate.
--
-- src/lib/server/db/schema-guards/backfill-0017.integration.test.ts re-runs
-- exactly the statements between the two BACKFILL marker lines below, so never
-- move them; the triggers stay outside the markers because they cannot be
-- created twice.

CREATE OR REPLACE FUNCTION catalogue_archive_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are archived, never deleted', TG_TABLE_NAME
    USING HINT = 'Set archived_at instead';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER tax_rates_archive_only
  BEFORE DELETE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION catalogue_archive_only();
--> statement-breakpoint
CREATE TRIGGER payment_methods_archive_only
  BEFORE DELETE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION catalogue_archive_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_method_kind_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_methods.kind is fixed: % cannot become %', OLD.kind, NEW.kind
    USING HINT = 'Archive this method and add a new one of the other kind';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_methods_kind_immutable
  BEFORE UPDATE OF kind ON payment_methods
  FOR EACH ROW
  WHEN (OLD.kind IS DISTINCT FROM NEW.kind)
  EXECUTE FUNCTION payment_method_kind_immutable();
--> statement-breakpoint
-- BACKFILL BEGIN
-- Cash: every restaurant gets the built-in Cash method (one per restaurant, payment_methods_one_cash).
INSERT INTO "payment_methods" ("restaurant_id", "name", "kind", "enabled", "sort_order")
SELECT r."id", 'Cash', 'cash', true, 0
FROM "restaurants" r
ON CONFLICT ("restaurant_id") WHERE "kind" = 'cash' DO NOTHING;
--> statement-breakpoint
-- Card: accepts_card = true becomes one enabled card method with no merchant number; false or NULL becomes nothing.
INSERT INTO "payment_methods" ("restaurant_id", "name", "kind", "enabled", "sort_order")
SELECT s."restaurant_id", 'Card', 'card', true, 1
FROM "restaurant_settings" s
WHERE s."accepts_card" IS TRUE
ON CONFLICT ("restaurant_id", lower("name")) WHERE "archived_at" IS NULL DO NOTHING;
--> statement-breakpoint
-- Mobile: accepts_mobile = true becomes one enabled mobile method with no merchant number; false or NULL becomes nothing.
INSERT INTO "payment_methods" ("restaurant_id", "name", "kind", "enabled", "sort_order")
SELECT s."restaurant_id", 'Mobile money', 'mobile', true, 2
FROM "restaurant_settings" s
WHERE s."accepts_mobile" IS TRUE
ON CONFLICT ("restaurant_id", lower("name")) WHERE "archived_at" IS NULL DO NOTHING;
--> statement-breakpoint
-- Restaurant rate: a NON-NULL rate becomes the rate "Tax" (gate decision 5); a NULL rate becomes no rate at all.
INSERT INTO "tax_rates" ("restaurant_id", "name", "rate_bp", "sort_order")
SELECT s."restaurant_id", 'Tax', s."tax_rate_bp", 0
FROM "restaurant_settings" s
WHERE s."tax_rate_bp" IS NOT NULL
ON CONFLICT ("restaurant_id", lower("name")) WHERE "archived_at" IS NULL DO NOTHING;
--> statement-breakpoint
-- Default: "Tax" becomes the default rate; a restaurant with no rate keeps default_tax_rate_id NULL.
UPDATE "restaurant_settings" s
SET "default_tax_rate_id" = t."id"
FROM "tax_rates" t
WHERE s."default_tax_rate_id" IS NULL
  AND t."restaurant_id" = s."restaurant_id"
  AND t."archived_at" IS NULL
  AND t."name" = 'Tax'
  AND t."rate_bp" = s."tax_rate_bp";
--> statement-breakpoint
-- Item rates: each distinct per-item rate that differs from the restaurant rate becomes "Tax " || formatTaxRate(rate_bp).
INSERT INTO "tax_rates" ("restaurant_id", "name", "rate_bp", "sort_order")
SELECT o."restaurant_id",
       'Tax ' || (o."tax_rate_bp" / 100)::text || '.' || lpad((o."tax_rate_bp" % 100)::text, 2, '0') || '%',
       o."tax_rate_bp",
       (row_number() OVER (PARTITION BY o."restaurant_id" ORDER BY o."tax_rate_bp"))::integer
FROM (
  SELECT DISTINCT i."restaurant_id", i."tax_rate_bp"
  FROM "menu_items" i
  LEFT JOIN "restaurant_settings" s ON s."restaurant_id" = i."restaurant_id"
  WHERE i."tax_rate_bp" IS NOT NULL
    AND (s."tax_rate_bp" IS NULL OR i."tax_rate_bp" <> s."tax_rate_bp")
) o
ON CONFLICT ("restaurant_id", lower("name")) WHERE "archived_at" IS NULL DO NOTHING;
--> statement-breakpoint
-- An item whose own rate EQUALS the restaurant rate points at the default row by id, never NULL (archived items included).
UPDATE "menu_items" i
SET "tax_rate_id" = s."default_tax_rate_id"
FROM "restaurant_settings" s
WHERE i."tax_rate_id" IS NULL
  AND i."tax_rate_bp" IS NOT NULL
  AND s."restaurant_id" = i."restaurant_id"
  AND s."default_tax_rate_id" IS NOT NULL
  AND i."tax_rate_bp" = s."tax_rate_bp";
--> statement-breakpoint
-- Every other item with its own rate points at that rate's named row; the name expression is the one above, verbatim.
UPDATE "menu_items" i
SET "tax_rate_id" = t."id"
FROM "tax_rates" t
WHERE i."tax_rate_id" IS NULL
  AND i."tax_rate_bp" IS NOT NULL
  AND t."restaurant_id" = i."restaurant_id"
  AND t."archived_at" IS NULL
  AND t."rate_bp" = i."tax_rate_bp"
  AND t."name" = 'Tax ' || (i."tax_rate_bp" / 100)::text || '.' || lpad((i."tax_rate_bp" % 100)::text, 2, '0') || '%';
--> statement-breakpoint
-- Footer: the receipt footer becomes footer line 1, copied as it is.
INSERT INTO "receipt_lines" ("restaurant_id", "section", "position", "body")
SELECT s."restaurant_id", 'footer', 1, s."receipt_footer"
FROM "restaurant_settings" s
WHERE s."receipt_footer" IS NOT NULL
ON CONFLICT ("restaurant_id", "section", "position") DO NOTHING;
--> statement-breakpoint
-- Version: one bump for every restaurant, because every till's cached menu predates named rates (spec 5).
UPDATE "restaurant_settings" SET "menu_version" = "menu_version" + 1;
-- BACKFILL END
