// Shared building blocks. Wire format is snake_case; money is integer cents; timestamps are
// ISO-8601 UTC instants; quantities are base units unless a field says purchase units.
import { z } from "zod";
import { named } from "./registry";

export const Id = z.string().min(1).max(64);
export const Timestamp = z.iso.datetime({ offset: true });
export const LocalDate = z.iso.date();
export const Cents = z.number().int().min(0);
/** Discord user id of the human the agent acts for; unknown ids are rejected with 403. */
export const ActorDiscordId = z.string().min(1).max(32);

export const Location = named(
  "Location",
  z.enum(["fridge", "freezer", "pantry", "bathroom", "utility", "garden", "garage"]),
);
export const InventoryStatus = named(
  "InventoryStatus",
  z.enum(["out", "low", "stocked", "unknown", "critical", "consumed"]),
);

export const ErrorResponse = named(
  "ErrorResponse",
  z.object({ error: z.string(), details: z.unknown().optional() }),
);

export const EmptyRequest = named("EmptyRequest", z.object({}));

export const ProductRef = named(
  "ProductRef",
  z.object({
    id: Id,
    vendor: z.string(),
    asin: z.string().nullable(),
    title: z.string(),
    /** Base units per purchase unit. */
    unit_quantity: z.number(),
    stance: z.enum(["preferred", "acceptable", "rejected"]),
    last_price_cents: Cents.nullable(),
    /** This cycle's agent-observed price, if any. */
    quote_cents: Cents.nullable(),
  }),
);
