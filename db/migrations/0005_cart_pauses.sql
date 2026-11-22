CREATE TABLE `pause_period` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`note` text,
	`created_by_member_id` text,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pause_period_range_check" CHECK("ends_on" >= "starts_on")
);
