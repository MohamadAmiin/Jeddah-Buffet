-- Invariant 3 IN THE DATABASE: a journal entry balances (Σdebit = Σcredit,
-- at least one debit line and at least one credit line), checked AT COMMIT
-- by a CONSTRAINT TRIGGER that is DEFERRABLE INITIALLY DEFERRED — spec 3:
-- "a constraint checked at commit, not only application code". Deferred,
-- because the writer inserts the entry and then its lines one by one; an
-- immediate trigger would reject the first line of every entry.
--
-- Invariant 2 IN THE DATABASE: journal_entries, journal_entry_lines,
-- invoices and payments are append-only. NOT orders (status is updated
-- once, open → paid, inside the payment transaction — spec 13's own step),
-- NOT pos_sessions (closed once by closeSession), NOT pos_sync_ops (a sync
-- log the owner's retry/dismiss updates).
--
-- Created with `drizzle-kit generate --custom`, the only form that
-- registers the file in migrations/meta/_journal.json — a .sql file dropped
-- into this folder by hand is silently never applied, and here that failure
-- is the dangerous kind: you would believe the ledger rejects an unbalanced
-- entry while the database has no such trigger.

CREATE OR REPLACE FUNCTION journal_entry_balanced() RETURNS trigger AS $$
DECLARE
  the_entry_id uuid := coalesce(NEW.entry_id, OLD.entry_id);
  debits bigint;
  credits bigint;
  debit_lines bigint;
  credit_lines bigint;
BEGIN
  SELECT coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0),
         count(*) FILTER (WHERE debit_minor > 0), count(*) FILTER (WHERE credit_minor > 0)
    INTO debits, credits, debit_lines, credit_lines
    FROM journal_entry_lines
   WHERE entry_id = the_entry_id;
  IF debits <> credits OR debit_lines = 0 OR credit_lines = 0 THEN
    RAISE EXCEPTION 'journal entry % is not balanced: debits % credits %, debit lines %, credit lines %',
      the_entry_id, debits, credits, debit_lines, credit_lines;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entry_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();
--> statement-breakpoint
-- An entry header with no lines would pass the line trigger (it never
-- fires), so the header table gets its own deferred check: an entry must
-- have at least one line by COMMIT.
CREATE OR REPLACE FUNCTION journal_entry_has_lines() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entry_lines WHERE entry_id = NEW.id) THEN
    RAISE EXCEPTION 'journal entry % has no lines', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_have_lines
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_has_lines();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION posted_record_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING HINT = 'Correct a mistake with a reversing record, never by changing a posted one';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
--> statement-breakpoint
CREATE TRIGGER journal_entry_lines_append_only
  BEFORE UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
--> statement-breakpoint
CREATE TRIGGER invoices_append_only
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
--> statement-breakpoint
CREATE TRIGGER payments_append_only
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION posted_record_append_only();
--> statement-breakpoint
-- The spec 23 chart, verbatim, for every restaurant that exists BEFORE
-- ensureChart (T-12) becomes a restaurant initializer. Idempotent:
-- ON CONFLICT on accounts_restaurant_code_unique. The en dash in the two
-- clearing names is the spec's own character. All 23 accounts are seeded
-- (Assumption 5), deviating from spec 23's "only the payment methods the
-- restaurant accepts are created" — recorded in CLAUDE.md by T-02.
INSERT INTO accounts (restaurant_id, code, name, type)
SELECT r.id, c.code, c.name, c.type
FROM restaurants r
CROSS JOIN (VALUES
  ('1000', 'Cash on Hand', 'asset'),
  ('1010', 'Bank', 'asset'),
  ('1020', 'Payment Clearing – Card', 'asset'),
  ('1030', 'Payment Clearing – Mobile Money', 'asset'),
  ('1200', 'Inventory', 'asset'),
  ('2000', 'Accounts Payable', 'liability'),
  ('2100', 'Tax Payable', 'liability'),
  ('3000', 'Owner''s Capital', 'equity'),
  ('3100', 'Owner''s Drawings', 'equity'),
  ('3900', 'Retained Earnings', 'equity'),
  ('4000', 'Sales Revenue', 'revenue'),
  ('4100', 'Sales Discounts', 'revenue'),
  ('4200', 'Sales Refunds', 'revenue'),
  ('5000', 'Cost of Goods Sold', 'cost_of_sales'),
  ('5100', 'Waste & Inventory Adjustments', 'cost_of_sales'),
  ('5200', 'Comps & Staff Meals', 'cost_of_sales'),
  ('6000', 'Rent Expense', 'expense'),
  ('6100', 'Salary Expense', 'expense'),
  ('6200', 'Utilities Expense', 'expense'),
  ('6300', 'Maintenance Expense', 'expense'),
  ('6400', 'Payment Processing Fees', 'expense'),
  ('6800', 'Cash Over/Short', 'expense'),
  ('6900', 'Other Expenses', 'expense')
) AS c(code, name, type)
ON CONFLICT (restaurant_id, code) DO NOTHING;

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
