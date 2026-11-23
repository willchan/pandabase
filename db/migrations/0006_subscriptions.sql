CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`member_id` text NOT NULL,
	`vendor` text NOT NULL,
	`asin` text NOT NULL,
	`title` text,
	`next_delivery_on` text,
	`schedule` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "subscription_ended_check" CHECK("ended_at" IS NULL OR "ended_at" >= "last_seen_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_member_asin_unique` ON `subscription` (`member_id`,`vendor`,`asin`);--> statement-breakpoint
CREATE INDEX `subscription_asin_idx` ON `subscription` (`asin`);