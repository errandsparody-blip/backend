-- =============================================================================
-- audit_log_entries — append-only enforcement at the DB level.
-- Prevents UPDATE / DELETE on audit_log_entries by any user / role, including
-- the application role. Corrections are made by appending a new entry.
-- Implementation Plan §4.7.
-- =============================================================================

-- 1) Trigger that rejects UPDATE.
CREATE OR REPLACE FUNCTION audit_log_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_entries is append-only; UPDATE is forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log_entries;
CREATE TRIGGER trg_audit_log_no_update
BEFORE UPDATE ON audit_log_entries
FOR EACH ROW EXECUTE FUNCTION audit_log_no_update();

-- 2) Trigger that rejects DELETE.
CREATE OR REPLACE FUNCTION audit_log_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_entries is append-only; DELETE is forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log_entries;
CREATE TRIGGER trg_audit_log_no_delete
BEFORE DELETE ON audit_log_entries
FOR EACH ROW EXECUTE FUNCTION audit_log_no_delete();

-- 3) Optional: revoke UPDATE / DELETE privileges from the application role.
-- Replace `usaerrands_app` with the actual production app role and run as a
-- superuser-level migration. Triggers above are the portable belt-and-braces.
-- REVOKE UPDATE, DELETE, TRUNCATE ON audit_log_entries FROM usaerrands_app;
