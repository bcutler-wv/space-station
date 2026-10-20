CREATE TABLE "exclusion_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"orbit_id" text,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"effect" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exclusion_rules_kind" CHECK ("exclusion_rules"."kind" in ('account', 'sender', 'label')),
	CONSTRAINT "exclusion_rules_effect" CHECK ("exclusion_rules"."effect" in ('no_ai', 'no_index', 'no_ai_and_no_index'))
);
--> statement-breakpoint
CREATE TABLE "orbits" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color_slot" integer NOT NULL,
	"context" text NOT NULL,
	"privacy_defaults" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orbits_color_slot_range" CHECK ("orbits"."color_slot" between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "exclusion_rules" ADD CONSTRAINT "exclusion_rules_orbit_id_orbits_id_fk" FOREIGN KEY ("orbit_id") REFERENCES "public"."orbits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exclusion_rules_unique" ON "exclusion_rules" USING btree (coalesce("orbit_id", ''),"kind","value","effect");--> statement-breakpoint
CREATE UNIQUE INDEX "orbits_slug_unique" ON "orbits" USING btree ("slug");