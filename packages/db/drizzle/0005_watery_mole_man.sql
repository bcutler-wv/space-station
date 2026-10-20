CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"account_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"filename" text,
	"mime_type" text NOT NULL,
	"disposition" text,
	"content_id" text,
	"related" boolean DEFAULT false NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_intents" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"state_id" text NOT NULL,
	"page_id" text NOT NULL,
	"lease_generation" integer NOT NULL,
	"credential_generation" integer NOT NULL,
	"expected_sequence" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	CONSTRAINT "blob_intents_key_account_unique" UNIQUE("key","account_id"),
	CONSTRAINT "blob_intents_state" CHECK ("blob_intents"."state" in ('pending', 'referenced', 'delete_pending'))
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"person_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"normalized_value" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "identities_email_only" CHECK ("identities"."kind" = 'email')
);
--> statement-breakpoint
CREATE TABLE "item_labels" (
	"item_id" text NOT NULL,
	"account_id" text NOT NULL,
	"label_id" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "item_labels_item_id_label_id_source_pk" PRIMARY KEY("item_id","label_id","source"),
	CONSTRAINT "item_labels_source" CHECK ("item_labels"."source" in ('provider', 'rule', 'ai', 'user'))
);
--> statement-breakpoint
CREATE TABLE "item_orbits" (
	"item_id" text NOT NULL,
	"orbit_id" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "item_orbits_item_id_orbit_id_reason_pk" PRIMARY KEY("item_id","orbit_id","reason"),
	CONSTRAINT "item_orbits_reason" CHECK ("item_orbits"."reason" in ('account', 'rule', 'person', 'org'))
);
--> statement-breakpoint
CREATE TABLE "item_recipients" (
	"item_id" text NOT NULL,
	"account_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "item_recipients_item_id_identity_id_role_pk" PRIMARY KEY("item_id","identity_id","role"),
	CONSTRAINT "item_recipients_role" CHECK ("item_recipients"."role" in ('sender', 'reply_to', 'to', 'cc', 'bcc'))
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_revision" text,
	"applied_sequence" integer NOT NULL,
	"direction" text NOT NULL,
	"direction_provenance" text NOT NULL,
	"from_person_id" text,
	"sender_identities_complete" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"internal_at" timestamp with time zone,
	"subject" text,
	"snippet" text,
	"body_text" text,
	"body_html_path" text,
	"html_policy_version" integer,
	"image_metadata" jsonb,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parse_status" text NOT NULL,
	"parse_failure_code" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "items_direction" CHECK ("items"."direction" in ('in', 'out')),
	CONSTRAINT "items_direction_provenance" CHECK ("items"."direction_provenance" in ('incoming', 'provider_sent_account')),
	CONSTRAINT "items_parse_status" CHECK ("items"."parse_status" in ('supported', 'unsupported', 'deleted')),
	CONSTRAINT "items_parse_failure_code" CHECK ("items"."parse_failure_code" is null or "items"."parse_failure_code" in ('input_too_large', 'limit_exceeded', 'malformed'))
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_ref" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_id_account_unique" UNIQUE("id","account_id")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_id_account_unique" UNIQUE("id","account_id")
);
--> statement-breakpoint
CREATE TABLE "sync_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"state_id" text NOT NULL,
	"account_id" text NOT NULL,
	"page_id" text NOT NULL,
	"page_digest" text NOT NULL,
	"sequence" integer NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"resource" text NOT NULL,
	"collection_id" text NOT NULL,
	"cursor" jsonb,
	"generation" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_state_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "sync_state_resource_mail" CHECK ("sync_state"."resource" = 'mail')
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"external_id" text NOT NULL,
	"subject" text,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_id_scope_unique" UNIQUE("id","account_id","collection_id")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_item_id_account_id_items_id_account_id_fk" FOREIGN KEY ("item_id","account_id") REFERENCES "public"."items"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_storage_path_account_id_blob_intents_key_account_id_fk" FOREIGN KEY ("storage_path","account_id") REFERENCES "public"."blob_intents"("key","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_intents" ADD CONSTRAINT "blob_intents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_intents" ADD CONSTRAINT "blob_intents_state_id_sync_state_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."sync_state"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_intents" ADD CONSTRAINT "blob_intents_state_id_account_id_sync_state_id_account_id_fk" FOREIGN KEY ("state_id","account_id") REFERENCES "public"."sync_state"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_person_id_account_id_people_id_account_id_fk" FOREIGN KEY ("person_id","account_id") REFERENCES "public"."people"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_labels" ADD CONSTRAINT "item_labels_item_id_account_id_items_id_account_id_fk" FOREIGN KEY ("item_id","account_id") REFERENCES "public"."items"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_labels" ADD CONSTRAINT "item_labels_label_id_account_id_labels_id_account_id_fk" FOREIGN KEY ("label_id","account_id") REFERENCES "public"."labels"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_orbits" ADD CONSTRAINT "item_orbits_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_orbits" ADD CONSTRAINT "item_orbits_orbit_id_orbits_id_fk" FOREIGN KEY ("orbit_id") REFERENCES "public"."orbits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_recipients" ADD CONSTRAINT "item_recipients_item_id_account_id_items_id_account_id_fk" FOREIGN KEY ("item_id","account_id") REFERENCES "public"."items"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_recipients" ADD CONSTRAINT "item_recipients_identity_id_account_id_identities_id_account_id_fk" FOREIGN KEY ("identity_id","account_id") REFERENCES "public"."identities"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_thread_id_account_id_collection_id_threads_id_account_id_collection_id_fk" FOREIGN KEY ("thread_id","account_id","collection_id") REFERENCES "public"."threads"("id","account_id","collection_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_from_person_id_account_id_people_id_account_id_fk" FOREIGN KEY ("from_person_id","account_id") REFERENCES "public"."people"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_body_html_path_account_id_blob_intents_key_account_id_fk" FOREIGN KEY ("body_html_path","account_id") REFERENCES "public"."blob_intents"("key","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_pages" ADD CONSTRAINT "sync_pages_state_id_sync_state_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."sync_state"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_pages" ADD CONSTRAINT "sync_pages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_pages" ADD CONSTRAINT "sync_pages_state_id_account_id_sync_state_id_account_id_fk" FOREIGN KEY ("state_id","account_id") REFERENCES "public"."sync_state"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_item_ordinal_unique" ON "attachments" USING btree ("item_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_namespace_unique" ON "identities" USING btree ("account_id","provider","kind","normalized_value");--> statement-breakpoint
CREATE UNIQUE INDEX "items_source_unique" ON "items" USING btree ("account_id","collection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_provider_unique" ON "labels" USING btree ("account_id","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_pages_replay_unique" ON "sync_pages" USING btree ("state_id","page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_state_account_collection_unique" ON "sync_state" USING btree ("account_id","resource","collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_source_unique" ON "threads" USING btree ("account_id","collection_id","external_id");