CREATE TABLE "event_clock" (
	"id" integer PRIMARY KEY NOT NULL,
	"next_id" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "event_clock_singleton" CHECK ("event_clock"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sync_events" (
	"id" bigint PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_events_kind" CHECK ("sync_events"."kind" in ('sync-progress', 'mail-changed'))
);
