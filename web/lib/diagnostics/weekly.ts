// Weekly diagnostics report (DESIGN §7): Markdown with fixed sections — each *metrics → notable
// examples → suggested investigation* — plus JSONL extracts. Pure reads; deterministic for a
// given database and week (rows are ordered, numbers are fixed-precision).
import {
  auditJob,
  item,
  labeledObservation,
  preferenceEvent,
  receipt,
  receiptLine,
  reviewItem,
  systemTelemetry,
} from "@pandabase/db";
import { and, asc, gte, inArray, lt } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Config } from "../config";
import { addDays, dateInIsoWeek, isoWeekLabel, localDate, zonedToUtc } from "../domain/time";
import { asRecord, type Q } from "../repo/db";

export interface WeeklyReport {
  week: string;
  markdown: string;
  extracts: { name: string; jsonl: string }[];
}

type Row = Record<string, unknown>;
type Telemetry = { source: string; metric: string; at: string; p: Row };

/** The last complete ISO week (household TZ) before `now`. */
export const lastCompleteWeek = (now: string, tz: string): string =>
  isoWeekLabel(addDays(localDate(now, tz), -7));

export function weekRange(week: string, tz: string): { start: string; end: string } {
  const monday = dateInIsoWeek(week, 1);
  return { start: zonedToUtc(monday, 0, 0, tz), end: zonedToUtc(addDays(monday, 7), 0, 0, tz) };
}

// --- formatting ---------------------------------------------------------------------------------

const num = (x: number, digits = 2): string =>
  Number.isFinite(x)
    ? x
        .toFixed(digits)
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "")
    : "–";
const pct = (n: number, d: number): string => (d === 0 ? "–" : `${Math.round((100 * n) / d)}%`);
const cell = (v: unknown): string => String(v ?? "–").replaceAll("|", "\\|").replaceAll("\n", " ");

function table(headers: string[], rows: unknown[][]): string {
  if (rows.length === 0) return "_No data._";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

const bullets = (items: string[], empty = "_None._"): string =>
  items.length ? items.map((i) => `- ${i}`).join("\n") : empty;

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? NaN));
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

