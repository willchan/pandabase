CREATE TABLE `receipt_hold` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`dedupe_key` text NOT NULL,
	`source` text NOT NULL,
	`vendor` text NOT NULL,
	`account_member_id` text,
	`external_order_id` text,
	`acquired_at` text NOT NULL,
	`input` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`expires_at` text NOT NULL,
	`resolved_at` text,
	`receipt_id` text,
	FOREIGN KEY (`account_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_hold_source_check" CHECK("source" IN ('digital', 'paper', 'manual')),
	CONSTRAINT "receipt_hold_status_check" CHECK("status" IN ('held', 'applied', 'expired')),
	CONSTRAINT "receipt_hold_input_json_check" CHECK(json_valid("input")),
	CONSTRAINT "receipt_hold_resolved_check" CHECK(("status" = 'held') = ("resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_hold_dedupe_key_unique` ON `receipt_hold` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `receipt_hold_status_idx` ON `receipt_hold` (`status`,`expires_at`);