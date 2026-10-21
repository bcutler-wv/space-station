CREATE TABLE "mail_change_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"account_id" text NOT NULL,
	"orbit_id" text,
	"item_id" text NOT NULL,
	"external_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"action" text NOT NULL,
	"add_labels" text[] DEFAULT '{}' NOT NULL,
	"remove_labels" text[] DEFAULT '{}' NOT NULL,
	"item_revision" text,
	"item_sequence" integer NOT NULL,
	"credential_generation" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"confirmation" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"user_action_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mail_change_operations_action" CHECK ("mail_change_operations"."action" in ('archive', 'mark_read', 'mark_unread', 'add_label', 'remove_label')),
	CONSTRAINT "mail_change_operations_state" CHECK ("mail_change_operations"."state" in ('pending', 'in_flight', 'outcome_unknown', 'succeeded', 'failed')),
	CONSTRAINT "mail_change_operations_confirmation" CHECK ("mail_change_operations"."confirmation" is null or "mail_change_operations"."confirmation" in ('provider', 'observed')),
	CONSTRAINT "mail_change_operations_attempt" CHECK ("mail_change_operations"."attempt_count" >= 0 and "mail_change_operations"."attempt_count" <= 1)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action";--> statement-breakpoint
ALTER TABLE "mail_change_operations" ADD CONSTRAINT "mail_change_operations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_change_operations" ADD CONSTRAINT "mail_change_operations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_change_operations" ADD CONSTRAINT "mail_change_operations_orbit_id_orbits_id_fk" FOREIGN KEY ("orbit_id") REFERENCES "public"."orbits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_change_operations" ADD CONSTRAINT "mail_change_operations_item_id_account_id_items_id_account_id_fk" FOREIGN KEY ("item_id","account_id") REFERENCES "public"."items"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_change_operations_key_unique" ON "mail_change_operations" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "mail_change_operations_discovery_idx" ON "mail_change_operations" USING btree ("owner_id","account_id","user_action_at","id");--> statement-breakpoint
CREATE INDEX "mail_change_operations_item_idx" ON "mail_change_operations" USING btree ("item_id","item_sequence");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" in ('connect_account', 'reconnect_account', 'send_requested', 'send_succeeded', 'send_unknown', 'send_failed', 'send_reconciled', 'mail_change_requested', 'mail_change_confirmed', 'mail_change_observed', 'mail_change_unknown', 'mail_change_failed'));