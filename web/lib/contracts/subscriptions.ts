// Subscribe & Save (DESIGN §4.9): the sweep's sync, and the items the cart plan leaves out.
import { z } from "zod";
import { Id, LocalDate, Timestamp } from "./common";
import { named } from "./registry";

const Asin = z.string().regex(/^[A-Z0-9]{10}$/);

export const SubscriptionIn = named(
  "SubscriptionIn",
  z.object({
    asin: Asin,
    title: z.string().max(500).nullable().optional(),
    /** Household-local date of the next delivery, if the page showed one. */
    next_delivery_on: LocalDate.nullable().optional(),
    /** The page's schedule text ("3 units every 3 weeks"). */
    schedule: z.string().max(200).nullable().optional(),
  }),
);

export const SubscriptionSyncRequest = named(
  "SubscriptionSyncRequest",
  z.object({
    /** The member whose Amazon account this is (member id, email or Discord id). */
    account: z.string().min(1),
    vendor: z.literal("amazon").default("amazon"),
    /**
     * Every subscription the member's Subscribe & Save page listed: the whole list, which replaces
     * the stored one (an open subscription it leaves out has ended). The agent only sends a list it
     * read completely.
     */
    subscriptions: z.array(SubscriptionIn).max(500),
  }),
);

export const SubscriptionSyncResponse = named(
  "SubscriptionSyncResponse",
  z.object({
    account_member_id: Id,
    synced_at: Timestamp,
    active: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    ended: z.number().int().nonnegative(),
    reopened: z.number().int().nonnegative(),
  }),
);

/** A restock-flagged item left out of the cart because Subscribe & Save delivers it. */
export const SubscribedLine = named(
  "SubscribedLine",
  z.object({
    item_id: Id,
    name: z.string(),
    asin: z.string(),
    runout_at: Timestamp.nullable(),
    next_delivery_on: LocalDate.nullable(),
  }),
);
