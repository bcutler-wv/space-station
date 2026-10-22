-- Fixed owner-only role creation and exact grants. Used only by explicit create/abort.
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

