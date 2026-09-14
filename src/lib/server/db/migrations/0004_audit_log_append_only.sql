-- Make audit_log append-only IN THE DATABASE, not merely in application code.
--
-- Invariant 2: posted records are permanent — never UPDATE, never DELETE, "not in
-- app code, not in a repair script, not in a migration". Invariant 10 requires
-- sensitive actions to be audit-logged. An audit log that application code can
-- rewrite is not an audit log; the guarantee has to live where no caller can get
-- around it. Correct a mistake with a NEW audit row, never by changing one.
--
-- This migration was created with `drizzle-kit generate --custom`, which is the
-- only form that registers it in migrations/meta/_journal.json. A .sql file
-- dropped into this folder by hand is silently never applied — and here that
-- failure mode is the worst kind: you would believe the audit log is tamper-proof
-- while the database has no such trigger, and any test asserting "the database
-- rejects an update" would fail for the right reason only by accident.

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % on row is not permitted', TG_OP
    USING HINT = 'Correct a mistake with a new audit row, never by changing an existing one.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- The trigger covers UPDATE and DELETE and deliberately NOT TRUNCATE. Three
-- reasons, all of which have to hold together:
--
--   1. TRUNCATE fires only STATEMENT-level triggers, so this row-level trigger
--      would not catch it anyway.
--   2. The integration harness (T-08) resets the test database by truncating, and
--      a BEFORE TRUNCATE trigger would make every test run after the first fail.
--   3. Production is protected by PRIVILEGE instead: TRUNCATE requires the
--      TRUNCATE privilege, which only the owner holds, and T-02 deliberately did
--      not grant it to matcami_app. The application therefore cannot truncate the
--      audit log even though this trigger does not mention TRUNCATE.
--      Verified: as matcami_app, `truncate audit_log` -> permission denied.
