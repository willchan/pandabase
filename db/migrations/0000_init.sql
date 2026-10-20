CREATE TABLE `item` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`canonical_name` text NOT NULL,
	`category` text NOT NULL,
	`default_location` text NOT NULL,
	`tracking_type` text NOT NULL,
	`base_unit` text NOT NULL,
	`current_ema_days` real,
	`default_ema_days` real,
	`ema_outlier_streak` integer DEFAULT 0 NOT NULL,
	`ema_outlier_direction` text,
	`reorder_threshold` real,
	`shelf_life_days` integer,
	`audit_hint` text,
	`switch_threshold` real DEFAULT 0.15 NOT NULL,
	`trust` text DEFAULT 'unverified' NOT NULL,
	`merged_into_item_id` text,
	FOREIGN KEY (`merged_into_item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "item_default_location_check" CHECK("default_location" IN ('fridge', 'freezer', 'pantry', 'bathroom', 'utility', 'garden', 'garage')),
	CONSTRAINT "item_tracking_type_check" CHECK("tracking_type" IN ('velocity', 'static')),
	CONSTRAINT "item_ema_outlier_direction_check" CHECK("ema_outlier_direction" IN ('high', 'low')),
	CONSTRAINT "item_trust_check" CHECK("trust" IN ('confirmed', 'unverified')),
	CONSTRAINT "item_ema_positive_check" CHECK("current_ema_days" > 0 AND "default_ema_days" > 0),
	CONSTRAINT "item_shelf_life_check" CHECK("shelf_life_days" > 0)
);
--> statement-breakpoint
CREATE INDEX `item_canonical_name_idx` ON `item` (`canonical_name`);--> statement-breakpoint
CREATE TABLE `product` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`item_id` text NOT NULL,
	`vendor` text NOT NULL,
	`asin` text,
	`title` text NOT NULL,
	`unit_quantity` real DEFAULT 1 NOT NULL,
	`unit_quantity_trust` text DEFAULT 'unverified' NOT NULL,
	`stance` text DEFAULT 'acceptable' NOT NULL,
	`preference_score` real DEFAULT 0 NOT NULL,
	`times_bought` integer DEFAULT 0 NOT NULL,
	`consecutive_buys` integer DEFAULT 0 NOT NULL,
	`last_bought_at` text,
	`last_price_cents` integer,
	`last_price_at` text,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_unit_quantity_trust_check" CHECK("unit_quantity_trust" IN ('confirmed', 'unverified')),
	CONSTRAINT "product_stance_check" CHECK("stance" IN ('preferred', 'acceptable', 'rejected')),
	CONSTRAINT "product_unit_quantity_check" CHECK("unit_quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_vendor_asin_unique` ON `product` (`vendor`,`asin`) WHERE "asin" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `product_item_idx` ON `product` (`item_id`);--> statement-breakpoint
CREATE TABLE `vendor_alias` (
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
	CONSTRAINT "vendor_alias_kind_check" CHECK("kind" IN ('receipt_text', 'asin')),
	CONSTRAINT "vendor_alias_trust_check" CHECK("trust" IN ('confirmed', 'unverified')),
	CONSTRAINT "vendor_alias_ignored_check" CHECK("ignored" IN (0, 1)),
	CONSTRAINT "vendor_alias_confidence_check" CHECK("confidence_score" BETWEEN 0 AND 1),
	CONSTRAINT "vendor_alias_target_check" CHECK("ignored" = 1 OR "item_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_alias_unique` ON `vendor_alias` (`vendor`,`kind`,`vendor_string`);--> statement-breakpoint
CREATE TABLE `grocery_cycle` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`week_label` text NOT NULL,
	`discord_thread_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` text NOT NULL,
	`nudge_sent_at` text,
	`built_at` text,
	`closed_at` text,
	`close_reason` text,
	`cart_result` text,
	CONSTRAINT "grocery_cycle_status_check" CHECK("status" IN ('open', 'building', 'ready', 'closed', 'skipped', 'other_store')),
	CONSTRAINT "grocery_cycle_cart_result_json_check" CHECK(json_valid("cart_result"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grocery_cycle_week_label_unique` ON `grocery_cycle` (`week_label`);--> statement-breakpoint
CREATE UNIQUE INDEX `grocery_cycle_one_active` ON `grocery_cycle` ((1)) WHERE "status" IN ('open', 'building', 'ready');--> statement-breakpoint
CREATE TABLE `grocery_cycle_override` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`cycle_id` text NOT NULL,
	`kind` text NOT NULL,
	`item_id` text,
	`free_text` text,
	`quantity` real,
	`product_id` text,
	`actor_member_id` text,
	FOREIGN KEY (`cycle_id`) REFERENCES `grocery_cycle`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grocery_cycle_override_kind_check" CHECK("kind" IN ('add', 'skip', 'qty', 'product')),
	CONSTRAINT "grocery_cycle_override_target_check" CHECK("item_id" IS NOT NULL OR ("kind" = 'add' AND "free_text" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `grocery_cycle_override_cycle_idx` ON `grocery_cycle_override` (`cycle_id`);--> statement-breakpoint
CREATE TABLE `preference_event` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_product_id` text,
	`to_product_id` text,
	`threshold_before` real,
	`threshold_after` real,
	`cycle_id` text,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cycle_id`) REFERENCES `grocery_cycle`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "preference_event_kind_check" CHECK("kind" IN ('switch', 'override_to_preferred', 'override_to_cheaper', 'implicit_swap', 'reject', 'auto_promote'))
);
--> statement-breakpoint
CREATE INDEX `preference_event_item_idx` ON `preference_event` (`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `price_quote` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`cycle_id` text,
	`product_id` text NOT NULL,
	`price_cents` integer NOT NULL,
	`observed_at` text NOT NULL,
	`source` text DEFAULT 'agent' NOT NULL,
	FOREIGN KEY (`cycle_id`) REFERENCES `grocery_cycle`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "price_quote_source_check" CHECK("source" IN ('agent')),
	CONSTRAINT "price_quote_price_check" CHECK("price_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX `price_quote_product_idx` ON `price_quote` (`product_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `inventory_event` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`item_id` text NOT NULL,
	`location` text NOT NULL,
	`kind` text NOT NULL,
	`quantity` real NOT NULL,
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
	CONSTRAINT "inventory_event_moved_check" CHECK(("kind" = 'moved') = ("to_location" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `inventory_event_item_location_idx` ON `inventory_event` (`item_id`,`location`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `inventory_event_source_ref_idx` ON `inventory_event` (`source_ref`);--> statement-breakpoint
CREATE TABLE `inventory_state` (
	`item_id` text NOT NULL,
	`location` text NOT NULL,
	`anchor_qty` real,
	`anchor_at` text,
	`anchor_kind` text,
	`status_override` text,
	`frozen_at` text,
	`last_verified_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`item_id`, `location`),
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inventory_state_location_check" CHECK("location" IN ('fridge', 'freezer', 'pantry', 'bathroom', 'utility', 'garden', 'garage')),
	CONSTRAINT "inventory_state_anchor_kind_check" CHECK("anchor_kind" IN ('acquired', 'observed')),
	CONSTRAINT "inventory_state_status_override_check" CHECK("status_override" IN ('critical', 'consumed'))
);
--> statement-breakpoint
CREATE TABLE `audit_job` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`job_type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`media_r2_key` text,
	`keyframe_r2_keys` text,
	`expected_state_snapshot` text,
	`input` text,
	`raw_model_response` text,
	`result` text,
	`model` text,
	`prompt_version` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_at` text,
	`lease_expires_at` text,
	`error` text,
	`actor_member_id` text,
	`cycle_id` text,
	`discord_channel_id` text,
	`discord_message_id` text,
	`notified_at` text,
	`completed_at` text,
	FOREIGN KEY (`actor_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cycle_id`) REFERENCES `grocery_cycle`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_job_job_type_check" CHECK("job_type" IN ('paper_receipt', 'trash_cam', 'merge_suggest', 'storage_audit')),
	CONSTRAINT "audit_job_status_check" CHECK("status" IN ('queued', 'claimed', 'completed', 'failed')),
	CONSTRAINT "audit_job_keyframe_r2_keys_json_check" CHECK(json_valid("keyframe_r2_keys")),
	CONSTRAINT "audit_job_expected_state_snapshot_json_check" CHECK(json_valid("expected_state_snapshot")),
	CONSTRAINT "audit_job_input_json_check" CHECK(json_valid("input")),
	CONSTRAINT "audit_job_raw_model_response_json_check" CHECK(json_valid("raw_model_response")),
	CONSTRAINT "audit_job_result_json_check" CHECK(json_valid("result")),
	CONSTRAINT "audit_job_attempts_check" CHECK("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `audit_job_status_idx` ON `audit_job` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `labeled_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`source_kind` text NOT NULL,
	`job_id` text,
	`keyframe_r2_key` text,
	`bbox` text,
	`model_output` text,
	`human_label` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`member_id` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `audit_job`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "labeled_observation_source_kind_check" CHECK("source_kind" IN ('receipt_line', 'trash_cam', 'checkin')),
	CONSTRAINT "labeled_observation_bbox_json_check" CHECK(json_valid("bbox")),
	CONSTRAINT "labeled_observation_model_output_json_check" CHECK(json_valid("model_output")),
	CONSTRAINT "labeled_observation_human_label_json_check" CHECK(json_valid("human_label"))
);
--> statement-breakpoint
CREATE TABLE `review_item` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`kind` text NOT NULL,
	`job_id` text,
	`receipt_id` text,
	`item_id` text,
	`payload` text NOT NULL,
	`urgency` text DEFAULT 'cleanup' NOT NULL,
	`impact_score` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`default_action` text NOT NULL,
	`expires_at` text,
	`reviewed_by_member_id` text,
	`reviewed_at` text,
	FOREIGN KEY (`job_id`) REFERENCES `audit_job`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_item_kind_check" CHECK("kind" IN ('receipt', 'new_product', 'merge_suggestion', 'unverified_item', 'failed_job', 'trash_cam')),
	CONSTRAINT "review_item_urgency_check" CHECK("urgency" IN ('this_week', 'cleanup')),
	CONSTRAINT "review_item_status_check" CHECK("status" IN ('pending', 'confirmed', 'corrected', 'dismissed', 'expired')),
	CONSTRAINT "review_item_payload_json_check" CHECK(json_valid("payload")),
	CONSTRAINT "review_item_default_action_json_check" CHECK(json_valid("default_action")),
	CONSTRAINT "review_item_expires_at_check" CHECK("expires_at" IS NOT NULL OR "kind" = 'unverified_item')
);
--> statement-breakpoint
CREATE INDEX `review_item_status_idx` ON `review_item` (`status`,`urgency`,`impact_score`);--> statement-breakpoint
CREATE INDEX `review_item_expires_at_idx` ON `review_item` (`expires_at`);--> statement-breakpoint
CREATE TABLE `away_period` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`note` text,
	`created_by_member_id` text,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "away_period_range_check" CHECK("ends_on" >= "starts_on")
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`discord_user_id` text,
	`chromium_profile` text,
	`amazon_sweep` text DEFAULT 'off' NOT NULL,
	`is_cart_account` integer DEFAULT false NOT NULL,
	CONSTRAINT "member_amazon_sweep_check" CHECK("amazon_sweep" IN ('daily', 'weekly', 'off')),
	CONSTRAINT "member_is_cart_account_check" CHECK("is_cart_account" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_email_unique` ON `member` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_discord_user_id_unique` ON `member` (`discord_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_one_cart_account` ON `member` (`is_cart_account`) WHERE "is_cart_account" = 1;--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "setting_value_json_check" CHECK(json_valid("value"))
);
--> statement-breakpoint
CREATE TABLE `idempotency_key` (
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`key`, `scope`),
	CONSTRAINT "idempotency_key_response_body_json_check" CHECK(json_valid("response_body"))
);
--> statement-breakpoint
CREATE INDEX `idempotency_key_created_at_idx` ON `idempotency_key` (`created_at`);--> statement-breakpoint
CREATE TABLE `system_telemetry` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`metric_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "system_telemetry_payload_json_check" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE INDEX `system_telemetry_created_at_idx` ON `system_telemetry` (`created_at`);--> statement-breakpoint
CREATE INDEX `system_telemetry_metric_idx` ON `system_telemetry` (`source`,`metric_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`source` text NOT NULL,
	`vendor` text NOT NULL,
	`account_member_id` text,
	`external_order_id` text,
	`dedupe_key` text NOT NULL,
	`fulfillment` text DEFAULT 'unknown' NOT NULL,
	`ordered_at` text,
	`acquired_at` text NOT NULL,
	`subtotal_cents` integer,
	`total_cents` integer,
	`totals_check` text DEFAULT 'n/a' NOT NULL,
	`job_id` text,
	`status` text NOT NULL,
	FOREIGN KEY (`account_member_id`) REFERENCES `member`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `audit_job`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_source_check" CHECK("source" IN ('digital', 'paper', 'manual')),
	CONSTRAINT "receipt_fulfillment_check" CHECK("fulfillment" IN ('delivery', 'pickup', 'in_store', 'unknown')),
	CONSTRAINT "receipt_totals_check_check" CHECK("totals_check" IN ('pass', 'fail', 'n/a')),
	CONSTRAINT "receipt_status_check" CHECK("status" IN ('applied', 'pending_review', 'partial'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_dedupe_key_unique` ON `receipt` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `receipt_acquired_at_idx` ON `receipt` (`acquired_at`);--> statement-breakpoint
CREATE TABLE `receipt_line` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`receipt_id` text NOT NULL,
	`raw_text` text NOT NULL,
	`asin` text,
	`product_id` text,
	`item_id` text,
	`qty` real DEFAULT 1 NOT NULL,
	`unit_price_cents` integer,
	`line_total_cents` integer,
	`match_method` text DEFAULT 'none' NOT NULL,
	`match_score` real,
	`trust` text DEFAULT 'unverified' NOT NULL,
	`ignored` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `item`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_line_match_method_check" CHECK("match_method" IN ('asin', 'alias_exact', 'fuzzy', 'manual', 'none')),
	CONSTRAINT "receipt_line_trust_check" CHECK("trust" IN ('confirmed', 'unverified')),
	CONSTRAINT "receipt_line_ignored_check" CHECK("ignored" IN (0, 1)),
	CONSTRAINT "receipt_line_match_score_check" CHECK("match_score" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE INDEX `receipt_line_receipt_idx` ON `receipt_line` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `receipt_line_item_idx` ON `receipt_line` (`item_id`);