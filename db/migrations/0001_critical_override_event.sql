PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_inventory_event` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`item_id` text NOT NULL,
	`location` text NOT NULL,
	`kind` text NOT NULL,
	`quantity` real,
	`to_location` text,
	`status_override` text,
	`occurred_at` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`actor_member_id` text,
	`actor_system` text,
	`trust` text DEFAULT 'confirmed' NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inventory_event_location_check" CHECK("location" IN ('fridge', 'freezer', 'pantry', 'bathroom', 'utility', 'garden', 'garage')),
	CONSTRAINT "inventory_event_kind_check" CHECK("kind" IN ('acquired', 'observed', 'consumed', 'discarded', 'presumed_discarded', 'moved')),
	CONSTRAINT "inventory_event_to_location_check" CHECK("to_location" IN ('fridge', 'freezer', 'pantry', 'bathroom', 'utility', 'garden', 'garage')),
	CONSTRAINT "inventory_event_status_override_check" CHECK("status_override" IN ('critical', 'consumed')),
	CONSTRAINT "inventory_event_source_check" CHECK("source" IN ('digital_receipt', 'paper_receipt', 'manual', 'trash_cam', 'checkin', 'backfill', 'task', 'system')),
	CONSTRAINT "inventory_event_actor_system_check" CHECK("actor_system" IN ('agent', 'worker', 'cron')),
	CONSTRAINT "inventory_event_trust_check" CHECK("trust" IN ('confirmed', 'provisional', 'expired')),
	CONSTRAINT "inventory_event_quantity_check" CHECK("quantity" >= 0),
	CONSTRAINT "inventory_event_quantity_null_check" CHECK("quantity" IS NOT NULL OR ("kind" = 'observed' AND "status_override" IS 'critical')),
	CONSTRAINT "inventory_event_moved_check" CHECK(("kind" = 'moved') = ("to_location" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_inventory_event`("id", "created_at", "updated_at", "item_id", "location", "kind", "quantity", "to_location", "status_override", "occurred_at", "source", "source_ref", "actor_member_id", "actor_system", "trust") SELECT "id", "created_at", "updated_at", "item_id", "location", "kind", "quantity", "to_location", "status_override", "occurred_at", "source", "source_ref", "actor_member_id", "actor_system", "trust" FROM `inventory_event`;--> statement-breakpoint
DROP TABLE `inventory_event`;--> statement-breakpoint
ALTER TABLE `__new_inventory_event` RENAME TO `inventory_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `inventory_event_item_location_idx` ON `inventory_event` (`item_id`,`location`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `inventory_event_source_ref_idx` ON `inventory_event` (`source_ref`);