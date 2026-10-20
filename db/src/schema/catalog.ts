// DESIGN §2.2 — Catalog: items (needs), products (purchasable things), vendor aliases.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import {
  baseColumns,
  boolCheck,
  CATALOG_TRUST,
  col,
  enumCheck,
  enumText,
  LOCATIONS,
} from "./common";

export const TRACKING_TYPES = ["velocity", "static"] as const;
export const OUTLIER_DIRECTIONS = ["high", "low"] as const;
export const STANCES = ["preferred", "acceptable", "rejected"] as const;
export const ALIAS_KINDS = ["receipt_text", "asin"] as const;

export const item = sqliteTable(
  "item",
  {
    ...baseColumns(),
    canonicalName: text("canonical_name").notNull(),
    category: text("category").notNull(),
    defaultLocation: enumText("default_location", LOCATIONS).notNull(),
    trackingType: enumText("tracking_type", TRACKING_TYPES).notNull(),
    baseUnit: text("base_unit").notNull(),
    /** Days one base unit lasts. */
    currentEmaDays: real("current_ema_days"),
    defaultEmaDays: real("default_ema_days"),
    emaOutlierStreak: integer("ema_outlier_streak").notNull().default(0),
    emaOutlierDirection: enumText("ema_outlier_direction", OUTLIER_DIRECTIONS),
    reorderThreshold: real("reorder_threshold"),
    shelfLifeDays: integer("shelf_life_days"),
    auditHint: text("audit_hint"),
    switchThreshold: real("switch_threshold").notNull().default(0.15),
    trust: enumText("trust", CATALOG_TRUST).notNull().default("unverified"),
    mergedIntoItemId: text("merged_into_item_id").references((): AnySQLiteColumn => item.id),
  },
  (t) => [
    enumCheck("item", t.defaultLocation, LOCATIONS),
    enumCheck("item", t.trackingType, TRACKING_TYPES),
    enumCheck("item", t.emaOutlierDirection, OUTLIER_DIRECTIONS),
    enumCheck("item", t.trust, CATALOG_TRUST),
    check(
      "item_ema_positive_check",
      sql`${col(t.currentEmaDays)} > 0 AND ${col(t.defaultEmaDays)} > 0`,
    ),
    check("item_shelf_life_check", sql`${col(t.shelfLifeDays)} > 0`),
    index("item_canonical_name_idx").on(t.canonicalName),
  ],
);

export const product = sqliteTable(
  "product",
  {
    ...baseColumns(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id),
    /** `amazon`, `wholefoods`, or another store slug — open set, so no CHECK. */
    vendor: text("vendor").notNull(),
    asin: text("asin"),
    title: text("title").notNull(),
    /** Base units per purchase unit. */
    unitQuantity: real("unit_quantity").notNull().default(1),
    unitQuantityTrust: enumText("unit_quantity_trust", CATALOG_TRUST)
      .notNull()
      .default("unverified"),
    stance: enumText("stance", STANCES).notNull().default("acceptable"),
    preferenceScore: real("preference_score").notNull().default(0),
    timesBought: integer("times_bought").notNull().default(0),
    consecutiveBuys: integer("consecutive_buys").notNull().default(0),
    lastBoughtAt: text("last_bought_at"),
    lastPriceCents: integer("last_price_cents"),
    lastPriceAt: text("last_price_at"),
  },
  (t) => [
    enumCheck("product", t.unitQuantityTrust, CATALOG_TRUST),
    enumCheck("product", t.stance, STANCES),
    check("product_unit_quantity_check", sql`${col(t.unitQuantity)} > 0`),
    uniqueIndex("product_vendor_asin_unique")
      .on(t.vendor, t.asin)
      .where(sql`${col(t.asin)} IS NOT NULL`),
    index("product_item_idx").on(t.itemId),
  ],
);

export const vendorAlias = sqliteTable(
  "vendor_alias",
  {
    ...baseColumns(),
    vendor: text("vendor").notNull(),
    kind: enumText("kind", ALIAS_KINDS).notNull(),
    /** Normalized external string (receipt text or ASIN). */
    vendorString: text("vendor_string").notNull(),
    /** Null only for ignored aliases (e.g. store fee lines). */
    itemId: text("item_id").references(() => item.id),
    productId: text("product_id").references(() => product.id),
    confidenceScore: real("confidence_score").notNull().default(0),
    trust: enumText("trust", CATALOG_TRUST).notNull().default("unverified"),
    ignored: integer("ignored", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    enumCheck("vendor_alias", t.kind, ALIAS_KINDS),
    enumCheck("vendor_alias", t.trust, CATALOG_TRUST),
    boolCheck("vendor_alias", t.ignored),
    check("vendor_alias_confidence_check", sql`${col(t.confidenceScore)} BETWEEN 0 AND 1`),
    check("vendor_alias_target_check", sql`${col(t.ignored)} = 1 OR ${col(t.itemId)} IS NOT NULL`),
    uniqueIndex("vendor_alias_unique").on(t.vendor, t.kind, t.vendorString),
  ],
);
