// DESIGN §5 — media job leases, retries, and turning worker results into domain input.
import type { Config } from "../config";
import { matchPaperLine, type CanonicalItem } from "./matching";
import type { ReceiptInput } from "./receipts";
import { addDaysToInstant, daysBetween, zonedToUtc } from "./time";

export type JobStatus = "queued" | "claimed" | "completed" | "failed";

/** `lease_expires_at` for a job claimed at `claimedAt`. */
export const leaseExpiresAt = (claimedAt: string, config: Config): string =>
  addDaysToInstant(claimedAt, config.jobs.leaseMinutes / (24 * 60));

/** A claimed job whose lease has run out goes back to `queued` (§5 step 4). */
export const isLeaseExpired = (
  job: { status: JobStatus; leaseExpiresAt: string | null },
  now: string,
): boolean =>
  job.status === "claimed" &&
  job.leaseExpiresAt !== null &&
  daysBetween(job.leaseExpiresAt, now) >= 0;

/** After a failed attempt: try again, or give up (→ `failed` + a `failed_job` review). */
export const failureOutcome = (attempts: number, config: Config): "retry" | "failed" =>
  attempts >= config.jobs.maxAttempts ? "failed" : "retry";

// --- paper receipts -----------------------------------------------------------------------------

/** The worker's transcription (§5 paper receipt prompt contract), money in cents. */
export interface PaperReceiptResult {
  store: string;
  /** Household-local `YYYY-MM-DD`. */
  date: string;
  lines: {
    rawText: string;
    qty: number | null;
    unitPriceCents: number | null;
    lineTotalCents: number | null;
  }[];
  subtotalCents: number | null;
  totalCents: number | null;
}

const STORE_NOISE = new Set(["the", "market", "markets", "store", "stores", "inc", "co", "llc"]);

/** Vendor slug of a printed store name: "WHOLE FOODS MARKET" → `wholefoods`. */
export function vendorSlug(store: string): string {
  const words = store
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STORE_NOISE.has(w));
  return words.join("") || "unknown";
}

/** A paper-receipt job result as `applyReceipt` input. Acquired at local noon on the receipt date. */
export function paperReceiptInput(result: PaperReceiptResult, tz: string): ReceiptInput {
  return {
    source: "paper",
    vendor: vendorSlug(result.store),
    accountMemberId: null,
    externalOrderId: null,
    fulfillment: "in_store",
    orderedAt: null,
    acquiredAt: zonedToUtc(result.date, 12, 0, tz),
    subtotalCents: result.subtotalCents,
    totalCents: result.totalCents,
    lines: result.lines.map((l) => ({
      rawText: l.rawText,
      asin: null,
      qty: l.qty ?? 1,
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.lineTotalCents,
    })),
  };
}

// --- trash cam ----------------------------------------------------------------------------------

export interface TrashCamDetection {
  name: string;
  confidence: number;
}

export type TrashCamOutcome =
  /** Log a provisional `consumed` event for the item. */
  | { action: "consume"; itemId: string; detection: TrashCamDetection; score: number }
  /** Low confidence or unresolved: a `trash_cam` review item. */
  | {
      action: "review";
      detection: TrashCamDetection | null;
      itemId: string | null;
      score: number;
    };

/**
 * §5 step 5: the most confident detection is applied when its confidence is at least
 * `trashCam.applyConfidence` and its name resolves to an item (same fuzzy rule as paper lines).
 */
export function resolveTrashCam(
  detections: readonly TrashCamDetection[],
  items: readonly CanonicalItem[],
  config: Config,
): TrashCamOutcome {
  const top = [...detections].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  if (!top) return { action: "review", detection: null, itemId: null, score: 0 };
  const m = matchPaperLine({ rawText: top.name, vendor: "", aliases: [], items, config });
  const itemId = m.kind === "exact" || m.kind === "fuzzy" ? m.itemId : null;
  const score =
    m.kind === "exact" || m.kind === "fuzzy" ? m.score : m.kind === "none" ? m.bestScore : 0;
  if (itemId && top.confidence >= config.trashCam.applyConfidence) {
    return { action: "consume", itemId, detection: top, score };
  }
  return {
    action: "review",
    detection: top,
    itemId: itemId ?? (m.kind === "none" ? m.bestItemId : null),
    score,
  };
}
