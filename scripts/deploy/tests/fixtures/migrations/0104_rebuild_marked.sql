-- Synthetic fixture: the same rebuild, reviewed and marked.
-- contract-migration: rebuild only tightens a CHECK; every column of `shelf` survives
CREATE TABLE `__new_shelf` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL);--> statement-breakpoint
DROP TABLE `shelf`;--> statement-breakpoint
ALTER TABLE `__new_shelf` RENAME TO `shelf`;
