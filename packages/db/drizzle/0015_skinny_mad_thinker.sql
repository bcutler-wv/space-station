ALTER TABLE "accounts" ADD COLUMN "authorization_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "observed_authorization_generation" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_authorization_generation_positive" CHECK ("accounts"."authorization_generation" > 0);--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_authorization_observation" CHECK ("items"."observed_authorization_generation" is null or
    ("items"."observed_action_epoch" is not null and "items"."observed_credential_generation" is not null));