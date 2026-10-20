CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"app_id" text NOT NULL,
	"orbit_id" text NOT NULL,
	"email" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"granted_scopes" text[] NOT NULL,
	"backfill" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider" CHECK ("accounts"."provider" in ('google')),
	CONSTRAINT "accounts_backfill_choice" CHECK ("accounts"."backfill" is null or "accounts"."backfill" in ('30_days', '1_year', 'all'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" in ('connect_account'))
);
--> statement-breakpoint
CREATE TABLE "oauth_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"owner_id" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_apps_provider" CHECK ("oauth_apps"."provider" in ('google'))
);
--> statement-breakpoint
CREATE TABLE "oauth_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"app_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"session_hash" text NOT NULL,
	"auth_generation" integer NOT NULL,
	"encrypted_verifier" text NOT NULL,
	"encrypted_code" text,
	"status" text DEFAULT 'started' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_attempt_provider" CHECK ("oauth_attempts"."provider" in ('google')),
	CONSTRAINT "oauth_attempt_status" CHECK ("oauth_attempts"."status" in ('started', 'returned', 'claimed', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_app_id_oauth_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."oauth_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_orbit_id_orbits_id_fk" FOREIGN KEY ("orbit_id") REFERENCES "public"."orbits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD CONSTRAINT "oauth_apps_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_attempts" ADD CONSTRAINT "oauth_attempts_app_id_oauth_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."oauth_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_email_unique" ON "accounts" USING btree ("provider",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_attempt_state_unique" ON "oauth_attempts" USING btree ("state_hash");