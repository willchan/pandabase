// Costco trips, the trip list and store pins (DESIGN §3.2, §4.8).
import { z } from "zod";
import { ActorDiscordId, Id, LocalDate, ProductRef, Timestamp } from "./common";
import { named } from "./registry";

/** `regular` = the weekly Whole Foods/Amazon cart. */
export const Store = named("Store", z.enum(["costco", "regular"]));

export const StoreWhy = named(
  "StoreWhy",
  z.enum([
    "pinned",
    "no_costco_product",
    "costco_only",
    "no_price",
    "not_cheaper_enough",
    "spoils_first",
    "cheaper",
  ]),
);

/** §4.8 `chooseStore` for one item. */
export const StoreChoice = named(
  "StoreChoice",
  z.object({
    store: Store,
    why: StoreWhy,
    /** "Costco: 20% cheaper per egg than 365 Large Brown Eggs 12ct". */
    reason: z.string(),
    /** `(regular − costco) / regular` per base unit, when both prices are known. */
    savings_ratio: z.number().nullable(),
  }),
);

/**
 * A Costco item's place in the weekly cart (§4.8): `wait` (left out until the trip), `bridge`
 * (bought this week: no trip planned, the trip is after it runs out, or it's needed now).
 */
export const CostcoTiming = named(
  "CostcoTiming",
  z.object({
    timing: z.enum(["wait", "bridge"]),
    bridge_cause: z.enum(["no_trip", "needed_now", "trip_after_runout"]).nullable(),
  }),
);

/** A planned line's store, for every line the restock rule planned (§4.3, §4.8). */
export const PlanStore = named(
  "PlanStore",
  StoreChoice.extend({ costco: CostcoTiming.nullable() }),
);

/** A restock-flagged Costco item left out of the weekly cart because a trip comes first. */
export const CostcoWaitingLine = named(
  "CostcoWaitingLine",
  z.object({
    item_id: Id,
    name: z.string(),
    runout_at: Timestamp.nullable(),
    /** The store choice's reason ("Costco: 20% cheaper per egg …"). */
    reason: z.string(),
  }),
);

export const CostcoListLine = named(
  "CostcoListLine",
  z.object({
    item_id: Id,
    name: z.string(),
    base_unit: z.string(),
    /** The Costco product to buy (its price is from the last Costco receipt). */
    product: ProductRef,
    /** Purchase units (packs) of `product`. */
    quantity: z.number(),
    reason: z.enum(["runout", "critical", "consumed", "static_threshold"]),
    on_hand: z.number(),
    runout_at: Timestamp.nullable(),
    /** Why Costco ("Costco: 20% cheaper per egg than …", "You get this at Costco"). */
    store_reason: z.string(),
    savings_ratio: z.number().nullable(),
  }),
);

export const CostcoTripStatus = named("CostcoTripStatus", z.enum(["planned", "done", "cancelled"]));

export const CostcoTrip = named(
  "CostcoTrip",
  z.object({
    id: Id,
    /** Household-local date of the trip. */
    planned_for: LocalDate,
    status: CostcoTripStatus,
    discord_thread_id: z.string().nullable(),
    /** The list as last posted (planned or moved); `CostcoTripResponse.lines` is the live one. */
    list: z.array(CostcoListLine),
    receipt_id: Id.nullable(),
    closed_at: Timestamp.nullable(),
    /** `back_from_costco`, `cancelled`, `expired` (no receipt `costco.tripExpireAfterDays` after). */
    close_reason: z.string().nullable(),
    created_at: Timestamp,
  }),
);

export const CostcoTripResponse = named(
  "CostcoTripResponse",
  z.object({
    /** The planned trip, or null. */
    trip: CostcoTrip.nullable(),
    /** The live list for the planned trip's date ([] without a trip). */
    lines: z.array(CostcoListLine),
  }),
);

export const CostcoTripPlanRequest = named(
  "CostcoTripPlanRequest",
  z.object({
    actor_discord_id: ActorDiscordId.nullable().optional(),
    /** Household-local date, today up to `costco.tripMaxAheadDays` ahead. */
    planned_for: LocalDate,
    /** The `#pandabase` message the list is posted under, when the agent has one. */
    discord_thread_id: z.string().min(1).max(64).nullable().optional(),
  }),
);
export const CostcoTripPlanResponse = named(
  "CostcoTripPlanResponse",
  z.object({
    trip: CostcoTrip,
    lines: z.array(CostcoListLine),
    /** False when a trip was already planned: it moved to `planned_for` (or stayed). */
    created: z.boolean(),
    /** The previous date when an already planned trip moved. */
    moved_from: LocalDate.nullable(),
  }),
);

export const CostcoTripStatusRequest = named(
  "CostcoTripStatusRequest",
  z.object({
    actor_discord_id: ActorDiscordId.nullable().optional(),
    /** `done` ("back from Costco") or `cancelled` ("not going after all"). */
    status: z.enum(["done", "cancelled"]),
    reason: z.string().max(200).nullable().optional(),
  }),
);
export const CostcoTripStatusResponse = named(
  "CostcoTripStatusResponse",
  z.object({
    trip: CostcoTrip,
    /** False when the trip already had this status (a repeated "back from Costco"). */
    changed: z.boolean(),
  }),
);

export const StorePinRequest = named(
  "StorePinRequest",
  z.object({
    actor_discord_id: ActorDiscordId,
    /** "Get X at Costco" → `costco`; "… at Whole Foods / Amazon" → `regular`; null clears it. */
    store: Store.nullable(),
  }),
);
export const StorePinResponse = named(
  "StorePinResponse",
  z.object({
    item_id: Id,
    name: z.string(),
    store_pin: Store.nullable(),
    /** The item's store choice now. A Costco pin needs a Costco purchase first (§4.8 step 1). */
    choice: StoreChoice,
    /** The household's `costco.switchThreshold` after this pin. */
    switch_threshold: z.number(),
    /** The pin went against a price-based choice and moved the threshold. */
    threshold_changed: z.boolean(),
  }),
);

export type CostcoListLineT = z.infer<typeof CostcoListLine>;
export type CostcoTripT = z.infer<typeof CostcoTrip>;
