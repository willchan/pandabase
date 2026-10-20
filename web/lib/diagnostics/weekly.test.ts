// Weekly diagnostics: snapshot against the seeded DB with a fixed `now`, plus every §7 section
// fed by emitted telemetry.
import { systemTelemetry } from "@pandabase/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { setup, SEED_NOW, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";
import { lastCompleteWeek, percentile, renderWeekly, weekRange } from "./weekly";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

const ctx = { now: SEED_NOW, config: DEFAULT_CONFIG };
const SECTIONS = [
  "## 1. Summary",
  "## 2. Velocity",
  "## 3. Receipt matching",
  "## 4. VLM",
  "## 5. Product choice",
  "## 6. Cart injection",
  "## 7. UX friction",
  "## 8. Data appendix",
];

describe("weekly diagnostics", () => {
  it("defaults to the last complete household-TZ week", () => {
    expect(lastCompleteWeek(SEED_NOW, "America/Los_Angeles")).toBe("2026-W42");
    expect(weekRange("2026-W42", "America/Los_Angeles")).toEqual({
      start: "2026-10-12T07:00:00.000Z",
      end: "2026-10-19T07:00:00.000Z",
    });
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });

  it("renders the seeded week (snapshot)", async () => {
    const report = await renderWeekly(h.db, "2026-W42", ctx);
    for (const s of SECTIONS) expect(report.markdown).toContain(s);
    await expect(report.markdown).toMatchFileSnapshot("__snapshots__/2026-W42.md");
    await expect(report.extracts.map((e) => `## ${e.name}\n${e.jsonl}`).join("\n")).toMatchFileSnapshot(
      "__snapshots__/2026-W42.extracts.txt",
    );
    // Deterministic.
    expect(await renderWeekly(h.db, "2026-W42", ctx)).toEqual(report);
  });

  it("every section reports emitted telemetry", async () => {
    const at = "2026-10-21T18:00:00.000Z";
    const t = (source: string, metricType: string, payload: Record<string, unknown>, i: number) => ({
      id: `01T${String(i).padStart(23, "0")}`,
      source,
      metricType,
      payload,
      createdAt: at,
    });
    const eggs = await h.itemId("Eggs");
    await h.db.insert(systemTelemetry).values(
      [
        ["state_engine", "ema_updated", { itemId: eggs, observedDays: 1, emaBefore: 1, emaAfter: 1 }],
        ["state_engine", "ema_outlier_rejected", { itemId: eggs, observedDays: 9, emaDays: 1, direction: "high", streak: 1 }],
        ["state_engine", "overbuy", { itemId: eggs, onHandBefore: 30, acquiredQty: 12, daysOfStock: 30 }],
        ["state_engine", "estimate_vs_observed", { itemId: eggs, estimated: 9, observed: 2 }],
        ["worker", "vlm_inference", { model: "qwen-vl:8b", prompt_version: "paper_receipt.v1", latency_ms: 3000 }],
        ["worker", "vlm_inference", { model: "qwen-vl:8b", prompt_version: "paper_receipt.v1", latency_ms: 9000, totals_check: "fail" }],
        ["worker", "vlm_parse_failure", { model: "qwen-vl:8b" }],
        ["state_engine", "cart_line_result", { itemId: eggs, outcome: "tier1", vendor: "wholefoods" }],
        ["state_engine", "cart_line_result", { itemId: eggs, outcome: "failed", vendor: "wholefoods", error: "button not found" }],
        ["agent", "selector_error", { selector: "#add-to-cart", error: "timeout" }],
        ["cron", "review_expired", { kind: "receipt", action: "drop_pending_lines" }],
        ["agent", "clarifying_question", { question: "Was that oat milk or whole milk?" }],
        ["agent", "photo_classified", { job_type: "paper_receipt", basis: "default" }],
        ["agent", "photo_reclassified", { to_job_type: "trash_cam" }],
        ["api", "api_request", { route: "GET /api/predictions", method: "GET", status: 200, latencyMs: 1800 }],
        ["api", "api_request", { route: "GET /api/predictions", method: "GET", status: 500, latencyMs: 20 }],
      ].map(([source, metric, payload], i) => t(source as string, metric as string, payload as Record<string, unknown>, i)),
    );
    const report = await renderWeekly(h.db, "2026-W43", { now: "2026-10-26T20:00:00.000Z", config: DEFAULT_CONFIG });
    const md = report.markdown;
    expect(md).toContain("Photos classified: 1 (default 1); re-filed by a human: 1.");
    for (const s of SECTIONS) expect(md).toContain(s);
    expect(md).toContain("Tier-1 cart injection succeeded for 50% of lines (target ≥ 90%).");
    expect(md).toContain("1 cart line(s) failed to inject.");
    expect(md).toContain("Overbuy: Eggs — 30 on hand (~30 days of stock)");
    expect(md).toContain("| Eggs | 1 | 7 | 7 |");
    expect(md).toContain("Inference latency p50 / p95: 3000 ms / 9000 ms (2 calls). Parse failures: 1. Totals-check failures: 1.");
    expect(md).toContain("Failed: Eggs — button not found");
    expect(md).toContain("Asked: “Was that oat milk or whole milk?”");
    expect(md).toContain("| GET /api/predictions | 2 | 20 | 1800 | 1 |");
    expect(md).toMatch(/## 1\. Summary\n\n1\. Tier-1 cart injection/);
    const extract = (name: string) => report.extracts.find((e) => e.name === name)!.jsonl.trim().split("\n");
    expect(extract("cart_injection.jsonl")).toHaveLength(3);
    expect(extract("velocity.jsonl")).toHaveLength(4);
    expect(JSON.parse(extract("ux.jsonl")[0]!)).toMatchObject({ metric: "review_expired", kind: "receipt" });
  });

  it("is served by GET /api/diagnostics/weekly", async () => {
    const res = await h.call<{ week: string; markdown: string; extracts: { name: string }[] }>(
      HANDLERS.diagnosticsWeekly.GET,
      "/api/diagnostics/weekly",
    );
    expect(res.body.week).toBe("2026-W42");
    expect(res.body.extracts.map((e) => e.name)).toEqual([
      "velocity.jsonl",
      "receipt_lines.jsonl",
      "vlm.jsonl",
      "product_choice.jsonl",
      "cart_injection.jsonl",
      "ux.jsonl",
    ]);
    const bad = await h.call(HANDLERS.diagnosticsWeekly.GET, "/api/diagnostics/weekly", { query: { week: "W42" } });
    expect(bad.status).toBe(400);
  });
});
