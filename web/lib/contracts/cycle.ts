// Grocery cycle, check-in, predictions, price quotes, cart (DESIGN §3.2, §4.3, §4.4, §4.7).
import { z } from "zod";
import { ActorDiscordId, Cents, Id, InventoryStatus, ProductRef, Timestamp } from "./common";
import { named } from "./registry";

export const CartResultLine = named(
  "CartResultLine",
  z.object({
    item_id: Id.nullable(),
    product_id: Id.nullable(),
    asin: z.string().nullable().optional(),
    free_text: z.string().nullable().optional(),
    /** Purchase units. */
    quantity: z.number().positive(),
    /** tier1 = add-to-cart URL; tier2 = agent's browser fallback; failed = not added. */
    outcome: z.enum(["tier1", "tier2", "failed"]),
    error: z.string().nullable().optional(),
  }),
);

/** Stored in `grocery_cycle.cart_result`. */
export const CartResult = named(
  "CartResult",
  z.object({
    vendors: z.array(z.string()),
    order_ids: z.array(z.string()),
    lines: z.array(CartResultLine),
    please_check_item_ids: z.array(z.string()),
    recorded_at: Timestamp,
  }),
);

export const CycleStatus = named(
  "CycleStatus",
  z.enum(["open", "building", "ready", "closed", "skipped", "other_store"]),
);

export const Cycle = named(
  "Cycle",
  z.object({
    id: Id,
    week_label: z.string(),
    status: CycleStatus,
    discord_thread_id: z.string().nullable(),
    opened_at: Timestamp,
    nudge_sent_at: Timestamp.nullable(),
    built_at: Timestamp.nullable(),
    closed_at: Timestamp.nullable(),
    close_reason: z.string().nullable(),
    cart_result: CartResult.nullable(),
  }),
);

export const CycleCurrentResponse = named(
  "CycleCurrentResponse",
  z.object({ cycle: Cycle.nullable() }),
);

export const CycleOpenRequest = named(
  "CycleOpenRequest",
  z.object({ discord_thread_id: z.string().min(1) }),
);
export const CycleOpenResponse = named(
  "CycleOpenResponse",
  z.object({ cycle: Cycle, created: z.boolean() }),
);

export const OverrideKind = named("OverrideKind", z.enum(["add", "skip", "qty", "product"]));
export const CycleOverrideRequest = named(
  "CycleOverrideRequest",
  z.object({
    actor_discord_id: ActorDiscordId,
    kind: OverrideKind,
    /** Required unless `kind = add` with `free_text`. */
    item_id: Id.nullable().optional(),
    free_text: z.string().min(1).max(200).nullable().optional(),
    /** Purchase units (base units for a line without a product). */
    quantity: z.number().positive().nullable().optional(),
    /** Required for `kind = product`. */
    product_id: Id.nullable().optional(),
  }),
);
export const CycleOverride = named(
  "CycleOverride",
  z.object({
    id: Id,
    cycle_id: Id,
    kind: OverrideKind,
    item_id: Id.nullable(),
    free_text: z.string().nullable(),
    quantity: z.number().nullable(),
    product_id: Id.nullable(),
    actor_member_id: Id.nullable(),
    created_at: Timestamp,
  }),
);
export const CycleOverrideResponse = named(
  "CycleOverrideResponse",
  z.object({ override: CycleOverride }),
);

export const CycleStatusRequest = named(
  "CycleStatusRequest",
  z.object({
    actor_discord_id: ActorDiscordId.nullable().optional(),
    /**
     * `nudged` (Friday nudge posted), `building` (Saturday build starts; becomes `skipped` if an
     * away period covers the build date), `ready` (cart filled), `skipped`, `other_store`,
     * `closed` ("done").
     */
    status: z.enum(["nudged", "building", "ready", "skipped", "other_store", "closed"]),
    reason: z.string().max(200).nullable().optional(),
  }),
);
export const CycleStatusResponse = named(
  "CycleStatusResponse",
  z.object({
    cycle: Cycle,
    /** False when the request changed nothing (a repeated nudge). */
    changed: z.boolean(),
  }),
);

