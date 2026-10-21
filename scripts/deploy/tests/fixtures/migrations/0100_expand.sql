-- Synthetic fixture: an expand-only migration (new table, new column, new index).
CREATE TABLE `shelf` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL);--> statement-breakpoint
ALTER TABLE `item` ADD `shelf_id` text REFERENCES shelf(id);--> statement-breakpoint
CREATE INDEX `item_shelf_idx` ON `item` (`shelf_id`);--> statement-breakpoint
DROP INDEX `item_old_idx`;
