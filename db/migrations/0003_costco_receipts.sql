-- contract-migration: drizzle-kit rebuilds vendor_alias to widen its kind CHECK (+ item_number, M10.3). Every column is copied, no table references vendor_alias, and the previous release reads the same columns.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_vendor_alias` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`vendor` text NOT NULL,
	`kind` text NOT NULL,
	`vendor_string` text NOT NULL,
	`item_id` text,
	`product_id` text,
	`confidence_score` real DEFAULT 0 NOT NULL,
	`trust` text DEFAULT 'unverified' NOT NULL,
	`ignored` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vendor_alias_kind_check" CHECK("kind" IN ('receipt_text', 'asin', 'item_number')),
	CONSTRAINT "vendor_alias_trust_check" CHECK("trust" IN ('confirmed', 'unverified')),
	CONSTRAINT "vendor_alias_ignored_check" CHECK("ignored" IN (0, 1)),
	CONSTRAINT "vendor_alias_confidence_check" CHECK("confidence_score" BETWEEN 0 AND 1),
	CONSTRAINT "vendor_alias_target_check" CHECK("ignored" = 1 OR "item_id" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_vendor_alias`("id", "created_at", "updated_at", "vendor", "kind", "vendor_string", "item_id", "product_id", "confidence_score", "trust", "ignored") SELECT "id", "created_at", "updated_at", "vendor", "kind", "vendor_string", "item_id", "product_id", "confidence_score", "trust", "ignored" FROM `vendor_alias`;--> statement-breakpoint
DROP TABLE `vendor_alias`;--> statement-breakpoint
ALTER TABLE `__new_vendor_alias` RENAME TO `vendor_alias`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_alias_unique` ON `vendor_alias` (`vendor`,`kind`,`vendor_string`);--> statement-breakpoint
ALTER TABLE `product` ADD `vendor_sku` text;--> statement-breakpoint
ALTER TABLE `product` ADD `last_price_fulfillment` text;--> statement-breakpoint
CREATE UNIQUE INDEX `product_vendor_sku_unique` ON `product` (`vendor`,`vendor_sku`) WHERE "vendor_sku" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `receipt_line` ADD `vendor_sku` text;