function countBy<T>(rows: readonly T[], key: (r: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function section(title: string, metrics: string, examples: string, investigate: string[]) {
  return [
    `## ${title}`,
    "",
    "### Metrics",
    "",
    metrics,
    "",
    "### Notable examples",
    "",
    examples,
    "",
    "### Suggested investigation",
    "",
    bullets(investigate, "_Nothing stands out._"),
  ].join("\n");
}

// --- report -------------------------------------------------------------------------------------

export async function renderWeekly(
  q: Q,
  week: string,
  ctx: { now: string; config: Config },
): Promise<WeeklyReport> {
  const { config } = ctx;
  const tz = config.householdTz;
  const { start, end } = weekRange(week, tz);
  const inWeek = (col: SQLiteColumn) => and(gte(col, start), lt(col, end));

  const telemetry: Telemetry[] = (
    await q
      .select()
      .from(systemTelemetry)
      .where(inWeek(systemTelemetry.createdAt))
      .orderBy(asc(systemTelemetry.createdAt), asc(systemTelemetry.id))
  ).map((t) => ({ source: t.source, metric: t.metricType, at: t.createdAt, p: asRecord(t.payload) }));
  const metric = (...names: string[]) => telemetry.filter((t) => names.includes(t.metric));

  const items = new Map(
    (await q.select({ id: item.id, name: item.canonicalName }).from(item)).map((i) => [i.id, i.name]),
  );
  const itemName = (p: Row): string =>
    s(p.item) ?? (s(p.itemId) ? (items.get(s(p.itemId)!) ?? s(p.itemId)!) : "?");

  const findings: { score: number; text: string }[] = [];
  const extracts: Record<string, Row[]> = {
    "velocity.jsonl": [],
    "receipt_lines.jsonl": [],
    "vlm.jsonl": [],
    "product_choice.jsonl": [],
    "cart_injection.jsonl": [],
    "ux.jsonl": [],
  };

  // 2. Velocity --------------------------------------------------------------------------------
  const velocityMetrics = [
    "ema_updated",
    "ema_outlier_rejected",
    "ema_outlier_accepted",
    "ema_skipped",
    "promoted_to_velocity",
    "overbuy",
    "estimate_vs_observed",
    "presumed_discarded",
  ];
  const velocity = metric(...velocityMetrics);
  extracts["velocity.jsonl"] = velocity.map((t) => ({ at: t.at, metric: t.metric, item: itemName(t.p), ...t.p }));
  const evo = metric("estimate_vs_observed");
  const evoByItem = new Map<string, number[]>();
  for (const t of evo) {
    const err = n(t.p.estimated) - n(t.p.observed);
    if (Number.isFinite(err)) evoByItem.set(itemName(t.p), [...(evoByItem.get(itemName(t.p)) ?? []), err]);
  }
  const evoRows = [...evoByItem.entries()]
    .map(([name, errs]) => ({
      name,
      count: errs.length,
      mae: errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length,
      bias: errs.reduce((a, e) => a + e, 0) / errs.length,
    }))
    .sort((a, b) => b.mae - a.mae || a.name.localeCompare(b.name));
  const overbuys = metric("overbuy");
  const outliers = metric("ema_outlier_rejected", "ema_outlier_accepted");
  if (overbuys.length) {
    findings.push({
      score: 2,
      text: `${overbuys.length} overbuy(s) (${[...new Set(overbuys.map((t) => itemName(t.p)))].slice(0, 3).join(", ")}).`,
    });
  }
  const worstEvo = evoRows[0];
  if (worstEvo && worstEvo.mae >= 2) {
    findings.push({
      score: 2,
      text: `Estimate vs count is off by ${num(worstEvo.mae, 1)} on average for ${worstEvo.name}.`,
    });
  }
  const velocitySection = section(
    "2. Velocity",
    [
      table(
        ["Metric", "Count"],
        velocityMetrics.map((m) => [m, metric(m).length]),
      ),
      "",
      "Estimate vs observed (error = estimated − counted, base units):",
      "",
      table(
        ["Item", "Counts", "Mean abs error", "Bias"],
        evoRows.slice(0, 10).map((r) => [r.name, r.count, num(r.mae), num(r.bias)]),
      ),
    ].join("\n"),
    bullets([
      ...overbuys
        .slice(0, 5)
        .map(
          (t) =>
            `Overbuy: ${itemName(t.p)} — ${num(n(t.p.onHandBefore ?? t.p.on_hand_before))} on hand` +
            (t.p.daysOfStock ?? t.p.days_of_stock
              ? ` (~${num(n(t.p.daysOfStock ?? t.p.days_of_stock), 0)} days of stock)`
              : ""),
        ),
      ...outliers
        .slice(0, 5)
        .map(
          (t) =>
            `${t.metric === "ema_outlier_accepted" ? "Habit change accepted" : "Outlier rejected"}: ${itemName(t.p)} — observed ${num(n(t.p.observedDays ?? t.p.observed))} d/unit vs EMA ${num(n(t.p.emaDays ?? t.p.ema))}`,
        ),
    ]),
    [
      ...evoRows
        .filter((r) => r.mae >= 2)
        .slice(0, 3)
        .map((r) => `${r.name}: estimates ${r.bias > 0 ? "high" : "low"} by ~${num(Math.abs(r.bias), 1)} — check its EMA / shelf life.`),
      ...(overbuys.length >= 3 ? ["Several overbuys — is the cart quantity (cartCoverDays) too generous?"] : []),
      ...(outliers.length >= 3 ? ["Many EMA outliers — check unit quantities of recently bought products."] : []),
    ],
  );

  // 3. Receipt matching --------------------------------------------------------------------------
  const receipts = await q.select().from(receipt).where(inWeek(receipt.createdAt)).orderBy(asc(receipt.createdAt), asc(receipt.id));
  const receiptIds = receipts.map((r) => r.id);
  const lines = receiptIds.length
    ? await q.select().from(receiptLine).where(inArray(receiptLine.receiptId, receiptIds)).orderBy(asc(receiptLine.id))
    : [];
  const byReceipt = new Map(receipts.map((r) => [r.id, r]));
  const lineClass = (l: (typeof lines)[number]) =>
    l.ignored
      ? "ignored"
      : l.itemId === null
        ? "pending"
        : l.matchMethod === "fuzzy" && l.trust !== "confirmed"
          ? "provisional"
          : "auto";
  extracts["receipt_lines.jsonl"] = lines.map((l) => {
    const r = byReceipt.get(l.receiptId)!;
    return {
      receipt_id: l.receiptId,
      source: r.source,
      vendor: r.vendor,
      raw_text: l.rawText,
      item: l.itemId ? (items.get(l.itemId) ?? l.itemId) : null,
      match_method: l.matchMethod,
      match_score: l.matchScore,
      trust: l.trust,
      class: lineClass(l),
    };
  });
  const expiredReviews = metric("review_expired");
  const expiredReceiptReviews = expiredReviews.filter((t) => t.p.kind === "receipt").length;
  const storeKeys = [...new Set(receipts.map((r) => `${r.source}:${r.vendor}`))].sort();
  const storeRows = storeKeys.map((k) => {
    const mine = lines.filter((l) => {
      const r = byReceipt.get(l.receiptId)!;
      return `${r.source}:${r.vendor}` === k && !l.ignored;
    });
    const c = (cls: string) => mine.filter((l) => lineClass(l) === cls).length;
    return [k, mine.length, pct(c("auto"), mine.length), pct(c("provisional"), mine.length), pct(c("pending"), mine.length)];
  });
  const paper = lines.filter((l) => byReceipt.get(l.receiptId)!.source === "paper" && !l.ignored);
  const paperExact = paper.filter((l) => l.matchMethod === "alias_exact").length;
  if (paper.length >= 5 && paperExact / paper.length < 0.7) {
    findings.push({
      score: 3,
      text: `Paper receipts: ${pct(paperExact, paper.length)} of lines matched an exact alias (target ≥ 70%).`,
    });
  }
  const pendingLines = lines.filter((l) => lineClass(l) === "pending");
  if (pendingLines.length) {
    findings.push({ score: 2, text: `${pendingLines.length} receipt line(s) unmatched, waiting in review.` });
  }
  const weakFuzzy = lines
    .filter((l) => lineClass(l) === "provisional")
    .sort((a, b) => (a.matchScore ?? 0) - (b.matchScore ?? 0) || a.id.localeCompare(b.id));
  // Suggested merges (§4.5): jobs queued, reviews created (and why suggestions were dropped), and
  // what humans did with them (`review_resolved` / `review_expired` of kind merge_suggestion).
  const mergeRequests = metric("merge_suggest_requested");
  const mergeCreated = metric("merge_suggestions_created");
  const sum = (rows: Telemetry[], key: string) => rows.reduce((a, t) => a + (Number.isFinite(n(t.p[key])) ? n(t.p[key]) : 0), 0);
  const mergeJobs = mergeRequests.reduce((a, t) => a + (Array.isArray(t.p.jobIds) ? t.p.jobIds.length : 0), 0);
  const mergeAnswers = metric("review_resolved").filter((t) => t.p.kind === "merge_suggestion");
  const mergeAnswered = mergeAnswers.length;
  const mergeOutcome = (o: string) => mergeAnswers.filter((t) => t.p.outcome === o).length;
  const mergeDropped = ["duplicate", "low_confidence", "merged", "self", "unknown", "both_confirmed"]
    .map((r) => `${r} ${sum(mergeCreated, r)}`)
    .filter((x) => !x.endsWith(" 0"));
  const mergeRows = [
    ["Runs (jobs)", `${mergeRequests.length} (${mergeJobs})${mergeRequests.length ? ` — ${countBy(mergeRequests, (t) => s(t.p.trigger) ?? "?").map(([k, c]) => `${k} ${c}`).join(", ")}` : ""}`],
    ["Suggestions from the model", sum(mergeCreated, "suggestions")],
    ["Reviews created", sum(mergeCreated, "created")],
    ["Dropped", mergeDropped.join(", ") || 0],
    ["Accepted (merged as suggested)", mergeOutcome("confirmed")],
    ["Merged into another item", mergeOutcome("corrected")],
    ["Dismissed (not the same)", mergeOutcome("dismissed")],
    ["Expired unanswered", expiredReviews.filter((t) => t.p.kind === "merge_suggestion").length],
  ];
  const mergesRejected = mergeAnswered >= 5 && mergeOutcome("confirmed") / mergeAnswered < 0.5;
  if (mergesRejected) {
    findings.push({
      score: 1,
      text: `Suggested merges: only ${pct(mergeOutcome("confirmed"), mergeAnswered)} of ${mergeAnswered} answered were accepted.`,
    });
  }
  const receiptSection = section(
    "3. Receipt matching",
    [
      table(["Source:store", "Lines", "Auto", "Provisional", "Pending"], storeRows),
      "",
      `Paper lines matched by exact alias: ${pct(paperExact, paper.length)} (${paperExact}/${paper.length}). ` +
        `Receipt reviews expired this week: ${expiredReceiptReviews}.`,
      "",
      "Suggested merges:",
      "",
      table(["Merges", "Count"], mergeRows),
    ].join("\n"),
    bullets([
      ...pendingLines.slice(0, 5).map((l) => `Pending: \`${l.rawText}\` (${byReceipt.get(l.receiptId)!.vendor})`),
      ...weakFuzzy
        .slice(0, 5)
        .map(
          (l) =>
            `Weakest fuzzy: \`${l.rawText}\` → ${items.get(l.itemId!) ?? l.itemId} (${num(l.matchScore ?? 0)})`,
        ),
    ]),
    [
      ...(pendingLines.length ? ["Add aliases for the pending lines above (confirm them in Cleanup)."] : []),
      ...(mergesRejected
        ? ["Mostly dismissed merge suggestions: raise `mergeSuggest.minConfidence` or tighten the merge_suggest prompt (new version)."]
        : []),
      ...(weakFuzzy.length ? ["Check the weakest fuzzy matches; consider raising `matching.fuzzyApplyThreshold` if any are wrong."] : []),
    ],
  );

  // 4. VLM ----------------------------------------------------------------------------------------
  const vlm = metric("vlm_inference", "vlm_parse_failure");
  const jobsDone = await q
    .select()
    .from(auditJob)
    .where(inWeek(auditJob.createdAt))
    .orderBy(asc(auditJob.createdAt), asc(auditJob.id));
  extracts["vlm.jsonl"] = [
    ...vlm.map((t) => ({ at: t.at, metric: t.metric, ...t.p })),
    ...metric("worker_heartbeat", "merge_suggest_requested", "merge_suggestions_created").map((t) => ({ at: t.at, metric: t.metric, ...t.p })),
    ...jobsDone.map((j) => ({
      job_id: j.id,
      job_type: j.jobType,
      status: j.status,
      model: j.model,
      prompt_version: j.promptVersion,
      attempts: j.attempts,
      error: j.error,
      keyframe_r2_keys: j.keyframeR2Keys ?? [],
    })),
  ];
  const latencies = metric("vlm_inference")
    .map((t) => n(t.p.latency_ms))
    .filter(Number.isFinite);
  const parseFailures = vlm.filter((t) => t.metric === "vlm_parse_failure" || t.p.parse_failure === true).length;
  const totalsFailed =
    metric("job_finished").filter((t) => t.p.workerTotalsCheck === "fail").length +
    metric("vlm_inference").filter((t) => t.p.totals_check === "fail").length;
  const jobIds = jobsDone.map((j) => j.id);
  const jobReviews = jobIds.length
    ? await q.select().from(reviewItem).where(inArray(reviewItem.jobId, jobIds)).orderBy(asc(reviewItem.id))
    : [];
  const labels = jobIds.length
    ? await q.select().from(labeledObservation).where(inArray(labeledObservation.jobId, jobIds))
    : [];
  const modelKeys = [...new Set(jobsDone.filter((j) => j.model).map((j) => `${j.model} × ${j.promptVersion ?? "?"}`))].sort();
  const modelRows = modelKeys.map((k) => {
    const mine = jobsDone.filter((j) => `${j.model} × ${j.promptVersion ?? "?"}` === k);
    const reviews = jobReviews.filter((r) => mine.some((j) => j.id === r.jobId));
    const answered = reviews.filter((r) => r.status === "confirmed" || r.status === "corrected");
    const corrected = reviews.filter((r) => r.status === "corrected");
    return [k, mine.length, mine.filter((j) => j.status === "failed").length, pct(corrected.length, answered.length)];
  });
  // Worker health: `worker_heartbeat` every 10 min (M6); a silence longer than
  // `diagnostics.workerGapMinutes` (from the week's start, between beats, or up to now) is downtime.
  const beats = metric("worker_heartbeat");
  const windowEnd = ctx.now < start ? start : ctx.now < end ? ctx.now : end;
  const marks = [start, ...beats.map((t) => t.at), windowEnd];
  const gaps = marks
    .slice(1)
    .map((to, i) => ({ from: marks[i]!, to, ms: Date.parse(to) - Date.parse(marks[i]!) }))
    .filter((g) => g.ms > config.diagnostics.workerGapMinutes * 60_000);
  extracts["vlm.jsonl"].push(...gaps.map((g) => ({ metric: "worker_gap", from: g.from, to: g.to, minutes: Math.round(g.ms / 60_000) })));
  const lastBeat = beats.at(-1);
  const workerModels = [...new Set(beats.map((t) => `${s(t.p.version) ?? "?"}: ${s(t.p.vlm_model) ?? "?"} / ${s(t.p.text_model) ?? "?"}`))];
  const ollamaDown = beats.filter((t) => t.p.ollama_ok === false).length;
  const hours = (ms: number) => `${num(ms / 3_600_000, 1)} h`;
  if (beats.length === 0) {
    findings.push({ score: 3, text: "The worker sent no heartbeat this week — photos and merge suggestions weren't processed." });
  } else if (gaps.length) {
    findings.push({
      score: 3,
      text: `The worker was silent ${gaps.length} time(s) for over ${config.diagnostics.workerGapMinutes} min (longest ${hours(Math.max(...gaps.map((g) => g.ms)))}).`,
    });
  }
  if (ollamaDown) findings.push({ score: 2, text: `The worker couldn't reach Ollama in ${ollamaDown} heartbeat(s).` });
  if (totalsFailed > 0) findings.push({ score: 3, text: `${totalsFailed} paper receipt(s) failed the totals check.` });
  const failedJobs = jobsDone.filter((j) => j.status === "failed");
  if (failedJobs.length) findings.push({ score: 2, text: `${failedJobs.length} media job(s) failed.` });
  const vlmSection = section(
    "4. VLM",
    [
      `Inference latency p50 / p95: ${latencies.length ? `${num(percentile(latencies, 50), 0)} ms / ${num(percentile(latencies, 95), 0)} ms` : "–"} (${latencies.length} calls). ` +
        `Parse failures: ${parseFailures}. Totals-check failures: ${totalsFailed}. Labels written: ${labels.length}.`,
      "",
      table(["Model × prompt", "Jobs", "Failed", "Human-correction rate"], modelRows),
      "",
      "Worker health:",
      "",
      table(
        ["Worker", "Value"],
        [
          ["Last heartbeat", lastBeat?.at ?? "none this week"],
          ["Heartbeats", beats.length],
          ["Version: VLM / text model", workerModels.join("; ") || "–"],
          ["ollama_ok (last)", lastBeat ? String(lastBeat.p.ollama_ok ?? "unchecked") : "–"],
          ["Heartbeats with Ollama down", ollamaDown],
          [`Gaps > ${config.diagnostics.workerGapMinutes} min`, gaps.length ? `${gaps.length} (${hours(gaps.reduce((a, g) => a + g.ms, 0))} total)` : 0],
        ],
      ),
    ].join("\n"),
    bullets([
      ...failedJobs.slice(0, 5).map((j) => `Failed ${j.jobType} ${j.id}: ${j.error ?? "?"} (${j.attempts} attempts)`),
      ...gaps.slice(0, 5).map((g) => `Worker silent ${g.from} → ${g.to} (${hours(g.ms)})`),
    ]),
    [
      ...(gaps.length ? ["Worker downtime: check the worker container's status and logs on the Mac Mini, and that it restarts."] : []),
      ...(ollamaDown ? ["Ollama unreachable from the worker: check that Ollama is running and both models are pulled."] : []),
      ...(parseFailures > 0 ? ["Parse failures: tighten the prompt's JSON instructions (new prompt version)."] : []),
      ...(latencies.length && percentile(latencies, 95) > 60_000 ? ["p95 latency over a minute — try a smaller VLM or lower image size."] : []),
    ],
  );

  // 5. Product choice ----------------------------------------------------------------------------
  const prefs = await q.select().from(preferenceEvent).where(inWeek(preferenceEvent.createdAt)).orderBy(asc(preferenceEvent.createdAt), asc(preferenceEvent.id));
  extracts["product_choice.jsonl"] = prefs.map((p) => ({
    at: p.createdAt,
    item: items.get(p.itemId) ?? p.itemId,
    kind: p.kind,
    from_product_id: p.fromProductId,
    to_product_id: p.toProductId,
    threshold_before: p.thresholdBefore,
    threshold_after: p.thresholdAfter,
    cycle_id: p.cycleId,
  }));
  const drift = new Map<string, { before: number; after: number }>();
  for (const p of prefs) {
    if (p.thresholdBefore === null || p.thresholdAfter === null) continue;
    const name = items.get(p.itemId) ?? p.itemId;
    const d = drift.get(name);
    drift.set(name, { before: d?.before ?? p.thresholdBefore, after: p.thresholdAfter });
  }
  const driftRows = [...drift.entries()]
    .filter(([, d]) => d.before !== d.after)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, d]) => [name, num(d.before), num(d.after)]);
  const overrides = prefs.filter((p) => p.kind.startsWith("override") || p.kind === "implicit_swap");
  if (overrides.length >= 3) findings.push({ score: 2, text: `${overrides.length} product overrides / swaps — the cart's choices were corrected often.` });
  const productSection = section(
    "5. Product choice",
    [
      table(["Event", "Count"], countBy(prefs, (p) => p.kind)),
      "",
      "Switch-threshold drift:",
      "",
      table(["Item", "Before", "After"], driftRows),
    ].join("\n"),
    bullets(
      overrides
        .slice(0, 5)
        .map((p) => `${p.kind}: ${items.get(p.itemId) ?? p.itemId} (${p.fromProductId ?? "?"} → ${p.toProductId ?? "?"})`),
    ),
    driftRows.length ? ["Thresholds moved — check the items above still pick the product we want."] : [],
  );

  // 6. Cart injection ----------------------------------------------------------------------------
  const cartLines = metric("cart_line_result");
  const toolErrors = metric("selector_error", "price_lookup_failed", "cart_tier1_line");
  extracts["cart_injection.jsonl"] = [...cartLines, ...toolErrors].map((t) => ({ at: t.at, metric: t.metric, source: t.source, ...t.p }));
  const outcomeCount = (o: string) => cartLines.filter((t) => t.p.outcome === o).length;
  const tier1 = outcomeCount("tier1");
  const failedCart = cartLines.filter((t) => t.p.outcome === "failed");
  if (cartLines.length && tier1 / cartLines.length < 0.9) {
    findings.push({ score: 4, text: `Tier-1 cart injection succeeded for ${pct(tier1, cartLines.length)} of lines (target ≥ 90%).` });
  }
  if (failedCart.length) findings.push({ score: 4, text: `${failedCart.length} cart line(s) failed to inject.` });
  const cartSection = section(
    "6. Cart injection",
    [
      table(
        ["Outcome", "Lines"],
        ["tier1", "tier2", "failed"].map((o) => [o, outcomeCount(o)]),
      ),
      "",
      `Tier-1 success: ${pct(tier1, cartLines.length)}. Tool errors: ${countBy(toolErrors, (t) => t.metric)
        .map(([m, c]) => `${m} ${c}`)
        .join(", ") || "none"}.`,
    ].join("\n"),
    bullets([
      ...failedCart.slice(0, 5).map((t) => `Failed: ${itemName(t.p)} — ${s(t.p.error) ?? "no error text"}`),
      ...metric("selector_error")
        .slice(0, 3)
        .map((t) => `Selector error: ${s(t.p.selector) ?? "?"} — ${s(t.p.error) ?? ""}`),
    ]),
    failedCart.length || metric("selector_error").length
      ? ["Check the cart tool's selectors / add-to-cart URL against the failures above."]
      : [],
  );

  // 7. UX friction -------------------------------------------------------------------------------
  const questions = metric("clarifying_question");
  // Photo intake: how the agent classified photos (caption / local description / default) and
  // how often a human re-filed one (the classifier's error signal).
  const photos = metric("photo_classified");
  const refiled = metric("photo_reclassified");
  const api = metric("api_request");
  const routeStats = countBy(api, (t) => s(t.p.route) ?? "?").map(([route]) => {
    const mine = api.filter((t) => t.p.route === route);
    const lat = mine.map((t) => n(t.p.latencyMs)).filter(Number.isFinite);
    return {
      route,
      count: mine.length,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      errors: mine.filter((t) => n(t.p.status) >= 500).length,
    };
  });
  const slow = routeStats.filter((r) => r.p95 > config.diagnostics.slowRouteMs);
  const answered = metric("review_resolved");
  const answeredRows = countBy(answered, (t) => s(t.p.kind) ?? "?").map(([kind]) => {
    const mine = answered.filter((t) => (s(t.p.kind) ?? "?") === kind);
    const outcome = (o: string) => mine.filter((t) => t.p.outcome === o).length;
    return [
      kind,
      outcome("confirmed"),
      outcome("corrected"),
      outcome("dismissed"),
      num(percentile(mine.map((t) => n(t.p.ageHours)).filter(Number.isFinite), 50), 1),
    ];
  });
  extracts["ux.jsonl"] = [
    ...expiredReviews.map((t) => ({ at: t.at, metric: t.metric, ...t.p })),
    ...answered.map((t) => ({ at: t.at, metric: t.metric, ...t.p })),
    ...questions.map((t) => ({ at: t.at, metric: t.metric, ...t.p })),
    ...[...photos, ...refiled].map((t) => ({ at: t.at, metric: t.metric, ...t.p })),
    ...routeStats.map((r) => ({ metric: "route_latency", ...r })),
  ];
  if (expiredReviews.length) findings.push({ score: 1, text: `${expiredReviews.length} review item(s) expired unanswered.` });
  if (slow.length) findings.push({ score: 1, text: `${slow.length} slow route(s) (p95 > ${config.diagnostics.slowRouteMs} ms).` });
  const errors = routeStats.filter((r) => r.errors > 0);
  if (errors.length) findings.push({ score: 3, text: `Server errors on ${errors.map((r) => r.route).join(", ")}.` });
  const uxSection = section(
    "7. UX friction",
    [
      table(["Expired review kind", "Count"], countBy(expiredReviews, (t) => s(t.p.kind) ?? "?")),
      "",
      table(["Answered review kind", "Confirmed", "Corrected", "Dismissed", "Median age h"], answeredRows),
      "",
      `Clarifying questions asked: ${questions.length}.`,
      "",
      `Photos classified: ${photos.length} (${
        countBy(photos, (t) => s(t.p.basis) ?? "?")
          .map(([b, c]) => `${b} ${c}`)
          .join(", ") || "none"
      }); re-filed by a human: ${refiled.length}.`,
      "",
      table(
        ["Route", "Requests", "p50 ms", "p95 ms", "5xx"],
        routeStats.map((r) => [r.route, r.count, num(r.p50, 0), num(r.p95, 0), r.errors]),
      ),
    ].join("\n"),
    bullets([
      ...questions.slice(0, 5).map((t) => `Asked: “${s(t.p.question) ?? "?"}”`),
      ...slow.slice(0, 5).map((r) => `Slow: ${r.route} p95 ${num(r.p95, 0)} ms`),
    ]),
    [
      ...(expiredReviews.length ? ["Expired reviews: are those questions worth asking? Consider better defaults."] : []),
      ...(slow.length ? ["Profile the slow routes above."] : []),
      ...(refiled.length ? ["Re-filed photos: check the caption/description keywords in the agent's photo classifier."] : []),
    ],
  );

  // 8. Data appendix ------------------------------------------------------------------------------
  const keyframes = jobsDone.flatMap((j) => (j.keyframeR2Keys ?? []).map((k) => `\`${k}\` (${j.jobType} ${j.id})`));
  const appendix = [
    "## 8. Data appendix",
    "",
    "Extracts:",
    "",
    bullets(Object.keys(extracts).map((name) => `\`/diagnostics/${week}/${name}\` (${extracts[name]!.length} rows)`)),
    "",
    "Keyframes (R2):",
    "",
    bullets(keyframes),
  ].join("\n");

  // 1. Summary -----------------------------------------------------------------------------------
  const top = findings
    .map((f, i) => ({ ...f, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 3);
  const summary = [
    "## 1. Summary",
    "",
    top.length ? top.map((f, i) => `${i + 1}. ${f.text}`).join("\n") : "Nothing notable this week.",
  ].join("\n");

  const markdown =
    [
      `# PandaBase diagnostics — ${week}\n\nWindow: ${start} → ${end} (${tz}). Generated ${ctx.now}.`,
      summary,
      velocitySection,
      receiptSection,
      vlmSection,
      productSection,
      cartSection,
      uxSection,
      appendix,
    ].join("\n\n") + "\n";

  return {
    week,
    markdown,
    extracts: Object.entries(extracts).map(([name, rows]) => ({
      name,
      jsonl: rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
    })),
  };
}

