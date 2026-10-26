// PRD §4.4 — "Do we have X?": item search and an honest, short answer.
import type { Config } from "../config";
import type { Estimate } from "./inventory";
import { normalizeReceiptText, ratio, tokenSetRatio, type CanonicalItem } from "./matching";
import { daysBetween, localDate } from "./time";

/** Items whose canonical name matches `q`, best first (token-set score, ties on plain ratio). */
export function searchItems(
  q: string,
  items: readonly CanonicalItem[],
  config: Config,
): { id: string; score: number }[] {
  const query = normalizeReceiptText(q);
  if (!query) return [];
  return items
    .map((i) => {
      const name = normalizeReceiptText(i.canonicalName);
      return { id: i.id, score: tokenSetRatio(query, name), tie: ratio(query, name) };
    })
    .filter((x) => x.score >= config.lookup.minScore)
    .sort((a, b) => b.score - a.score || b.tie - a.tie || a.id.localeCompare(b.id))
    .slice(0, config.lookup.maxResults)
    .map(({ id, score }) => ({ id, score }));
}

export type NameMatch = "confident" | "possible";

/**
 * Per hit (best first): `confident` when it is the top hit, scores ≥ `lookup.confidentScore` and
 * leads the next hit by ≥ `lookup.confidentLead` — the agent may act on it ("skip bananas");
 * otherwise `possible` (free text, or one clarifying question). Independent of the estimate's
 * confidence.
 */
export function nameMatch(hits: readonly { score: number }[], config: Config): NameMatch[] {
  const [top, next] = hits;
  const confident =
    top !== undefined &&
    top.score >= config.lookup.confidentScore &&
    (next === undefined || top.score - next.score >= config.lookup.confidentLead);
  return hits.map((_, i) => (i === 0 && confident ? "confident" : "possible"));
}

export type LookupConfidence = "high" | "medium" | "low";

export interface LookupInput {
  name: string;
  estimate: Pick<Estimate, "onHand" | "status">;
  /** Latest non-expired `acquired` event. */
  lastAcquired: { at: string; trust: "confirmed" | "provisional" } | null;
  /** Latest count (`observed` with a quantity) across locations. */
  lastVerifiedAt: string | null;
  now: string;
  config: Config;
}

const VERDICT: Record<Estimate["status"], string> = {
  stocked: "probably fine",
  low: "running low",
  out: "probably out",
  unknown: "no record",
  critical: "flagged as running out",
  consumed: "marked as finished",
};

const shortDate = (iso: string, tz: string): string => {
  const [y, m, d] = localDate(iso, tz).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

/**
 * One-line answer with a confidence hint, e.g. `~2 milk (bought Oct 12, unverified) → probably
 * fine`. A recent count is high confidence; a confirmed purchase medium; a provisional purchase or
 * no history low.
 */
export function lookupAnswer(input: LookupInput): { confidence: LookupConfidence; text: string } {
  const { estimate, lastAcquired, lastVerifiedAt, now, config } = input;
  const tz = config.householdTz;
  const verifiedFirst =
    lastVerifiedAt !== null && (!lastAcquired || lastVerifiedAt >= lastAcquired.at);
  let confidence: LookupConfidence = "low";
  let basis = "";
  if (verifiedFirst) {
    basis = `counted ${shortDate(lastVerifiedAt, tz)}`;
    confidence =
      daysBetween(lastVerifiedAt, now) <= config.lookup.freshVerifiedDays ? "high" : "medium";
  } else if (lastAcquired) {
    const unverified = lastAcquired.trust === "provisional";
    basis = `bought ${shortDate(lastAcquired.at, tz)}${unverified ? ", unverified" : ""}`;
    confidence = unverified ? "low" : "medium";
  }
  const qty = Math.round(estimate.onHand * 10) / 10;
  const amount = estimate.status === "unknown" ? "" : `~${qty} `;
  const text = `${amount}${input.name.toLowerCase()}${basis ? ` (${basis})` : ""} → ${VERDICT[estimate.status]}`;
  return { confidence, text };
}
