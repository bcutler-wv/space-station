-- Retained verification only: no role, grant or password mutation.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '750ms';
\ir search-admin-roles-audit.sql
COMMIT;