export const RestockReason = named(
  "RestockReason",
  z.enum(["runout", "critical", "consumed", "static_threshold"]),
);

export const CheckinItem = named(
  "CheckinItem",
  z.object({
    item_id: Id,
    name: z.string(),
    base_unit: z.string(),
    on_hand: z.number(),
    status: InventoryStatus,
    runout_at: Timestamp.nullable(),
    reason: z.enum([
      "runout",
      "critical",
      "consumed",
      "static_threshold",
      "near_runout",
      "audit_hint",
    ]),
    audit_hint: z.string().nullable(),
  }),
);
export const FreezerItem = named(
  "FreezerItem",
  z.object({
    item_id: Id,
    name: z.string(),
    base_unit: z.string(),
    quantity: z.number(),
    frozen_at: Timestamp.nullable(),
  }),
);
export const CheckinResponse = named(
  "CheckinResponse",
  z.object({
    cycle_id: Id.nullable(),
    likely_needed: z.array(CheckinItem),
    please_check: z.array(CheckinItem),
    freezer: z.array(FreezerItem),
    pending_review_count: z.number().int(),
  }),
);

export const PredictionsQuery = named("PredictionsQuery", z.object({ cycle_id: Id.optional() }));
export const PlanLine = named(
  "PlanLine",
  z.object({
    item_id: Id.nullable(),
    name: z.string(),
    free_text: z.string().nullable(),
    base_unit: z.string().nullable(),
    /** Purchase units of `product`, or base units when there is no product. */
    quantity: z.number(),
    reason: RestockReason.nullable(),
    overrides: z.array(OverrideKind),
    product: ProductRef.nullable(),
    candidates: z.array(ProductRef),
    needs_price_check: z.boolean(),
    choice_reason: z.string().nullable(),
  }),
);
export const PredictionsResponse = named(
  "PredictionsResponse",
  z.object({
    cycle_id: Id.nullable(),
    generated_at: Timestamp,
    lines: z.array(PlanLine),
    skipped_item_ids: z.array(z.string()),
    needs_price_check_item_ids: z.array(z.string()),
  }),
);

export const PriceQuotesRequest = named(
  "PriceQuotesRequest",
  z.object({
    cycle_id: Id,
    quotes: z
      .array(
        z.object({
          product_id: Id,
          /** Price of one purchase unit. */
          price_cents: Cents,
          observed_at: Timestamp.nullable().optional(),
        }),
      )
      .min(1)
      .max(200),
  }),
);
export const PriceQuotesResponse = named(
  "PriceQuotesResponse",
  z.object({ accepted: z.number().int() }),
);

export const CartLine = named(
  "CartLine",
  z.object({
    item_id: Id.nullable(),
    name: z.string(),
    free_text: z.string().nullable(),
    product: ProductRef.nullable(),
    quantity: z.number(),
    /** Why this product ("28% cheaper per egg than your usual Vital Farms"). */
    reason_text: z.string(),
    /** The cheaper product was chosen over the preferred one. */
    switched: z.boolean(),
  }),
);
export const CartResponse = named(
  "CartResponse",
  z.object({ cycle_id: Id, lines: z.array(CartLine) }),
);

export const CartResultRequest = named(
  "CartResultRequest",
  z.object({
    lines: z.array(CartResultLine).max(500),
    /** Vendors whose carts were filled (defaults to the vendors of the lines' products). */
    vendors: z.array(z.string()).optional(),
    /** Order ids, if the agent saw them (otherwise the next digital receipt after the build). */
    order_ids: z.array(z.string()).optional(),
  }),
);
export const CartResultResponse = named("CartResultResponse", z.object({ cycle: Cycle }));

export const PriceQuote = z.object({ product_id: Id, price_cents: Cents });
export type PriceQuoteT = z.infer<typeof PriceQuote>;
export type CartResultT = z.infer<typeof CartResult>;
export type CycleT = z.infer<typeof Cycle>;
