CREATE INDEX "item_labels_reader_label_item_idx" ON "item_labels" USING btree ("label_id","item_id");--> statement-breakpoint
CREATE INDEX "item_orbits_reader_orbit_item_idx" ON "item_orbits" USING btree ("orbit_id","item_id");--> statement-breakpoint
CREATE INDEX "items_reader_account_thread_live_idx" ON "items" USING btree ("account_id","thread_id","deleted_at","internal_at","id");