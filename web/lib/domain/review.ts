// DESIGN §4.6 — review expiry defaults, impact score and trust.
import type { Config, ReviewKindForExpiry } from "../config";
import { addDaysToInstant, daysBetween } from "./time";

export type ReviewKind = ReviewKindForExpiry;
export type ReviewStatus = "pending" | "confirmed" | "corrected" | "dismissed" | "expired";

/** `review_item.default_action`: what happens if nobody answers. */
export type DefaultAction =
  | { action: "drop_pending_lines" }
  | { action: "keep_auto_created" }
  | { action: "none" }
  | { action: "dismiss" }
  | { action: "stay_unverified" };

const DEFAULT_ACTIONS: Record<ReviewKind, DefaultAction> = {
  receipt: { action: "drop_pending_lines" },
  new_product: { action: "keep_auto_created" },
  merge_suggestion: { action: "none" },
  unverified_item: { action: "stay_unverified" },
  failed_job: { action: "dismiss" },
  trash_cam: { action: "none" },
};

export const defaultActionFor = (kind: ReviewKind): DefaultAction => DEFAULT_ACTIONS[kind];

/** `expires_at` for a new review item; null for kinds that never expire. */
export function reviewExpiresAt(
  kind: ReviewKind,
  createdAt: string,
  config: Config,
): string | null {
  const days = config.reviewExpiryDays[kind];
  return days === null ? null : addDaysToInstant(createdAt, days);
}

export interface ImpactFlags {
  /** The review's item is in the current cart plan. */
  inCartPlan: boolean;
  /** The review's item is on the cycle's please-check list. */
  inPleaseCheck: boolean;
}

/** §4.6: 10 if in the cart plan, + 3 if on please-check; 1 if neither. Cleanup sorts by it. */
export function impactScore(flags: ImpactFlags, config: Config): number {
  const { inCartPlan, inPleaseCheck, otherwise } = config.impact;
  const score = (flags.inCartPlan ? inCartPlan : 0) + (flags.inPleaseCheck ? inPleaseCheck : 0);
  return score > 0 ? score : otherwise;
}

/** Reviews touching this week's cart surface in This Week; the rest wait in Cleanup. */
export const urgencyFor = (flags: ImpactFlags): "this_week" | "cleanup" =>
  flags.inCartPlan || flags.inPleaseCheck ? "this_week" : "cleanup";

/** Every derived column of a new `review_item`. */
export function newReview(kind: ReviewKind, createdAt: string, flags: ImpactFlags, config: Config) {
  return {
    kind,
    status: "pending" as const,
    defaultAction: defaultActionFor(kind),
    expiresAt: reviewExpiresAt(kind, createdAt, config),
    impactScore: impactScore(flags, config),
    urgency: urgencyFor(flags),
  };
}

/** Review kinds about one item: their impact follows that item's place in the current plan. */
export const ITEM_REVIEW_KINDS = ["new_product", "unverified_item", "merge_suggestion"] as const;
const isItemReviewKind = (k: ReviewKind): boolean =>
  (ITEM_REVIEW_KINDS as readonly string[]).includes(k);

export interface ScoredReview {
  id: string;
  kind: ReviewKind;
  itemId: string | null;
  impactScore: number;
  urgency: "this_week" | "cleanup";
}

/**
 * §4.6: a review's impact is set when it is created, but an import creates its item reviews before
 * any cart plan exists. Re-score pending item reviews against the current plan (cart lines and
 * please-check ids); returns only the reviews whose score or urgency changes. Receipt reviews keep
 * theirs (they are about a receipt's lines, scored at ingest).
 */
export function reprioritize(
  reviews: readonly ScoredReview[],
  plan: { cart: ReadonlySet<string>; pleaseCheck: ReadonlySet<string> },
  config: Config,
): { id: string; impactScore: number; urgency: "this_week" | "cleanup" }[] {
  return reviews.flatMap((r) => {
    if (!isItemReviewKind(r.kind) || r.itemId === null) return [];
    const flags = {
      inCartPlan: plan.cart.has(r.itemId),
      inPleaseCheck: plan.pleaseCheck.has(r.itemId),
    };
    const next = { impactScore: impactScore(flags, config), urgency: urgencyFor(flags) };
    return next.impactScore === r.impactScore && next.urgency === r.urgency
      ? []
      : [{ id: r.id, ...next }];
  });
}

/**
 * A `new_product` review Cleanup leaves out (§4.6): its item has no usage rate (`static`, so the
 * plan never orders it) and it doesn't touch this week's cart. Most of a backfill's products are
 * bought once; confirming them changes nothing. It stays pending and expires to its default (keep).
 */
export const isOneTimeBuy = (
  r: Pick<ScoredReview, "kind" | "urgency">,
  trackingType: "velocity" | "static" | null,
): boolean => r.kind === "new_product" && r.urgency === "cleanup" && trackingType === "static";

export interface ReviewRow {
  id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  expiresAt: string | null;
}

/** The daily cron's expiries: pending reviews past `expires_at`, with the default to apply. */
export function dueExpiries(
  reviews: readonly ReviewRow[],
  now: string,
): { id: string; kind: ReviewKind; status: "expired"; apply: DefaultAction }[] {
  return reviews
    .filter(
      (r) => r.status === "pending" && r.expiresAt !== null && daysBetween(r.expiresAt, now) >= 0,
    )
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      status: "expired" as const,
      apply: defaultActionFor(r.kind),
    }));
}

/**
 * Only human answers become training signal (PRD §3.3): a `labeled_observation` may be written
 * only for a `confirmed` / `corrected` review answered by a member.
 */
export const mayCreateLabel = (status: ReviewStatus, reviewedByMemberId: string | null): boolean =>
  (status === "confirmed" || status === "corrected") && reviewedByMemberId !== null;

/** Trust of a provisional inventory event after its review resolves. */
export function trustAfterReview(outcome: "confirmed" | "corrected" | "expired"): {
  original: "confirmed" | "expired" | "provisional";
  writeCorrected: boolean;
} {
  switch (outcome) {
    case "confirmed":
      return { original: "confirmed", writeCorrected: false };
    case "corrected":
      // The wrong event is reversed (trust expired → ignored by the projection) and the
      // corrected one is applied as confirmed.
      return { original: "expired", writeCorrected: true };
    case "expired":
      return { original: "provisional", writeCorrected: false };
  }
}
