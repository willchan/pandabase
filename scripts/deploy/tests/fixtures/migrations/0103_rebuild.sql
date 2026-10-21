-- Synthetic fixture: Drizzle's SQLite table rebuild (changing a CHECK constraint).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shelf` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL CHECK(length(`name`) > 0));--> statement-breakpoint
INSERT INTO `__new_shelf`("id", "name") SELECT "id", "name" FROM `shelf`;--> statement-breakpoint
DROP TABLE `shelf`;--> statement-breakpoint
ALTER TABLE `__new_shelf` RENAME TO `shelf`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
