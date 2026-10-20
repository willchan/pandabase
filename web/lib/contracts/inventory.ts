// Inventory events, item lookup, freezer aging, away periods, products (DESIGN §3.2, §4.2).
import { z } from "zod";
import { ActorDiscordId, Id, InventoryStatus, LocalDate, Location, Timestamp } from "./common";
import { FreezerItem } from "./cycle";
import { named } from "./registry";

export const InventoryEventInput = named(
  "InventoryEventInput",
  z.object({
    item_id: Id,
    /**
     * `observed`: a count (absolute `quantity`). `critical`: "running out" flag (no quantity).
     * `consumed`: "we're out". `discarded`: threw some away. `moved`: e.g. "froze the chicken"
     * (`to_location` required). `acquired`: a text purchase ("bought milk") — recorded as a
     * manual receipt so velocity learns from it; `quantity` is purchase units of `product_id`
     * (or of the item's preferred product), default 1.
     */
    kind: z.enum(["observed", "critical", "consumed", "discarded", "moved", "acquired"]),
    /** Defaults to the item's default location. */
    location: Location.optional(),
    /** Base units (purchase units for `acquired`). */
    quantity: z.number().min(0).nullable().optional(),
    to_location: Location.optional(),
    /** Defaults to now. */
    occurred_at: Timestamp.optional(),
    product_id: Id.nullable().optional(),
    /** Store for `acquired` (default `other`). */
    vendor: z.string().min(1).max(40).optional(),
    /** `checkin` for answers to the Friday nudge; `manual` otherwise (default). */
    source: z.enum(["manual", "checkin"]).optional(),
  }),
);
export const InventoryEventsRequest = named(
  "InventoryEventsRequest",
  z.object({
    actor_discord_id: ActorDiscordId,
    events: z.array(InventoryEventInput).min(1).max(50),
  }),
);
export const ItemEstimate = named(
  "ItemEstimate",
  z.object({
    item_id: Id,
    on_hand: z.number(),
    status: InventoryStatus,
    runout_at: Timestamp.nullable(),
  }),
);
export const InventoryEventsResponse = named(
  "InventoryEventsResponse",
  z.object({
    event_ids: z.array(z.string()),
    /** Manual receipt created for `acquired` events, if any. */
    receipt_id: Id.nullable(),
    estimates: z.array(ItemEstimate),
  }),
);

export const LookupQuery = named("LookupQuery", z.object({ q: z.string().min(1).max(100) }));
export const LookupMatch = named(
  "LookupMatch",
  z.object({
    item_id: Id,
    name: z.string(),
    score: z.number(),
    base_unit: z.string(),
    on_hand: z.number(),
    status: InventoryStatus,
    runout_at: Timestamp.nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    /** Ready-to-post answer, e.g. "~2 milk (bought Oct 12, unverified) → probably fine". */
    text: z.string(),
    by_location: z.array(z.object({ location: Location, on_hand: z.number() })),
  }),
);
export const LookupResponse = named(
  "LookupResponse",
  z.object({ query: z.string(), matches: z.array(LookupMatch) }),
);

export const FreezerAgingQuery = named(
  "FreezerAgingQuery",
  z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
);
export const FreezerAgingResponse = named(
  "FreezerAgingResponse",
  z.object({ items: z.array(FreezerItem) }),
);

export const AwayPeriodRequest = named(
  "AwayPeriodRequest",
  z.object({
    actor_discord_id: ActorDiscordId,
    /** Household-local dates, inclusive. */
    starts_on: LocalDate,
    ends_on: LocalDate,
    note: z.string().max(200).nullable().optional(),
  }),
);
export const AwayPeriod = named(
  "AwayPeriod",
  z.object({ id: Id, starts_on: LocalDate, ends_on: LocalDate, note: z.string().nullable() }),
);
export const AwayPeriodResponse = named(
  "AwayPeriodResponse",
  z.object({ away_period: AwayPeriod }),
);

export const ProductRejectRequest = named(
  "ProductRejectRequest",
  z.object({ actor_discord_id: ActorDiscordId }),
);
export const ProductRejectResponse = named(
  "ProductRejectResponse",
  z.object({ product_id: Id, item_id: Id, stance: z.literal("rejected"), changed: z.boolean() }),
);

export type InventoryEventInputT = z.infer<typeof InventoryEventInput>;
