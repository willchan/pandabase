// DESIGN §2.3 — Inventory: the append-only event log and its cached projection.
import { sql } from "drizzle-orm";
import { check, index, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { item } from "./catalog";
import { baseColumns, col, createdAt, enumCheck, enumText, LOCATIONS, updatedAt } from "./common";
import { member } from "./people";

export const INVENTORY_EVENT_KINDS = [
  "acquired",
  "observed",
  "consumed",
  "discarded",
  "presumed_discarded",
  "moved",
] as const;
export const STATUS_OVERRIDES = ["critical", "consumed"] as const;
export const INVENTORY_SOURCES = [
  "digital_receipt",
  "paper_receipt",
  "manual",
  "trash_cam",
  "checkin",
  "backfill",
  "task",
  "system",
] as const;
export const ACTOR_SYSTEMS = ["agent", "worker", "cron"] as const;
export const EVENT_TRUST = ["confirmed", "provisional", "expired"] as const;
export const ANCHOR_KINDS = ["acquired", "observed"] as const;

export const inventoryEvent = sqliteTable(
  "inventory_event",
  {
    ...baseColumns(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id),
    location: enumText("location", LOCATIONS).notNull(),
    kind: enumText("kind", INVENTORY_EVENT_KINDS).notNull(),
    /** Base units. Absolute amount for `observed`; moved amount for `moved`. */
    quantity: real("quantity").notNull(),
    toLocation: enumText("to_location", LOCATIONS),
    statusOverride: enumText("status_override", STATUS_OVERRIDES),
    occurredAt: text("occurred_at").notNull(),
    source: enumText("source", INVENTORY_SOURCES).notNull(),
    /** Receipt / job / cycle id. */
    sourceRef: text("source_ref"),
    actorMemberId: text("actor_member_id").references(() => member.id),
    actorSystem: enumText("actor_system", ACTOR_SYSTEMS),
    trust: enumText("trust", EVENT_TRUST).notNull().default("confirmed"),
  },
  (t) => [
    enumCheck("inventory_event", t.location, LOCATIONS),
    enumCheck("inventory_event", t.kind, INVENTORY_EVENT_KINDS),
    enumCheck("inventory_event", t.toLocation, LOCATIONS),
    enumCheck("inventory_event", t.statusOverride, STATUS_OVERRIDES),
    enumCheck("inventory_event", t.source, INVENTORY_SOURCES),
    enumCheck("inventory_event", t.actorSystem, ACTOR_SYSTEMS),
    enumCheck("inventory_event", t.trust, EVENT_TRUST),
    check("inventory_event_quantity_check", sql`${col(t.quantity)} >= 0`),
    check(
      "inventory_event_moved_check",
      sql`(${col(t.kind)} = 'moved') = (${col(t.toLocation)} IS NOT NULL)`,
    ),
    index("inventory_event_item_location_idx").on(t.itemId, t.location, t.occurredAt),
    index("inventory_event_source_ref_idx").on(t.sourceRef),
  ],
);

export const inventoryState = sqliteTable(
  "inventory_state",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => item.id),
    location: enumText("location", LOCATIONS).notNull(),
    anchorQty: real("anchor_qty"),
    anchorAt: text("anchor_at"),
    anchorKind: enumText("anchor_kind", ANCHOR_KINDS),
    statusOverride: enumText("status_override", STATUS_OVERRIDES),
    frozenAt: text("frozen_at"),
    lastVerifiedAt: text("last_verified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.location] }),
    enumCheck("inventory_state", t.location, LOCATIONS),
    enumCheck("inventory_state", t.anchorKind, ANCHOR_KINDS),
    enumCheck("inventory_state", t.statusOverride, STATUS_OVERRIDES),
  ],
);
