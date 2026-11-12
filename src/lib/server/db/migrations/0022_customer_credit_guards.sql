-- Customer credit (tasks/customer-credit T-03): the database rules drizzle-kit
-- cannot write, and the two rows every EXISTING restaurant needs.
--
-- Created with `drizzle-kit generate --custom`, the only form that registers the
-- file in migrations/meta/_journal.json. This file has NO DDL drizzle-kit knows
-- about (its snapshot is a copy of 0021's): triggers and data only, the 0017
-- precedent. NEVER edit it once it has run — add a new migration instead.
--
-- 1. THE TRIGGERS.
--    customers are archived, never deleted: a queued offline credit sale names a
--    customer by id, and that id must still resolve when the sale arrives
--    (invariant 5). It reuses 0017's catalogue_archive_only().
--    customer_payments is a posted record (invariant 2): no DELETE, and the only
--    UPDATE allowed is the reversal stamp — every reversal column set together,
--    once, with nothing else changed. A row is inserted WITH its
--    journal_entry_id, so no other write ever follows the insert.
--    Like 0012, 0014 and 0017 the triggers do not cover TRUNCATE (the test
--    harness resets by truncating; the runtime role holds no TRUNCATE privilege).
--
-- 2. THE SEED, for restaurants that exist before the initializers of
--    tasks/customer-credit run for new ones:
--    - account 1100 Accounts Receivable (asset) — the one account spec 23 does
--      not name, added by the user's decision of 2026-11-12;
--    - the built-in Customer credit payment method, kind 'credit', DISABLED: the
--      owner switches it on. Named 'Customer credit', or 'Customer credit
--      (account)' where a live method of that restaurant already has that name
--      (payment_methods_name_unique is on lower(name) among live rows).
--    Both statements are idempotent. Nothing is posted; no order, payment,
--    invoice or journal row is read or written. No menu_version bump: payment
--    methods are not in the menu snapshot.
--
-- src/lib/server/db/schema-guards/backfill-0022.integration.test.ts re-runs
-- exactly the statements between the two BACKFILL marker lines below, so never
-- move them.

CREATE TRIGGER customers_archive_only
  BEFORE DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION catalogue_archive_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION customer_payments_guard() RETURNS trigger AS $$
DECLARE
  reversal_columns text[] := ARRAY[
    'reversed_at', 'reversed_by_user_id', 'reversal_reason',
    'reversal_entry_id', 'reversal_business_date'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_payments is append-only: DELETE is not permitted'
      USING HINT = 'Reverse the payment with a reason, never delete it';
  END IF;
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'customer_payments: payment % is already reversed', OLD.id
      USING HINT = 'A reversal is written once';
  END IF;
  IF (to_jsonb(OLD) - reversal_columns) IS DISTINCT FROM (to_jsonb(NEW) - reversal_columns) THEN
    RAISE EXCEPTION 'customer_payments is append-only: only the reversal stamp may be written'
      USING HINT = 'Correct a mistake with a reversal, never by changing a posted payment';
  END IF;
  IF NEW.reversed_at IS NULL THEN
    RAISE EXCEPTION 'customer_payments: an update must set the reversal stamp';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER customer_payments_guard
  BEFORE UPDATE OR DELETE ON customer_payments
  FOR EACH ROW EXECUTE FUNCTION customer_payments_guard();
--> statement-breakpoint
-- BACKFILL BEGIN
-- 1100 Accounts Receivable for every restaurant (accounts_restaurant_code_unique).
INSERT INTO "accounts" ("restaurant_id", "code", "name", "type")
SELECT r."id", '1100', 'Accounts Receivable', 'asset'
FROM "restaurants" r
ON CONFLICT ("restaurant_id", "code") DO NOTHING;
--> statement-breakpoint
-- The built-in Customer credit method, disabled, after the restaurant's last method.
INSERT INTO "payment_methods" ("restaurant_id", "name", "kind", "enabled", "sort_order")
SELECT
  r."id",
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "payment_methods" taken
      WHERE taken."restaurant_id" = r."id"
        AND taken."archived_at" IS NULL
        AND lower(taken."name") = 'customer credit'
    ) THEN 'Customer credit (account)'
    ELSE 'Customer credit'
  END,
  'credit',
  false,
  COALESCE((SELECT max(pm."sort_order") FROM "payment_methods" pm WHERE pm."restaurant_id" = r."id"), 0) + 1
FROM "restaurants" r
WHERE NOT EXISTS (
  SELECT 1 FROM "payment_methods" existing
  WHERE existing."restaurant_id" = r."id" AND existing."kind" = 'credit'
);
-- BACKFILL END
