-- Owner-only, post-migration policy. Run on the Station database with ON_ERROR_STOP.
-- No password, LOGIN, or engine operation is performed here.
BEGIN;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '750ms';

DO $policy$
DECLARE name text; role_row pg_authid%ROWTYPE; role_oid oid;
BEGIN
  IF current_database() <> 'station' OR
     (SELECT datdba FROM pg_database WHERE datname = current_database()) <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
  THEN RAISE EXCEPTION 'search admin role policy requires Station database owner'; END IF;
  FOR name IN SELECT unnest(ARRAY['station_search_verifier', 'station_search_transition']) LOOP
    SELECT * INTO role_row FROM pg_authid WHERE rolname = name;
    IF NOT FOUND THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 2 PASSWORD NULL', name);
      SELECT * INTO role_row FROM pg_authid WHERE rolname = name;
    END IF;
    role_oid := role_row.oid;
    IF role_row.rolsuper OR role_row.rolcreatedb OR role_row.rolcreaterole OR role_row.rolreplication OR
       role_row.rolbypassrls OR role_row.rolinherit OR role_row.rolconnlimit <> 2 OR
       role_row.rolvaliduntil IS NOT NULL OR
       (role_row.rolcanlogin AND (role_row.rolpassword IS NULL OR role_row.rolpassword NOT LIKE 'SCRAM-SHA-256$%')) OR
       (NOT role_row.rolcanlogin AND role_row.rolpassword IS NOT NULL) OR
       EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = role_oid OR member = role_oid) OR
       EXISTS (SELECT 1 FROM pg_shdepend WHERE refobjid = role_oid AND deptype = 'o')
    THEN RAISE EXCEPTION 'unsafe preexisting search admin role: %', name; END IF;
  END LOOP;
END $policy$;

-- PostgreSQL's PUBLIC TEMP and legacy PUBLIC schema CREATE are additive grants.
-- REVOKE from an individual role cannot negate them. Keep CONNECT for existing
-- app/worker clients; these roles get their own explicit CONNECT below.
DO $policy$ BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $policy$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE station TO station_search_verifier, station_search_transition;
GRANT USAGE ON SCHEMA public TO station_search_verifier, station_search_transition;
GRANT SELECT ON search_generation_control, search_generation_history, search_generation_dispatch
  TO station_search_verifier, station_search_transition;
GRANT UPDATE (revision, stage, transition_token, source_generation_token, generation_token,
  physical_index, index_uuid, profile_id, updated_at) ON search_generation_control
  TO station_search_transition;
GRANT INSERT (generation_token, physical_index, profile_id, index_uuid, lifecycle,
  writer_role, query_role, writer_principal, query_principal, writer_cert_fingerprint,
  query_cert_fingerprint) ON search_generation_history TO station_search_transition;
GRANT UPDATE (index_uuid, lifecycle, writer_cert_fingerprint, query_cert_fingerprint)
  ON search_generation_history TO station_search_transition;
GRANT INSERT (generation_token, operation, dispatch_id, owner_id, target, body_identity, state)
  ON search_generation_dispatch TO station_search_transition;
GRANT UPDATE (state) ON search_generation_dispatch TO station_search_transition;

