CREATE TABLE "search_generation_control" (
	"singleton" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"stage" text DEFAULT 'disabled' NOT NULL,
	"transition_token" text,
	"generation_token" text,
	"physical_index" text,
	"index_uuid" text,
	"profile_id" text,
	"publication_enabled" boolean DEFAULT false NOT NULL,
	"serving_ready" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_generation_singleton" CHECK ("search_generation_control"."singleton" = 1),
	CONSTRAINT "search_generation_revision_positive" CHECK ("search_generation_control"."revision" > 0),
	CONSTRAINT "search_generation_disabled_p1" CHECK ("search_generation_control"."publication_enabled" = false and "search_generation_control"."serving_ready" = false),
	CONSTRAINT "search_generation_stage" CHECK ("search_generation_control"."stage" in ('disabled', 'disabled_intent', 'unavailable')),
	CONSTRAINT "search_generation_identity_pair" CHECK (("search_generation_control"."generation_token" is null and "search_generation_control"."physical_index" is null and "search_generation_control"."profile_id" is null and "search_generation_control"."index_uuid" is null) or
    ("search_generation_control"."generation_token" is not null and "search_generation_control"."physical_index" is not null and "search_generation_control"."profile_id" is not null and "search_generation_control"."profile_id" = 'station-mail-v2')),
	CONSTRAINT "search_generation_intent_bound" CHECK ("search_generation_control"."stage" <> 'disabled_intent' or
    ("search_generation_control"."transition_token" is not null and "search_generation_control"."generation_token" is not null and "search_generation_control"."physical_index" is not null)),
	CONSTRAINT "search_generation_identity_bounds" CHECK (("search_generation_control"."transition_token" is null or length("search_generation_control"."transition_token") between 1 and 128) and
    ("search_generation_control"."generation_token" is null or length("search_generation_control"."generation_token") between 1 and 128) and
    ("search_generation_control"."physical_index" is null or length("search_generation_control"."physical_index") between 1 and 128) and
    ("search_generation_control"."index_uuid" is null or length("search_generation_control"."index_uuid") between 1 and 128))
);
--> statement-breakpoint
CREATE TABLE "search_generation_history" (
	"generation_token" text PRIMARY KEY NOT NULL,
	"physical_index" text NOT NULL,
	"profile_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_generation_history_physical_index_unique" UNIQUE("physical_index"),
	CONSTRAINT "search_generation_history_profile" CHECK ("search_generation_history"."profile_id" = 'station-mail-v2'),
	CONSTRAINT "search_generation_history_bounds" CHECK (length("search_generation_history"."generation_token") between 1 and 128 and length("search_generation_history"."physical_index") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "acknowledged_generation_token" text;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "acknowledged_disposition" text;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_ack_complete" CHECK (("search_documents"."acknowledged_revision" is null and "search_documents"."acknowledged_global_epoch" is null and "search_documents"."acknowledged_account_epoch" is null and "search_documents"."acknowledged_generation_token" is null and "search_documents"."acknowledged_disposition" is null) or
    ("search_documents"."acknowledged_revision" is not null and "search_documents"."acknowledged_global_epoch" is not null and "search_documents"."acknowledged_global_epoch" > 0 and
      "search_documents"."acknowledged_account_epoch" is not null and "search_documents"."acknowledged_account_epoch" > 0 and "search_documents"."acknowledged_generation_token" is not null and
      "search_documents"."acknowledged_disposition" is not null and "search_documents"."acknowledged_disposition" in ('live', 'fence')));--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_ack_token_bound" CHECK ("search_documents"."acknowledged_generation_token" is null or length("search_documents"."acknowledged_generation_token") between 1 and 128);--> statement-breakpoint
INSERT INTO "search_generation_control" DEFAULT VALUES;
