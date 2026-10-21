ALTER TABLE "items" ADD COLUMN "action_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "observed_action_epoch" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "observed_credential_generation" integer;--> statement-breakpoint
CREATE INDEX "items_observation_refresh_idx" ON "items" USING btree ("account_id","collection_id","id") WHERE "items"."deleted_at" is null and "items"."parse_status" = 'supported';--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_action_epoch" CHECK ("items"."action_epoch" >= 0 and ("items"."observed_action_epoch" is null or ("items"."observed_action_epoch" >= 0 and "items"."observed_action_epoch" <= "items"."action_epoch")));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_observation_pair" CHECK (("items"."observed_action_epoch" is null) = ("items"."observed_credential_generation" is null));