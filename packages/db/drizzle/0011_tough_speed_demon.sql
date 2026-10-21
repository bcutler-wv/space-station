CREATE TABLE "draft_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"account_id" text NOT NULL,
	"blob_key" text NOT NULL,
	"upload_key" text NOT NULL,
	"digest" text NOT NULL,
	"filename" text NOT NULL,
	"byte_size" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_attachments_blob_key_unique" UNIQUE("blob_key"),
	CONSTRAINT "draft_attachments_state" CHECK ("draft_attachments"."state" in ('pending', 'ready', 'delete_pending')),
	CONSTRAINT "draft_attachments_size" CHECK ("draft_attachments"."byte_size" >= 0 and "draft_attachments"."byte_size" <= 8388608)
);
--> statement-breakpoint
ALTER TABLE "draft_attachments" ADD CONSTRAINT "draft_attachments_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_attachments" ADD CONSTRAINT "draft_attachments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_attachments_upload_unique" ON "draft_attachments" USING btree ("draft_id","upload_key");--> statement-breakpoint
CREATE INDEX "draft_attachments_collect_idx" ON "draft_attachments" USING btree ("state","updated_at");