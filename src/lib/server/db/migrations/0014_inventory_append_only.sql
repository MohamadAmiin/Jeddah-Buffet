-- Invariant 2 IN THE DATABASE for the inventory records (spec 3: "Posted
-- records are permanent. Paid orders, invoices, payments, stock movements and
-- journal entries are never updated or deleted"). stock_movements,
-- purchase_lines, stock_count_lines, waste_entries and opening_stock_entries
-- are append-only: a mistake is corrected by a new, opposite record (a
-- reversal), never by changing a posted one.
--
-- NOT purchases, supplier_payments or stock_counts: their journal_entry_id and
-- reversal stamp are written ONCE after insert, so a row-level trigger would
-- refuse the one legitimate update; their amounts are protected by code. NOT
-- ingredients: it carries the three caches applyMovements updates
-- (src/lib/server/inventory/movements.ts).
--
-- Reuses migration 0012's posted_record_append_only() — one function, one
-- message ("<table> is append-only: <op> is not permitted"). Every trigger is
-- named <table>_append_only.
--
-- Created with `drizzle-kit generate --custom`, the only form that registers
-- the file in migrations/meta/_journal.json. CLAUDE.md reserves --custom for
-- DATA; a trigger is the one other thing drizzle-kit cannot express, and
-- migrations 0004 and 0012 are the precedents.
--
-- The append-only triggers cover UPDATE and DELETE and deliberately NOT
-- TRUNCATE. Three reasons, all of which have to hold together
-- (0004_audit_log_append_only.sql is the precedent):
--   1. TRUNCATE fires only STATEMENT-level triggers, so a row-level trigger
--      would not catch it anyway.
--   2. The integration harness resets the test database by truncating
--      (test/reset.ts), and a BEFORE TRUNCATE trigger would make every test
--      run after the first fail.
--   3. Production is protected by PRIVILEGE instead: TRUNCATE requires the
--      TRUNCATE privilege, which only the owner role holds; the runtime role
--      matcami_app owns nothing and was never granted it, so the application
--      cannot truncate a posted table.

CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
--> statement-breakpoint
CREATE TRIGGER purchase_lines_append_only
  BEFORE UPDATE OR DELETE ON purchase_lines
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
--> statement-breakpoint
CREATE TRIGGER stock_count_lines_append_only
  BEFORE UPDATE OR DELETE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
--> statement-breakpoint
CREATE TRIGGER waste_entries_append_only
  BEFORE UPDATE OR DELETE ON waste_entries
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
--> statement-breakpoint
CREATE TRIGGER opening_stock_entries_append_only
  BEFORE UPDATE OR DELETE ON opening_stock_entries
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
