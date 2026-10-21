CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"account_id" text NOT NULL,
	"orbit_id" text,
	"thread_id" text,
	"thread_collection_id" text,
	"parent_item_id" text,
	"creation_key" text NOT NULL,
	"creation_digest" text NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"attachment_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'editing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_revision_positive" CHECK ("drafts"."revision" > 0),
	CONSTRAINT "drafts_state" CHECK ("drafts"."state" in ('editing', 'discarded'))
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "sender_header_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reply_to_header_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reply_to_identities_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "references_header" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_orbit_id_orbits_id_fk" FOREIGN KEY ("orbit_id") REFERENCES "public"."orbits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_account_id_thread_collection_id_threads_id_account_id_collection_id_fk" FOREIGN KEY ("thread_id","account_id","thread_collection_id") REFERENCES "public"."threads"("id","account_id","collection_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_parent_item_id_account_id_items_id_account_id_fk" FOREIGN KEY ("parent_item_id","account_id") REFERENCES "public"."items"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_creation_unique" ON "drafts" USING btree ("owner_id","creation_key");--> statement-breakpoint
CREATE INDEX "drafts_list_idx" ON "drafts" USING btree ("owner_id","account_id","updated_at","id");