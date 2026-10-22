-- Retained verification only: no role, grant or password mutation.
BEGIN READ ONLY;
SET LOCAL station.search_admin_rotation_target = 'none';
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '750ms';
\ir search-admin-roles-audit.sql
COMMIT;