DO $audit$
DECLARE name text; rel record; col record; ns record;
DECLARE allowed_insert boolean; allowed_update boolean; role_oid oid;
BEGIN
  FOR name IN SELECT unnest(ARRAY['station_search_verifier', 'station_search_transition']) LOOP
    SELECT oid INTO role_oid FROM pg_roles WHERE rolname = name;
    IF NOT has_database_privilege(name, current_database(), 'CONNECT') OR
       has_database_privilege(name, current_database(), 'CREATE') OR
       has_database_privilege(name, current_database(), 'TEMP') OR
       NOT has_schema_privilege(name, 'public', 'USAGE') OR
       has_schema_privilege(name, 'public', 'CREATE')
    THEN RAISE EXCEPTION 'unsafe search admin database/schema grants: %', name; END IF;
    FOR ns IN SELECT oid, nspname FROM pg_namespace
      WHERE nspname <> 'public' AND nspname <> 'information_schema' AND nspname !~ '^pg_'
    LOOP
      IF has_schema_privilege(name, ns.oid, 'USAGE') OR has_schema_privilege(name, ns.oid, 'CREATE')
      THEN RAISE EXCEPTION 'unexpected search admin schema access: %', name; END IF;
    END LOOP;
    -- PUBLIC or per-column grants on credential catalogs can bypass the
    -- ordinary source-table audit. pg_roles remains available as masked metadata.
    FOR rel IN SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pg_catalog' AND c.relname = ANY(ARRAY[
        'pg_authid', 'pg_shadow', 'pg_subscription', 'pg_user_mapping'])
    LOOP
      IF has_table_privilege(name, rel.oid, 'SELECT')
      THEN RAISE EXCEPTION 'search admin credential catalog access: %.%', name, rel.relname; END IF;
      FOR col IN SELECT attname FROM pg_attribute
        WHERE attrelid = rel.oid AND attnum > 0 AND NOT attisdropped AND
          (rel.relname = 'pg_authid' AND attname = 'rolpassword' OR
           rel.relname = 'pg_shadow' AND attname = 'passwd' OR
           rel.relname = 'pg_subscription' AND attname = 'subconninfo' OR
           rel.relname = 'pg_user_mapping' AND attname = 'umoptions')
      LOOP
        IF has_column_privilege(name, rel.oid, col.attname, 'SELECT')
        THEN RAISE EXCEPTION 'search admin credential catalog column access: %.%.%',
          name, rel.relname, col.attname; END IF;
      END LOOP;
    END LOOP;
    FOR rel IN SELECT c.oid, c.relname, c.relkind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
    LOOP
      IF rel.relkind = 'S' THEN
        IF has_sequence_privilege(name, rel.oid, 'USAGE') OR
           has_sequence_privilege(name, rel.oid, 'SELECT') OR
           has_sequence_privilege(name, rel.oid, 'UPDATE')
        THEN RAISE EXCEPTION 'unexpected search admin sequence access: %', name; END IF;
      ELSIF rel.relkind IN ('r', 'p', 'v', 'm', 'f') THEN
        IF has_table_privilege(name, rel.oid, 'DELETE') OR
           has_table_privilege(name, rel.oid, 'TRUNCATE') OR
           has_table_privilege(name, rel.oid, 'REFERENCES') OR
           has_table_privilege(name, rel.oid, 'TRIGGER')
        THEN RAISE EXCEPTION 'unexpected search admin table authority: %', name; END IF;
        IF rel.relname IN ('search_generation_control', 'search_generation_history', 'search_generation_dispatch') THEN
          IF NOT has_table_privilege(name, rel.oid, 'SELECT')
          THEN RAISE EXCEPTION 'missing search admin registry read: %', name; END IF;
        ELSIF has_table_privilege(name, rel.oid, 'SELECT') OR
              has_table_privilege(name, rel.oid, 'INSERT') OR
              has_table_privilege(name, rel.oid, 'UPDATE')
        THEN RAISE EXCEPTION 'unexpected search admin source access: %', name; END IF;
        FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = rel.oid AND attnum > 0 AND NOT attisdropped LOOP
          allowed_insert := name = 'station_search_transition' AND (
            rel.relname = 'search_generation_history' AND col.attname = ANY(ARRAY[
              'generation_token','physical_index','profile_id','index_uuid','lifecycle','writer_role','query_role',
              'writer_principal','query_principal','writer_cert_fingerprint','query_cert_fingerprint']) OR
            rel.relname = 'search_generation_dispatch' AND col.attname = ANY(ARRAY[
              'generation_token','operation','dispatch_id','owner_id','target','body_identity','state']));
          allowed_update := name = 'station_search_transition' AND (
            rel.relname = 'search_generation_control' AND col.attname = ANY(ARRAY[
              'revision','stage','transition_token','source_generation_token','generation_token',
              'physical_index','index_uuid','profile_id','updated_at']) OR
            rel.relname = 'search_generation_history' AND col.attname = ANY(ARRAY[
              'index_uuid','lifecycle','writer_cert_fingerprint','query_cert_fingerprint']) OR
            rel.relname = 'search_generation_dispatch' AND col.attname = 'state');
          IF has_column_privilege(name, rel.oid, col.attname, 'INSERT') <> allowed_insert OR
             has_column_privilege(name, rel.oid, col.attname, 'UPDATE') <> allowed_update OR
             has_column_privilege(name, rel.oid, col.attname, 'REFERENCES') OR
             (rel.relname NOT IN ('search_generation_control', 'search_generation_history', 'search_generation_dispatch') AND
               has_column_privilege(name, rel.oid, col.attname, 'SELECT'))
          THEN RAISE EXCEPTION 'unexpected search admin column authority: %.%.%', name, rel.relname, col.attname; END IF;
        END LOOP;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege(name, p.oid, 'EXECUTE'))
    THEN RAISE EXCEPTION 'search admin may execute a custom security-definer routine: %', name; END IF;
    IF EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclobjtype IN ('r', 'S') AND a.grantee IN (0, role_oid))
    THEN RAISE EXCEPTION 'search admin future-object default grants are forbidden: %', name; END IF;
    IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE a.grantee = role_oid AND a.is_grantable) OR
       EXISTS (SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
         WHERE x.grantee = role_oid AND x.is_grantable) OR
       EXISTS (SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) x
         WHERE x.grantee = role_oid AND x.is_grantable) OR
       EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) x
         WHERE x.grantee = role_oid AND x.is_grantable)
    THEN RAISE EXCEPTION 'search admin grant option is forbidden: %', name; END IF;
  END LOOP;
END $audit$;
COMMIT;
