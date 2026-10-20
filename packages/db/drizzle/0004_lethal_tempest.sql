ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "credential_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "credential_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_attempts" ADD COLUMN "reconnect_account_id" text;--> statement-breakpoint
ALTER TABLE "oauth_attempts" ADD CONSTRAINT "oauth_attempts_reconnect_account_id_accounts_id_fk" FOREIGN KEY ("reconnect_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" in ('connect_account', 'reconnect_account'));