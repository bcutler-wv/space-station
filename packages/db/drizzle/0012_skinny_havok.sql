CREATE TABLE "outbound_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"account_id" text NOT NULL,
	"orbit_id" text,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"draft_revision" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"blob_key" text NOT NULL,
	"blob_ready" boolean DEFAULT false NOT NULL,
	"attachment_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blob_collected_at" timestamp with time zone,
	"mime_digest" text,
	"mime_bytes" integer,
	"message_id" text NOT NULL,
	"from_address" text NOT NULL,
	"recipient_addresses" jsonb NOT NULL,
	"provider_thread_id" text,
	"provider_result_id" text,
	"credential_generation" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"user_action_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_operations_blob_key_unique" UNIQUE("blob_key"),
	CONSTRAINT "outbound_operations_state" CHECK ("outbound_operations"."state" in ('pending', 'in_flight', 'succeeded', 'failed', 'outcome_unknown')),
	CONSTRAINT "outbound_operations_attempt" CHECK ("outbound_operations"."attempt_count" >= 0 and "outbound_operations"."attempt_count" <= 1),
	CONSTRAINT "outbound_operations_mime_size" CHECK ("outbound_operations"."mime_bytes" is null or ("outbound_operations"."mime_bytes" >= 0 and "outbound_operations"."mime_bytes" <= 12582912))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action";--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_state";--> statement-breakpoint
ALTER TABLE "outbound_operations" ADD CONSTRAINT "outbound_operations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_operations" ADD CONSTRAINT "outbound_operations_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_operations" ADD CONSTRAINT "outbound_operations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_operations" ADD CONSTRAINT "outbound_operations_orbit_id_orbits_id_fk" FOREIGN KEY ("orbit_id") REFERENCES "public"."orbits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_operations_key_unique" ON "outbound_operations" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_operations_state_idx" ON "outbound_operations" USING btree ("state","updated_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" in ('connect_account', 'reconnect_account', 'send_requested', 'send_succeeded', 'send_unknown', 'send_failed', 'send_reconciled'));--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_state" CHECK ("drafts"."state" in ('editing', 'discarded', 'sending', 'sent'));