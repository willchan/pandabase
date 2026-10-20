// Insights page read model (PRD §4.6): a few diagnostics metrics per ISO week, for charts. The full
// weekly Markdown report (`renderWeekly`) sits under them.
import { receiptLine, reviewItem, systemTelemetry } from "@pandabase/db";
import { and, gte, inArray, lt } from "drizzle-orm";
import type { Config } from "../config";
import { addDays, isoWeekLabel, localDate } from "../domain/time";
import { asRecord, type Q } from "../repo/db";
import { weekRange } from "./weekly";

export interface WeekInsight {
  week: string;
  /** Receipt lines created that week (ignored lines excluded). */
  lines: { auto: number; human: number; provisional: number; pending: number };
  reviews: { answered: number; expired: number };
  cart: { tier1: number; tier2: number; failed: number };
  /** Mean |estimated − counted| over that week's counts, or null without counts. */
  estimateError: number | null;
  overbuys: number;
}

export async function weeklyInsights(
  q: Q,
  ctx: { now: string; config: Config },
  weeks = 8,
): Promise<WeekInsight[]> {
  const tz = ctx.config.householdTz;
  const labels = Array.from({ length: weeks }, (_, i) =>
    isoWeekLabel(addDays(localDate(ctx.now, tz), -7 * (weeks - 1 - i))),
  );
  const start = weekRange(labels[0]!, tz).start;
  const end = weekRange(labels.at(-1)!, tz).end;
  const weekOf = (iso: string) =>
    labels.find((w) => {
      const r = weekRange(w, tz);
      return iso >= r.start && iso < r.end;
    });

  const out = new Map<string, WeekInsight>(
    labels.map((week) => [
      week,
      {
        week,
        lines: { auto: 0, human: 0, provisional: 0, pending: 0 },
        reviews: { answered: 0, expired: 0 },
        cart: { tier1: 0, tier2: 0, failed: 0 },
        estimateError: null,
        overbuys: 0,
      },
    ]),
  );

  const lines = await q
    .select()
    .from(receiptLine)
    .where(and(gte(receiptLine.createdAt, start), lt(receiptLine.createdAt, end)));
  for (const l of lines) {
    const w = weekOf(l.createdAt);
    if (!w || l.ignored) continue;
    const bucket = out.get(w)!.lines;
    if (l.itemId === null) bucket.pending++;
    else if (l.trust !== "confirmed") bucket.provisional++;
    else if (l.matchMethod === "manual") bucket.human++;
    else bucket.auto++;
  }

  const reviews = await q
    .select({
      status: reviewItem.status,
      reviewedAt: reviewItem.reviewedAt,
      updatedAt: reviewItem.updatedAt,
    })
    .from(reviewItem)
    .where(inArray(reviewItem.status, ["confirmed", "corrected", "dismissed", "expired"]));
  for (const r of reviews) {
    const w = weekOf(r.status === "expired" ? r.updatedAt : (r.reviewedAt ?? r.updatedAt));
    if (!w) continue;
    if (r.status === "expired") out.get(w)!.reviews.expired++;
    else out.get(w)!.reviews.answered++;
  }

  const tel = await q
    .select()
    .from(systemTelemetry)
    .where(
      and(
        gte(systemTelemetry.createdAt, start),
        lt(systemTelemetry.createdAt, end),
        inArray(systemTelemetry.metricType, [
          "cart_line_result",
          "estimate_vs_observed",
          "overbuy",
        ]),
      ),
    );
  const errors = new Map<string, number[]>();
  for (const t of tel) {
    const w = weekOf(t.createdAt);
    if (!w) continue;
    const p = asRecord(t.payload);
    const row = out.get(w)!;
    if (t.metricType === "overbuy") row.overbuys++;
    else if (t.metricType === "cart_line_result") {
      if (p.outcome === "tier1" || p.outcome === "tier2" || p.outcome === "failed")
        row.cart[p.outcome]++;
    } else if (typeof p.estimated === "number" && typeof p.observed === "number") {
      errors.set(w, [...(errors.get(w) ?? []), Math.abs(p.estimated - p.observed)]);
    }
  }
  for (const [w, errs] of errors) {
    out.get(w)!.estimateError = errs.reduce((a, b) => a + b, 0) / errs.length;
  }
  return labels.map((w) => out.get(w)!);
}
