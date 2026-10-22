CREATE TABLE "search_generation_dispatch" (
	"generation_token" text NOT NULL,
	"operation" text NOT NULL,
	"dispatch_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"target" text NOT NULL,
	"body_identity" text NOT NULL,
	"state" text DEFAULT 'armed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_generation_dispatch_generation_token_operation_pk" PRIMARY KEY("generation_token","operation"),
	CONSTRAINT "search_generation_dispatch_dispatch_id_unique" UNIQUE("dispatch_id"),
	CONSTRAINT "search_generation_dispatch_operation" CHECK ("search_generation_dispatch"."operation" in ('create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping')),
	CONSTRAINT "search_generation_dispatch_state" CHECK ("search_generation_dispatch"."state" in ('armed', 'sent_unknown', 'response_confirmed', 'quiesced')),
	CONSTRAINT "search_generation_dispatch_bounds" CHECK (length("search_generation_dispatch"."dispatch_id") between 1 and 128 and length("search_generation_dispatch"."owner_id") between 1 and 128 and length("search_generation_dispatch"."target") between 1 and 128 and length("search_generation_dispatch"."body_identity") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "search_generation_control" DROP CONSTRAINT "search_generation_stage";--> statement-breakpoint
ALTER TABLE "search_generation_history" DROP CONSTRAINT "search_generation_history_profile";--> statement-breakpoint
ALTER TABLE "search_generation_control" ADD COLUMN "source_generation_token" text;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD COLUMN "index_uuid" text;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD COLUMN "lifecycle" text DEFAULT 'reserved' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD COLUMN "writer_role" text;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD COLUMN "query_role" text;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD COLUMN "writer_principal" text;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD COLUMN "query_principal" text;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD COLUMN "writer_cert_fingerprint" text;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD COLUMN "query_cert_fingerprint" text;--> statement-breakpoint
-- P1 reservations have deterministic public names but no certificate or engine evidence.
UPDATE "search_generation_history" SET
  "writer_role" = 'station_indexer_' || lower(replace("generation_token", '-', '')),
  "query_role" = 'station_query_' || lower(replace("generation_token", '-', '')),
  "writer_principal" = 'station-search-indexer-' || lower(replace("generation_token", '-', '')),
  "query_principal" = 'station-search-query-' || lower(replace("generation_token", '-', ''))
WHERE "generation_token" <> 'legacy-v1';--> statement-breakpoint
ALTER TABLE "search_generation_dispatch" ADD CONSTRAINT "search_generation_dispatch_generation_token_search_generation_history_generation_token_fk" FOREIGN KEY ("generation_token") REFERENCES "public"."search_generation_history"("generation_token") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_generation_control" ADD CONSTRAINT "search_generation_control_source_generation_token_search_generation_history_generation_token_fk" FOREIGN KEY ("source_generation_token") REFERENCES "public"."search_generation_history"("generation_token") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_index_uuid_unique" UNIQUE("index_uuid");--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_writer_role_unique" UNIQUE("writer_role");--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_query_role_unique" UNIQUE("query_role");--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_writer_principal_unique" UNIQUE("writer_principal");--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_query_principal_unique" UNIQUE("query_principal");--> statement-breakpoint
ALTER TABLE "search_generation_control" ADD CONSTRAINT "search_generation_stage" CHECK ("search_generation_control"."stage" in ('disabled', 'disabled_intent', 'create_requested', 'uuid_bound', 'writer_role_requested', 'writer_role_attested', 'writer_mapping_requested', 'writer_attested', 'query_role_requested', 'query_role_attested', 'query_mapping_requested', 'roles_attested', 'unavailable'));--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_lifecycle" CHECK ("search_generation_history"."lifecycle" in ('reserved', 'bound', 'roles_attested', 'retired_retained', 'abandoned', 'unavailable'));--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_uuid" CHECK (("search_generation_history"."lifecycle" = 'reserved' and "search_generation_history"."index_uuid" is null) or ("search_generation_history"."lifecycle" in ('bound', 'roles_attested', 'retired_retained') and "search_generation_history"."index_uuid" is not null) or "search_generation_history"."lifecycle" in ('abandoned', 'unavailable'));--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_identity" CHECK (("search_generation_history"."generation_token" = 'legacy-v1' and "search_generation_history"."writer_role" is null and "search_generation_history"."query_role" is null and "search_generation_history"."writer_principal" is null and "search_generation_history"."query_principal" is null) or ("search_generation_history"."generation_token" <> 'legacy-v1' and "search_generation_history"."writer_role" is not null and "search_generation_history"."query_role" is not null and "search_generation_history"."writer_principal" is not null and "search_generation_history"."query_principal" is not null));--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_v2_token" CHECK ("search_generation_history"."generation_token" = 'legacy-v1' or "search_generation_history"."generation_token" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_names" CHECK ("search_generation_history"."generation_token" = 'legacy-v1' or ("search_generation_history"."writer_role" = 'station_indexer_' || lower(replace("search_generation_history"."generation_token", '-', '')) and "search_generation_history"."query_role" = 'station_query_' || lower(replace("search_generation_history"."generation_token", '-', '')) and "search_generation_history"."writer_principal" = 'station-search-indexer-' || lower(replace("search_generation_history"."generation_token", '-', '')) and "search_generation_history"."query_principal" = 'station-search-query-' || lower(replace("search_generation_history"."generation_token", '-', ''))));--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_fingerprints" CHECK (("search_generation_history"."writer_cert_fingerprint" is null or "search_generation_history"."writer_cert_fingerprint" ~ '^[0-9a-f]{64}$') and ("search_generation_history"."query_cert_fingerprint" is null or "search_generation_history"."query_cert_fingerprint" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_index_uuid_bound" CHECK ("search_generation_history"."index_uuid" is null or "search_generation_history"."index_uuid" ~ '^[A-Za-z0-9_-]{1,128}$');--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_attestation" CHECK ("search_generation_history"."generation_token" = 'legacy-v1' or "search_generation_history"."lifecycle" not in ('roles_attested', 'retired_retained') or ("search_generation_history"."writer_cert_fingerprint" is not null and "search_generation_history"."query_cert_fingerprint" is not null));--> statement-breakpoint
ALTER TABLE "search_generation_history" ADD CONSTRAINT "search_generation_history_profile" CHECK (("search_generation_history"."generation_token" = 'legacy-v1' and "search_generation_history"."physical_index" = 'station-mail-v1' and "search_generation_history"."profile_id" = 'station-mail-v1') or ("search_generation_history"."generation_token" <> 'legacy-v1' and "search_generation_history"."profile_id" = 'station-mail-v2' and "search_generation_history"."physical_index" ~ '^station-mail-v2-g[a-z0-9]{16,64}$'));
CREATE FUNCTION search_generation_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'generation history is permanent'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.generation_token = 'legacy-v1' THEN
      IF NEW.lifecycle <> 'roles_attested' OR NEW.index_uuid IS NULL OR
         NEW.writer_cert_fingerprint IS NOT NULL OR NEW.query_cert_fingerprint IS NOT NULL OR
         NOT EXISTS (SELECT 1 FROM search_generation_control WHERE singleton = 1 AND stage = 'disabled' AND source_generation_token IS NULL AND generation_token IS NULL) THEN
        RAISE EXCEPTION 'invalid initial legacy enrollment';
      END IF;
    ELSIF NEW.lifecycle <> 'reserved' OR NEW.index_uuid IS NOT NULL OR
          NEW.writer_cert_fingerprint IS NOT NULL OR NEW.query_cert_fingerprint IS NOT NULL THEN
      RAISE EXCEPTION 'generation must start reserved without evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.generation_token IS DISTINCT FROM OLD.generation_token OR NEW.physical_index IS DISTINCT FROM OLD.physical_index OR NEW.profile_id IS DISTINCT FROM OLD.profile_id OR NEW.writer_role IS DISTINCT FROM OLD.writer_role OR NEW.query_role IS DISTINCT FROM OLD.query_role OR NEW.writer_principal IS DISTINCT FROM OLD.writer_principal OR NEW.query_principal IS DISTINCT FROM OLD.query_principal THEN RAISE EXCEPTION 'generation identity is immutable'; END IF;
  IF OLD.index_uuid IS NOT NULL AND NEW.index_uuid IS DISTINCT FROM OLD.index_uuid THEN RAISE EXCEPTION 'generation uuid is immutable'; END IF;
  IF OLD.writer_cert_fingerprint IS NOT NULL AND NEW.writer_cert_fingerprint IS DISTINCT FROM OLD.writer_cert_fingerprint THEN RAISE EXCEPTION 'writer certificate evidence is immutable'; END IF;
  IF OLD.query_cert_fingerprint IS NOT NULL AND NEW.query_cert_fingerprint IS DISTINCT FROM OLD.query_cert_fingerprint THEN RAISE EXCEPTION 'query certificate evidence is immutable'; END IF;
  IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle AND NOT ((OLD.lifecycle = 'reserved' AND NEW.lifecycle IN ('bound','abandoned','unavailable')) OR (OLD.lifecycle = 'bound' AND NEW.lifecycle IN ('roles_attested','unavailable')) OR (OLD.lifecycle = 'roles_attested' AND NEW.lifecycle IN ('retired_retained','unavailable')) OR (OLD.lifecycle = 'retired_retained' AND NEW.lifecycle = 'unavailable')) THEN RAISE EXCEPTION 'invalid generation lifecycle transition'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER search_generation_history_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON search_generation_history FOR EACH ROW EXECUTE FUNCTION search_generation_history_guard();--> statement-breakpoint
CREATE FUNCTION search_generation_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate search_generation_history%ROWTYPE;
DECLARE control_stage text;
DECLARE control_token text;
DECLARE required_stage text;
DECLARE required_target text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'dispatch history is permanent'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'armed' THEN RAISE EXCEPTION 'dispatch must start armed'; END IF;
    SELECT stage, generation_token INTO control_stage, control_token FROM search_generation_control WHERE singleton = 1;
    required_stage := CASE NEW.operation WHEN 'create_index' THEN 'create_requested'
      WHEN 'writer_role' THEN 'writer_role_requested' WHEN 'writer_mapping' THEN 'writer_mapping_requested'
      WHEN 'query_role' THEN 'query_role_requested' WHEN 'query_mapping' THEN 'query_mapping_requested' END;
    SELECT * INTO candidate FROM search_generation_history WHERE generation_token = NEW.generation_token;
    required_target := CASE WHEN NEW.operation = 'create_index' THEN candidate.physical_index
      WHEN NEW.operation IN ('writer_role','writer_mapping') THEN candidate.writer_role
      ELSE candidate.query_role END;
    IF control_stage IS DISTINCT FROM required_stage OR control_token IS DISTINCT FROM NEW.generation_token OR
       candidate.generation_token IS NULL OR NEW.target IS DISTINCT FROM required_target THEN
      RAISE EXCEPTION 'dispatch candidate, request stage or target mismatch';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.generation_token IS DISTINCT FROM OLD.generation_token OR NEW.operation IS DISTINCT FROM OLD.operation OR NEW.dispatch_id IS DISTINCT FROM OLD.dispatch_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.target IS DISTINCT FROM OLD.target OR NEW.body_identity IS DISTINCT FROM OLD.body_identity THEN RAISE EXCEPTION 'dispatch identity is immutable'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state = 'armed' AND NEW.state = 'sent_unknown') OR (OLD.state = 'sent_unknown' AND NEW.state IN ('response_confirmed','quiesced'))) THEN RAISE EXCEPTION 'invalid dispatch transition'; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER search_generation_dispatch_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON search_generation_dispatch FOR EACH ROW EXECUTE FUNCTION search_generation_dispatch_guard();
--> statement-breakpoint
CREATE FUNCTION search_generation_control_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required_operation text;
DECLARE reservation_boundary boolean;
DECLARE clear_boundary boolean;
DECLARE legacy_boundary boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'generation control is permanent'; END IF;
  IF OLD.revision >= 2147483647 THEN RAISE EXCEPTION 'generation revision exhausted'; END IF;
  IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'generation revision must increment once'; END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    IF NOT ((OLD.stage = 'disabled' AND NEW.stage IN ('disabled_intent','unavailable')) OR
      (OLD.stage = 'disabled_intent' AND NEW.stage IN ('disabled','unavailable','create_requested')) OR
      (OLD.stage = 'create_requested' AND NEW.stage = 'uuid_bound') OR
      (OLD.stage = 'uuid_bound' AND NEW.stage = 'writer_role_requested') OR
      (OLD.stage = 'writer_role_requested' AND NEW.stage = 'writer_role_attested') OR
      (OLD.stage = 'writer_role_attested' AND NEW.stage = 'writer_mapping_requested') OR
      (OLD.stage = 'writer_mapping_requested' AND NEW.stage = 'writer_attested') OR
      (OLD.stage = 'writer_attested' AND NEW.stage = 'query_role_requested') OR
      (OLD.stage = 'query_role_requested' AND NEW.stage = 'query_role_attested') OR
      (OLD.stage = 'query_role_attested' AND NEW.stage = 'query_mapping_requested') OR
      (OLD.stage = 'query_mapping_requested' AND NEW.stage = 'roles_attested') OR
      (OLD.stage = 'roles_attested' AND NEW.stage IN ('disabled_intent','unavailable')) OR
      (OLD.stage = 'unavailable' AND NEW.stage IN ('disabled','disabled_intent'))) THEN
      RAISE EXCEPTION 'invalid generation control transition';
    END IF;
  END IF;
  reservation_boundary := OLD.stage IN ('disabled','roles_attested','disabled_intent','unavailable') AND NEW.stage = 'disabled_intent' AND
    NEW.transition_token IS NOT NULL AND NEW.generation_token IS NOT NULL AND
    NEW.index_uuid IS NULL AND NEW.profile_id = 'station-mail-v2' AND
    NEW.source_generation_token IS NOT DISTINCT FROM
      (CASE WHEN OLD.stage = 'roles_attested' THEN OLD.generation_token ELSE OLD.source_generation_token END) AND
    (OLD.stage IN ('disabled','roles_attested') OR
      (OLD.source_generation_token IS NULL AND NOT EXISTS
        (SELECT 1 FROM search_generation_dispatch WHERE generation_token = OLD.generation_token)));
  clear_boundary := OLD.stage IN ('disabled_intent','unavailable') AND NEW.stage = 'disabled' AND
    OLD.source_generation_token IS NULL AND NEW.source_generation_token IS NULL AND
    NEW.transition_token IS NULL AND NEW.generation_token IS NULL AND
    NEW.physical_index IS NULL AND NEW.profile_id IS NULL AND NEW.index_uuid IS NULL AND
    NOT EXISTS (SELECT 1 FROM search_generation_dispatch WHERE generation_token = OLD.generation_token);
  legacy_boundary := OLD.stage = 'disabled' AND NEW.stage = 'disabled' AND
    OLD.source_generation_token IS NULL AND NEW.source_generation_token = 'legacy-v1' AND
    OLD.generation_token IS NULL AND NEW.generation_token IS NULL AND
    OLD.transition_token IS NULL AND NEW.transition_token IS NULL AND
    NEW.physical_index IS NULL AND NEW.profile_id IS NULL AND NEW.index_uuid IS NULL AND
    EXISTS (SELECT 1 FROM search_generation_history WHERE generation_token = 'legacy-v1' AND lifecycle = 'roles_attested');
  IF NOT COALESCE(reservation_boundary, false) AND NOT COALESCE(clear_boundary, false) AND
     NOT COALESCE(legacy_boundary, false) THEN
    IF NEW.transition_token IS DISTINCT FROM OLD.transition_token OR
       NEW.source_generation_token IS DISTINCT FROM OLD.source_generation_token OR
       NEW.generation_token IS DISTINCT FROM OLD.generation_token OR
       NEW.physical_index IS DISTINCT FROM OLD.physical_index OR
       NEW.profile_id IS DISTINCT FROM OLD.profile_id OR
       (NEW.index_uuid IS DISTINCT FROM OLD.index_uuid AND NOT
         (OLD.stage = 'create_requested' AND NEW.stage = 'uuid_bound' AND OLD.index_uuid IS NULL AND NEW.index_uuid IS NOT NULL)) THEN
      RAISE EXCEPTION 'generation control identity cannot change here';
    END IF;
  END IF;
  IF NEW.generation_token IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM search_generation_history WHERE generation_token = NEW.generation_token AND
      physical_index = NEW.physical_index AND profile_id = NEW.profile_id AND
      index_uuid IS NOT DISTINCT FROM NEW.index_uuid AND
      ((NEW.index_uuid IS NULL AND lifecycle = 'reserved') OR
       (NEW.index_uuid IS NOT NULL AND lifecycle IN ('bound','roles_attested','retired_retained','unavailable')))) THEN
    RAISE EXCEPTION 'candidate history mismatch';
  END IF;
  IF NEW.source_generation_token IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM search_generation_history WHERE generation_token = NEW.source_generation_token AND
      lifecycle IN ('roles_attested','retired_retained','unavailable')) THEN
    RAISE EXCEPTION 'source history mismatch';
  END IF;
  IF NEW.stage NOT IN ('disabled','disabled_intent','unavailable') AND NEW.source_generation_token IS NULL THEN
    RAISE EXCEPTION 'generation source missing';
  END IF;
  IF NEW.stage IN ('uuid_bound','writer_role_requested','writer_role_attested','writer_mapping_requested','writer_attested','query_role_requested','query_role_attested','query_mapping_requested','roles_attested') AND NOT EXISTS
    (SELECT 1 FROM search_generation_history WHERE generation_token = NEW.generation_token AND physical_index = NEW.physical_index AND profile_id = NEW.profile_id AND index_uuid = NEW.index_uuid AND lifecycle IN ('bound','roles_attested')) THEN
    RAISE EXCEPTION 'bound candidate history mismatch';
  END IF;
  IF NEW.stage = 'roles_attested' AND NOT EXISTS
    (SELECT 1 FROM search_generation_history WHERE generation_token = NEW.generation_token AND lifecycle = 'roles_attested') THEN
    RAISE EXCEPTION 'attested candidate history missing';
  END IF;
  IF OLD.stage IN ('create_requested','writer_role_requested','writer_mapping_requested','query_role_requested','query_mapping_requested') AND NEW.stage IS DISTINCT FROM OLD.stage THEN
    required_operation := CASE OLD.stage WHEN 'create_requested' THEN 'create_index' WHEN 'writer_role_requested' THEN 'writer_role' WHEN 'writer_mapping_requested' THEN 'writer_mapping' WHEN 'query_role_requested' THEN 'query_role' ELSE 'query_mapping' END;
    IF NOT EXISTS (SELECT 1 FROM search_generation_dispatch WHERE generation_token = OLD.generation_token AND operation = required_operation AND state IN ('response_confirmed','quiesced')) THEN
      RAISE EXCEPTION 'generation dispatch unresolved';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER search_generation_control_guard_trigger BEFORE UPDATE OR DELETE ON search_generation_control FOR EACH ROW EXECUTE FUNCTION search_generation_control_guard();
