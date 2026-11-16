// DESIGN §4.8 — Costco trips: which dates a trip can be planned for, when an unclosed trip
// expires, and the trip's list over the catalog.
import type { Config } from "../config";
import type { PlanItemInput } from "./predictions";
import type { ProductCandidate } from "./productChoice";
import { chooseStore, costcoListLine, type CostcoListLine, type StoreChoice } from "./storeChoice";
import { addDays, localDate } from "./time";

/** Why `plannedFor` can't be a trip date, or null. Today counts ("going to Costco now"). */
export function tripDateProblem(plannedFor: string, now: string, config: Config): string | null {
  const today = localDate(now, config.householdTz);
  if (plannedFor < today) return `${plannedFor} is in the past`;
  const last = addDays(today, config.costco.tripMaxAheadDays);
  if (plannedFor > last) {
    return `${plannedFor} is more than ${config.costco.tripMaxAheadDays} days ahead`;
  }
  return null;
}

/**
 * A planned trip nobody closed: its date is more than `costco.tripExpireAfterDays` days past. The
 * daily cron closes it as `cancelled` (reason `expired`) — nothing blocks on a human, and an open
 * trip in the past would keep the weekly cart waiting for it.
 */
export function isTripExpired(plannedFor: string, now: string, config: Config): boolean {
  const today = localDate(now, config.householdTz);
  return today > addDays(plannedFor, config.costco.tripExpireAfterDays);
}

/** A trip a Costco receipt may belong to (planned or done, no receipt yet). */
export interface ReceiptTripCandidate {
  id: string;
  plannedFor: string;
  status: "planned" | "done" | "cancelled";
  receiptId: string | null;
}

/**
 * M10.3: the trip a Costco **warehouse** receipt acquired at `acquiredAt` belongs to: a planned or
 * done trip without a receipt whose date is on or up to `costco.tripReceiptWindowDays` before the
 * receipt's household-local date; the latest such trip if several. Null when none fits (an
 * unplanned Costco run is just a receipt).
 */
export function tripForReceipt(
  trips: readonly ReceiptTripCandidate[],
  acquiredAt: string,
  config: Config,
): ReceiptTripCandidate | null {
  const day = localDate(acquiredAt, config.householdTz);
  const earliest = addDays(day, -config.costco.tripReceiptWindowDays);
  const fits = trips.filter(
    (t) =>
      t.status !== "cancelled" &&
      t.receiptId === null &&
      t.plannedFor <= day &&
      t.plannedFor >= earliest,
  );
  return fits.sort((a, b) => b.plannedFor.localeCompare(a.plannedFor))[0] ?? null;
}

export interface TripListEntry extends CostcoListLine {
  itemId: string;
  product: ProductCandidate;
  choice: StoreChoice;
  runoutAt: string | null;
}

const REASON_RANK: Record<CostcoListLine["reason"], number> = {
  critical: 0,
  consumed: 0,
  runout: 1,
  static_threshold: 2,
};

/**
 * The list for a trip on `tripDate`: every item whose store is Costco (`chooseStore`) and that
 * `costcoListLine` puts on the list. Flagged items first, then soonest runout.
 */
export function costcoTripList(input: {
  items: readonly PlanItemInput[];
  tripDate: string;
  quotes?: Readonly<Record<string, number>>;
  now: string;
  config: Config;
}): TripListEntry[] {
  const { items, tripDate, quotes, now, config } = input;
  const out: TripListEntry[] = [];
  for (const i of items) {
    const choice = chooseStore({
      item: i.item,
      baseUnit: i.baseUnit,
      products: i.products,
      quotes,
      switchThreshold: i.switchThreshold,
      pin: i.storePin ?? null,
      freezesBulk: false, // learned in M10.4
      config,
    });
    if (choice.store !== "costco" || choice.costco === null) continue;
    const line = costcoListLine({
      item: i.item,
      estimate: i.estimate,
      product: choice.costco,
      tripDate,
      freezesBulk: false,
      now,
      config,
    });
    if (line === null) continue;
    out.push({
      ...line,
      itemId: i.itemId,
      product: choice.costco,
      choice,
      runoutAt: i.estimate.runoutAt,
    });
  }
  return out.sort(
    (a, b) =>
      REASON_RANK[a.reason] - REASON_RANK[b.reason] ||
      (a.runoutAt ?? "9999").localeCompare(b.runoutAt ?? "9999") ||
      a.itemId.localeCompare(b.itemId),
  );
}
