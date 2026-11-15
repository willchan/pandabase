CREATE TABLE `costco_trip` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`planned_for` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`discord_thread_id` text,
	`list` text NOT NULL,
	`receipt_id` text,
	`closed_at` text,
	`close_reason` text,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "costco_trip_status_check" CHECK("status" IN ('planned', 'done', 'cancelled')),
	CONSTRAINT "costco_trip_list_json_check" CHECK(json_valid("list")),
	CONSTRAINT "costco_trip_closed_check" CHECK(("status" = 'planned') = ("closed_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `costco_trip_one_planned` ON `costco_trip` ((1)) WHERE "status" IN ('planned');--> statement-breakpoint
CREATE INDEX `costco_trip_planned_for_idx` ON `costco_trip` (`planned_for`);--> statement-breakpoint
ALTER TABLE `item` ADD `store_pin` text;