CREATE TABLE "mail_image_consent" (
	"item_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"source_digest" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_sender_image_preferences" (
	"account_id" text NOT NULL,
	"sender_address" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_sender_image_preferences_account_id_sender_address_pk" PRIMARY KEY("account_id","sender_address")
);
--> statement-breakpoint
ALTER TABLE "mail_image_consent" ADD CONSTRAINT "mail_image_consent_item_id_account_id_items_id_account_id_fk" FOREIGN KEY ("item_id","account_id") REFERENCES "public"."items"("id","account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sender_image_preferences" ADD CONSTRAINT "mail_sender_image_preferences_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;