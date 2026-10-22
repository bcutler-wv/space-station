CREATE TABLE "search_documents" (
	"account_id" text NOT NULL,
	"item_id" text NOT NULL,
	"document_id" text NOT NULL,
	"desired_revision" integer DEFAULT 1 NOT NULL,
	"desired_state" text DEFAULT 'dirty' NOT NULL,
	"global_epoch" integer DEFAULT 0 NOT NULL,
	"account_epoch" integer DEFAULT 0 NOT NULL,
	"source_sequence" integer,
	"action_epoch" integer,
	"observed_action_epoch" integer,
	"observed_authorization_generation" integer,
	"authorization_generation" integer,
	"source_parse_status" text,
	"source_deleted" boolean,
	"acknowledged_revision" integer,
	"acknowledged_global_epoch" integer,
	"acknowledged_account_epoch" integer,
	"claim_token" text,
	"claim_until" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "search_documents_account_id_item_id_pk" PRIMARY KEY("account_id","item_id"),
	CONSTRAINT "search_documents_revision_positive" CHECK ("search_documents"."desired_revision" > 0 and ("search_documents"."acknowledged_revision" is null or "search_documents"."acknowledged_revision" > 0 and "search_documents"."acknowledged_revision" <= "search_documents"."desired_revision")),
	CONSTRAINT "search_documents_state" CHECK ("search_documents"."desired_state" in ('dirty', 'eligible', 'purge')),
	CONSTRAINT "search_documents_retry_nonnegative" CHECK ("search_documents"."retry_count" >= 0),
	CONSTRAINT "search_documents_operational_bounds" CHECK (length("search_documents"."account_id") <= 64 and length("search_documents"."item_id") <= 64 and length("search_documents"."document_id") <= 128 and ("search_documents"."error_code" is null or length("search_documents"."error_code") <= 32) and ("search_documents"."claim_token" is null or length("search_documents"."claim_token") <= 128))
);
--> statement-breakpoint
CREATE TABLE "search_epochs" (
	"scope" text PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"sweep_target" integer DEFAULT 1 NOT NULL,
	"sweep_target_global" integer DEFAULT 1 NOT NULL,
	"sweep_cursor_account" text,
	"sweep_cursor_item" text,
	"sweep_finished_epoch" integer DEFAULT 0 NOT NULL,
	"sweep_finished_global" integer DEFAULT 0 NOT NULL,
	"physical_profile" text,
	CONSTRAINT "search_epochs_positive" CHECK ("search_epochs"."epoch" > 0 and "search_epochs"."sweep_target" > 0 and "search_epochs"."sweep_target_global" > 0 and "search_epochs"."sweep_finished_epoch" >= 0 and "search_epochs"."sweep_finished_global" >= 0),
	CONSTRAINT "search_epochs_cursor_pair" CHECK (("search_epochs"."sweep_cursor_account" is null) = ("search_epochs"."sweep_cursor_item" is null)),
	CONSTRAINT "search_epochs_scope_bound" CHECK (length("search_epochs"."scope") <= 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_document_id_unique" ON "search_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "search_documents_dirty_idx" ON "search_documents" USING btree ("desired_state","account_id","item_id");--> statement-breakpoint
CREATE INDEX "items_search_reconcile_idx" ON "items" USING btree ("account_id","id");