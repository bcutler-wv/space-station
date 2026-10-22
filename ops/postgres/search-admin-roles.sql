-- Fixed owner-only policy: explicit provisioning only. The audit uses the same
-- read-only body as retained verification; psql includes are local operator files.
BEGIN;
SET LOCAL station.search_admin_rotation_target = 'none';
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '750ms';
\ir search-admin-roles-apply.sql
\ir search-admin-roles-audit.sql
COMMIT;
