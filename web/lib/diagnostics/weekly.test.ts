// Weekly diagnostics: snapshot against the seeded DB with a fixed `now`, plus every §7 section
// fed by emitted telemetry.
import { auditJob, groceryCycleOverride, item, systemTelemetry } from "@pandabase/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { setup, SEED_NOW, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";
import { activeCycle } from "@/lib/repo/cycles";
import { planFor } from "@/lib/services/cycles";
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
  "## 6. Store choice (Costco)",
  "## 7. Cart injection",
  "## 8. UX friction",
  "## 9. Deploys",
  "## 10. Data appendix",
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
    await expect(
      report.extracts.map((e) => `## ${e.name}\n${e.jsonl}`).join("\n"),
    ).toMatchFileSnapshot("__snapshots__/2026-W42.extracts.txt");
    // Deterministic.
    expect(await renderWeekly(h.db, "2026-W42", ctx)).toEqual(report);
  });

  it("every section reports emitted telemetry", async () => {
    const at = "2026-10-21T18:00:00.000Z";
    const t = (
      source: string,
      metricType: string,
      payload: Record<string, unknown>,
      i: number,
    ) => ({
      id: `01T${String(i).padStart(23, "0")}`,
      source,
      metricType,
      payload,
      createdAt: at,
    });
    const eggs = await h.itemId("Eggs");
    await h.db.insert(systemTelemetry).values(
      [
        [
          "state_engine",
          "ema_updated",
          { itemId: eggs, observedDays: 1, emaBefore: 1, emaAfter: 1 },
        ],
        [
          "state_engine",
          "ema_outlier_rejected",
          { itemId: eggs, observedDays: 9, emaDays: 1, direction: "high", streak: 1 },
        ],
        [
          "state_engine",
          "overbuy",
          { itemId: eggs, onHandBefore: 30, acquiredQty: 12, daysOfStock: 30 },
        ],
        ["state_engine", "estimate_vs_observed", { itemId: eggs, estimated: 9, observed: 2 }],
        [
          "worker",
          "vlm_inference",
          { model: "qwen-vl:8b", prompt_version: "paper_receipt.v1", latency_ms: 3000 },
        ],
        [
          "worker",
          "vlm_inference",
          {
            model: "qwen-vl:8b",
            prompt_version: "paper_receipt.v1",
            latency_ms: 9000,
            totals_check: "fail",
          },
        ],
        ["worker", "vlm_parse_failure", { model: "qwen-vl:8b" }],
        [
          "state_engine",
          "cart_line_result",
          { itemId: eggs, outcome: "tier1", vendor: "wholefoods" },
        ],
        [
          "state_engine",
          "cart_line_result",
          { itemId: eggs, outcome: "failed", vendor: "wholefoods", error: "button not found" },
        ],
        ["agent", "selector_error", { selector: "#add-to-cart", error: "timeout" }],
        ["cron", "review_expired", { kind: "receipt", action: "drop_pending_lines" }],
        [
          "state_engine",
          "review_resolved",
          { kind: "receipt", outcome: "corrected", ageHours: 30 },
        ],
        ["agent", "clarifying_question", { question: "Was that oat milk or whole milk?" }],
        ["agent", "photo_classified", { job_type: "paper_receipt", basis: "default" }],
        ["agent", "photo_reclassified", { to_job_type: "trash_cam" }],
        [
          "api",
          "api_request",
          { route: "GET /api/predictions", method: "GET", status: 200, latencyMs: 1800 },
        ],
        [
          "api",
          "api_request",
          { route: "GET /api/predictions", method: "GET", status: 500, latencyMs: 20 },
        ],
      ].map(([source, metric, payload], i) =>
        t(source as string, metric as string, payload as Record<string, unknown>, i),
      ),
    );
    const report = await renderWeekly(h.db, "2026-W43", {
      now: "2026-10-26T20:00:00.000Z",
      config: DEFAULT_CONFIG,
    });
    const md = report.markdown;
    expect(md).toContain("Photos classified: 1 (default 1); re-filed by a human: 1.");
    for (const s of SECTIONS) expect(md).toContain(s);
    expect(md).toContain("Tier-1 cart injection succeeded for 50% of lines (target ≥ 90%).");
    expect(md).toContain("1 cart line(s) failed to inject.");
    expect(md).toContain("Overbuy: Eggs — 30 on hand (~30 days of stock)");
    expect(md).toContain("| Eggs | 1 | 7 | 7 |");
    expect(md).toContain(
      "Inference latency p50 / p95: 3000 ms / 9000 ms (2 calls). Parse failures: 1. Totals-check failures: 1.",
    );
    expect(md).toContain("Failed: Eggs — button not found");
    expect(md).toContain("Asked: “Was that oat milk or whole milk?”");
    expect(md).toContain("| GET /api/predictions | 2 | 20 | 1800 | 1 |");
    expect(md).toContain("| receipt | 0 | 1 | 0 | 30 |");
    expect(md).toMatch(/## 1\. Summary\n\n1\. Tier-1 cart injection/);
    const extract = (name: string) =>
      report.extracts
        .find((e) => e.name === name)!
        .jsonl.trim()
        .split("\n");
    expect(extract("cart_injection.jsonl")).toHaveLength(3);
    expect(extract("velocity.jsonl")).toHaveLength(4);
    expect(JSON.parse(extract("ux.jsonl")[0]!)).toMatchObject({
      metric: "review_expired",
      kind: "receipt",
    });
  });

  it("reports Amazon layout alerts and the weekly add-button check", async () => {
    const t = (i: number, metricType: string, payload: Record<string, unknown>) => ({
      id: `01L${String(i).padStart(23, "0")}`,
      source: "agent",
      metricType,
      payload,
      createdAt: "2026-10-24T17:10:00.000Z",
    });
    await h.db.insert(systemTelemetry).values([
      t(1, "cart_probe", { store: "amazon", asin: "B0SYNTH501", found: true }),
      t(2, "cart_probe", {
        store: "wholefoods",
        asin: "B0SYNTH301",
        found: false,
        reason: "no_add_form",
      }),
      t(3, "cart_layout_alert", {
        cycle_id: "C1",
        page_failures: 3,
        attempted: 4,
        reasons: { no_add_form: 2, unverified: 1 },
        asins: ["B0SYNTH001", "B0SYNTH002", "B0SYNTH003"],
      }),
    ]);
    const report = await renderWeekly(h.db, "2026-W43", {
      now: "2026-10-26T20:00:00.000Z",
      config: DEFAULT_CONFIG,
    });
    const md = report.markdown;
    // The alert outranks every other finding; the failed check is next.
    expect(md).toMatch(
      /## 1\. Summary\n\n1\. Amazon layout alert: 3 of 4 tier-1 lines failed on the page \(no_add_form 2, unverified 1\)\.\n2\. Weekly add-button check failed: wholefoods B0SYNTH301 \(no_add_form\)\./,
    );
    expect(md).toContain(
      "Layout alerts: 1. Weekly add-button checks: 2 pages, 1 without an add button.",
    );
    expect(md).toContain("| amazon | 1 | 0 |");
    expect(md).toContain("| wholefoods | 0 | 1 |");
    expect(md).toContain("Add button not found: wholefoods B0SYNTH301 — no_add_form");
    expect(md).toContain("Amazon's layout probably changed");
    const rows = report.extracts
      .find((e) => e.name === "cart_injection.jsonl")!
      .jsonl.trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { metric: string });
    expect(rows.map((r) => r.metric)).toEqual(["cart_probe", "cart_probe", "cart_layout_alert"]);
  });

  it("reports cart pauses and the EMA updates they froze", async () => {
    const t = (i: number, metricType: string, payload: Record<string, unknown>) => ({
      id: `01L${String(i).padStart(23, "0")}`,
      source: "state_engine",
      metricType,
      payload,
      createdAt: "2026-10-24T17:10:00.000Z",
    });
    await h.db.insert(systemTelemetry).values([
      t(1, "cart_pause_changed", {
        action: "created",
        pauseId: "P1",
        startsOn: "2026-10-24",
        endsOn: "2027-03-01",
      }),
      t(2, "ema_paused", { itemId: "I1", observedDays: 9, emaDays: 2 }),
      t(3, "ema_paused", { itemId: "I2", observedDays: 4, emaDays: 3 }),
    ]);
    const report = await renderWeekly(h.db, "2026-W43", {
      now: "2026-10-26T20:00:00.000Z",
      config: DEFAULT_CONFIG,
    });
    expect(report.markdown).toContain(
      "Carts paused: 2 EMA update(s) frozen (created 2026-10-24–2027-03-01).",
    );
    expect(report.markdown).toContain("| ema_paused | 2 |");
  });

  it("reports Subscribe & Save: items left out, syncs, and page reads not synced (§4.9)", async () => {
    const soap = await h.itemId("Eggs");
    const t = (i: number, source: string, metricType: string, payload: Record<string, unknown>) => ({
      id: `01S${String(i).padStart(23, "0")}`,
      source,
      metricType,
      payload,
      createdAt: "2026-10-24T17:10:00.000Z",
    });
    await h.db.insert(systemTelemetry).values([
      t(1, "agent", "subscription_page", { member: "alex", outcome: "synced", tiles: 3, expected: 3 }),
      t(2, "state_engine", "subscription_sync", { memberId: "m", active: 3, added: 3, ended: 0 }),
      t(3, "agent", "subscription_page", { member: "sam", outcome: "incomplete", tiles: 2, expected: 5 }),
      t(4, "state_engine", "subscription_left_out", {
        cycleId: "C1",
        itemId: soap,
        asin: "B0SYNTHS01",
        nextDeliveryOn: "2026-10-29",
      }),
    ]);
    const md = (
      await renderWeekly(h.db, "2026-W43", { now: "2026-10-26T20:00:00.000Z", config: DEFAULT_CONFIG })
    ).markdown;
    expect(md).toContain(
      "Subscribe & Save: 1 item(s) left out of builds; 1 sync(s) (3 active after the last), 1 page read(s) not synced (incomplete 1).",
    );
    expect(md).toContain("The Subscribe & Save list wasn't refreshed 1 time(s) (incomplete)");
    expect(md).toContain("Left out (Subscribe & Save): Eggs — next delivery 2026-10-29");
    expect(md).toContain("Subscribe & Save page not synced (sam): incomplete — 2 tiles, 5 expected");
    expect(md).toContain("The Subscribe & Save page may have changed");
  });

  it("reports suggested merges and worker health (heartbeats, Ollama, gaps)", async () => {
    // W43 runs 2026-10-19T07:00Z → 2026-10-26T07:00Z; heartbeats every 10 min except a 2h silence.
    const start = Date.parse("2026-10-19T07:00:00.000Z");
    const beats: number[] = [];
    for (let m = 5; m < 7 * 24 * 60; m += 10) if (m < 600 || m > 720) beats.push(m);
    const rows = [
      ...beats.map((m, i) => ({
        source: "worker",
        metricType: "worker_heartbeat",
        payload: {
          version: "0.1.0",
          vlm_model: "qwen3.5:9b",
          text_model: "qwen3.5:4b",
          ollama_ok: i !== 3,
        },
        createdAt: new Date(start + m * 60_000).toISOString(),
      })),
      {
        source: "state_engine",
        metricType: "merge_suggest_requested",
        payload: { trigger: "backfill", jobIds: ["j1", "j2"], candidates: 40 },
      },
      {
        source: "state_engine",
        metricType: "merge_suggestions_created",
        payload: { suggestions: 9, created: 6, duplicate: 2, low_confidence: 1 },
      },
      ...["confirmed", "confirmed", "dismissed", "dismissed", "dismissed", "corrected"].map(
        (outcome) => ({
          source: "state_engine",
          metricType: "review_resolved",
          payload: { kind: "merge_suggestion", outcome, ageHours: 5 },
        }),
      ),
      {
        source: "cron",
        metricType: "review_expired",
        payload: { kind: "merge_suggestion", action: "none" },
      },
      {
        source: "state_engine",
        metricType: "review_reprioritized",
        payload: { trigger: "maintenance", raised: 44, lowered: 2 },
      },
    ].map((r, i) => ({
      createdAt: "2026-10-21T18:00:00.000Z",
      ...r,
      id: `01H${String(i).padStart(23, "0")}`,
    }));
    for (let i = 0; i < rows.length; i += 100)
      await h.db.insert(systemTelemetry).values(rows.slice(i, i + 100));
    const report = await renderWeekly(h.db, "2026-W43", {
      now: "2026-10-27T20:00:00.000Z",
      config: DEFAULT_CONFIG,
    });
    const md = report.markdown;
    expect(md).toContain("| Runs (jobs) | 1 (2) — backfill 1 |");
    expect(md).toContain("| Reviews created | 6 |");
    expect(md).toContain("| Dropped | duplicate 2, low_confidence 1 |");
    expect(md).toContain("| Accepted (merged as suggested) | 2 |");
    expect(md).toContain("| Dismissed (not the same) | 3 |");
    expect(md).toContain("| Expired unanswered | 1 |");
    expect(md).toMatch(
      /Reviews re-scored against the cart plan: 44 moved to This Week, 2 back to Cleanup\. Waiting now: \d+ shown in Cleanup, \d+ one-time buys left out\./,
    );
    expect(md).toContain("Suggested merges: only 33% of 6 answered were accepted.");
    expect(md).toContain(
      `| Last heartbeat | ${new Date(start + beats.at(-1)! * 60_000).toISOString()} |`,
    );
    expect(md).toContain("| Version: VLM / text model | 0.1.0: qwen3.5:9b / qwen3.5:4b |");
    expect(md).toContain("| ollama_ok (last) | true |");
    expect(md).toContain("| Heartbeats with Ollama down | 1 |");
    expect(md).toContain("| Gaps > 30 min | 1 (2.2 h total) |");
    expect(md).toContain(
      "Worker silent 2026-10-19T16:55:00.000Z → 2026-10-19T19:05:00.000Z (2.2 h)",
    );
    expect(md).toContain("The worker was silent 1 time(s) for over 30 min (longest 2.2 h).");
    expect(md).toContain("The worker couldn't reach Ollama in 1 heartbeat(s).");
    const vlm = report.extracts.find((e) => e.name === "vlm.jsonl")!.jsonl;
    expect(vlm).toContain('"metric":"worker_gap","from":"2026-10-19T16:55:00.000Z"');
    expect(vlm).toContain('"metric":"merge_suggestions_created"');
  });

  it("counts answers cut off at the length cap and keeps an excerpt of failed jobs' output", async () => {
    // 2026-11-09: a merge_suggest answer looped until the 240 s timeout, and nothing in the report
    // showed what the model had written. Now the worker caps the answer, and a failed job's kept
    // output reaches vlm.jsonl (excerpt only) so the loop can be read.
    const loop = '{"suggestions": [' + '{"item_id": "a", "merge_into_item_id": "b"}, '.repeat(100);
    await h.db.insert(auditJob).values([
      {
        id: "01JOBLOOPING000000000000000",
        jobType: "merge_suggest",
        status: "failed",
        attempts: 3,
        model: "qwen3.5:4b",
        promptVersion: "merge_suggest.v1",
        error: "model output invalid: output cut off at the 2048-token cap",
        rawModelResponse: { responses: [loop] },
        createdAt: "2026-10-21T18:00:00.000Z",
        updatedAt: "2026-10-21T18:10:00.000Z",
      },
      {
        id: "01JOBFINE00000000000000000",
        jobType: "merge_suggest",
        status: "completed",
        attempts: 1,
        rawModelResponse: { responses: ['{"suggestions": []}'] },
        createdAt: "2026-10-21T18:00:00.000Z",
        updatedAt: "2026-10-21T18:01:00.000Z",
      },
    ]);
    await h.db.insert(systemTelemetry).values(
      [1, 2, 3].map((attempt) => ({
        id: `01HTRUNC${String(attempt).padStart(18, "0")}`,
        source: "worker",
        metricType: "vlm_parse_failure",
        payload: { job_type: "merge_suggest", attempt, truncated: true, error: "cut off" },
        createdAt: "2026-10-21T18:05:00.000Z",
      })),
    );
    const report = await renderWeekly(h.db, "2026-W43", {
      now: "2026-10-27T20:00:00.000Z",
      config: DEFAULT_CONFIG,
    });
    expect(report.markdown).toContain("Parse failures: 3 (3 cut off at the length cap).");
    expect(report.markdown).toContain(
      "3 model answer(s) hit the length cap — likely repetition loops; read `raw_excerpt` in vlm.jsonl.",
    );
    const rows = report.extracts
      .find((e) => e.name === "vlm.jsonl")!
      .jsonl.split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const failed = rows.find((r) => r.job_id === "01JOBLOOPING000000000000000")!;
    const excerpt = DEFAULT_CONFIG.diagnostics.rawExcerptChars;
    expect(failed.raw_excerpt).toBe(loop.slice(0, excerpt) + "…");
    expect(failed.raw_chars).toBe(loop.length);
    // Completed jobs' output stays out of the extract.
    expect(rows.find((r) => r.job_id === "01JOBFINE00000000000000000")).not.toHaveProperty(
      "raw_excerpt",
    );
  });

  it("reports deploys per component, with Mac Mini rollbacks", async () => {
    const deploy = (i: number, at: string, payload: Record<string, unknown>) => ({
      id: `01D${String(i).padStart(23, "0")}`,
      source: "agent",
      metricType: "deploy",
      payload,
      createdAt: at,
    });
    const sha1 = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const sha2 = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await h.db.insert(systemTelemetry).values([
      deploy(1, "2026-10-20T10:00:00.000Z", {
        component: "migrate",
        sha: sha1,
        outcome: "success",
      }),
      deploy(2, "2026-10-20T10:01:00.000Z", { component: "web", sha: sha1, outcome: "success" }),
      deploy(3, "2026-10-20T10:05:00.000Z", {
        component: "worker_image",
        sha: sha1,
        outcome: "success",
      }),
      deploy(4, "2026-10-20T10:15:00.000Z", {
        component: "mac_mini",
        sha: sha1,
        outcome: "success",
        previous_sha: sha2,
      }),
      deploy(5, "2026-10-22T10:15:00.000Z", {
        component: "mac_mini",
        sha: sha2,
        outcome: "rolled_back",
        previous_sha: sha1,
        reason: "no worker heartbeat from 2222222 within 120s",
      }),
    ]);
    const md = (
      await renderWeekly(h.db, "2026-W43", {
        now: "2026-10-27T20:00:00.000Z",
        config: DEFAULT_CONFIG,
      })
    ).markdown;
    expect(md).toContain("| mac_mini | 2 | 1 | 1 |");
    expect(md).toContain("| web | 1 | 1 | 0 |");
    expect(md).toContain("Mac Mini rollbacks: 1.");
    expect(md).toContain(
      "| 2026-10-20T10:15:00.000Z | mac_mini | 1111111 | success | from 2222222 |",
    );
    expect(md).toContain(
      "- mac_mini 2222222: rolled_back — no worker heartbeat from 2222222 within 120s",
    );
    expect(md).toContain("1 deploy step(s) failed or rolled back.");

    await h.db.insert(systemTelemetry).values(
      deploy(6, "2026-10-23T10:15:00.000Z", {
        component: "mac_mini",
        sha: sha2,
        outcome: "rollback_failed",
      }),
    );
    const md2 = (
      await renderWeekly(h.db, "2026-W43", {
        now: "2026-10-27T20:00:00.000Z",
        config: DEFAULT_CONFIG,
      })
    ).markdown;
    expect(md2).toContain("1 Mac Mini rollback(s) failed — the worker may be down.");
    expect(md2).toContain("Mac Mini rollbacks: 2.");
    expect(md2).not.toContain("production smoke failed");
  });

  it("reports a failed production smoke with its failed checks and the rollback hint", async () => {
    const sha = "3333333ccccccccccccccccccccccccccccccccc";
    await h.db.insert(systemTelemetry).values(
      ["success", "failure"].map((outcome, i) => ({
        id: `01S${String(i).padStart(23, "0")}`,
        source: "agent",
        metricType: "deploy",
        payload: {
          component: "web-smoke",
          sha,
          outcome,
          ...(outcome === "failure" ? { reason: "agent token, cron without its secret" } : {}),
        },
        createdAt: `2026-10-2${i + 1}T10:00:00.000Z`,
      })),
    );
    const md = (
      await renderWeekly(h.db, "2026-W43", {
        now: "2026-10-27T20:00:00.000Z",
        config: DEFAULT_CONFIG,
      })
    ).markdown;
    expect(md).toContain("| web-smoke | 2 | 1 | 1 |");
    expect(md).toContain("- web-smoke 3333333: failure — agent token, cron without its secret");
    expect(md).toContain("Vercel's Instant Rollback");
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
      "store_choice.jsonl",
      "cart_injection.jsonl",
      "ux.jsonl",
      "data_quality.jsonl",
    ]);
    const bad = await h.call(HANDLERS.diagnosticsWeekly.GET, "/api/diagnostics/weekly", {
      query: { week: "W42" },
    });
    expect(bad.status).toBe(400);
  });

  // Regression shapes (2026-11, W45): the order page's footer link "Amazon Business Card" was
  // imported as an item on every order; and an item long past its runout must not sit in the plan.
  it("data quality: flags ad-like item names and planned items long past runout", async () => {
    const cycle = (await activeCycle(h.db))!;
    const seeded = await planFor(h.db, cycle, ctx);
    const target = seeded.plan.lines.find((l) => l.reason === "runout")!.itemId!;
    await h.db
      .update(item)
      .set({ canonicalName: "Amazon Business Card" })
      .where(eq(item.id, target));
    // Half a year on, every velocity runout is lapsed; an `add` puts this one back in the plan.
    const later = { ...ctx, now: "2027-05-01T16:00:00.000Z" };
    await h.db.insert(groceryCycleOverride).values({
      id: "01TDQ000000000000000000001",
      cycleId: cycle.id,
      kind: "add",
      itemId: target,
    });

    const report = await renderWeekly(h.db, "2026-W42", later);
    const dq = report.extracts
      .find((e) => e.name === "data_quality.jsonl")!
      .jsonl.trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(dq.find((r) => r.check === "ad_like_name")).toMatchObject({
      item: "Amazon Business Card",
      phrase: "business card",
      planned: true,
    });
    // An `add` line has no restock reason. (Seeded "consumed" items show up too: nobody bought
    // them in half a year.)
    expect(
      dq.find((r) => r.check === "stale_runout_planned" && r.item === "Amazon Business Card"),
    ).toMatchObject({ reason: null });
    expect(report.markdown).toContain("| Ad-like item names (catalog) | 1 |");
    expect(report.markdown).toMatch(/\| Planned, ran out > 60 d ago \(now\) \| [1-9]\d* \|/);
    expect(report.markdown).toContain(
      "1 item(s) look like page text, not groceries (Amazon Business Card); 1 in the cart plan.",
    );
    expect(report.markdown).toMatch(
      /planned item\(s\) ran out over 60 days ago \(.*Amazon Business Card/,
    );
  });

  it("counts held receipts (§4.5) and flags the ones still held at the end of the week", async () => {
    const ingest = (id: string, subtotal: number) =>
      h.call(HANDLERS.receiptsIngest.POST, "/api/receipts/ingest", {
        body: {
          actor_discord_id: "100000000000000001",
          source: "digital",
          vendor: "costco",
          account: "100000000000000001",
          external_order_id: id,
          fulfillment: "delivery",
          acquired_at: "2026-10-20T19:00:00Z",
          subtotal_cents: subtotal,
          lines: [
            { raw_text: "KS ALMOND MLK", vendor_sku: "9000103", qty: 1, line_total_cents: 699 },
          ],
        },
      });
    await ingest("1000000123", 399); // held, never fixed
    await ingest("1000000456", 399); // held, then re-read right
    await ingest("1000000456", 699);
    const report = await renderWeekly(h.db, "2026-W43", {
      ...ctx,
      now: "2026-10-27T16:00:00.000Z",
    });
    expect(report.markdown).toContain(
      "Held receipts (totals don't add up, not applied): 1 held at the end of the week, 2 newly held, 1 applied after a re-read, 0 applied as read on expiry.",
    );
    expect(report.markdown).toContain("1. 1 digital receipt(s) held:");
    expect(report.markdown).toContain(
      "Held: costco order …000123 (2026-10-20), 1 read(s), applied as read on 2026-11-03",
    );
    const dq = report.extracts.find((e) => e.name === "data_quality.jsonl")!.jsonl;
    expect(dq).toContain('"check":"receipt_held"');
    expect(dq).toContain('"check":"receipt_hold_released"');
  });

  it("counts learning rebuilds (§4.10) only in weeks that had one", async () => {
    await h.db.insert(systemTelemetry).values({
      id: "01KREBUILD0000000000000000",
      source: "state_engine",
      metricType: "learning_rebuilt",
      payload: { scope: "all", itemsChanged: 2, productsChanged: 3, eventItems: 1 },
      createdAt: "2026-10-21T18:00:00.000Z",
    });
    const report = await renderWeekly(h.db, "2026-W43", ctx);
    expect(report.markdown).toContain(
      "Learning rebuilt from receipts (db:rebuild-learning): 1 run(s), 2 item(s) and 3 product(s) changed, 1 item(s) with regenerated preference events.",
    );
    const quiet = await renderWeekly(h.db, "2026-W42", ctx);
    expect(quiet.markdown).not.toContain("Learning rebuilt");
  });

  it("data quality: a week without receipts isn't flagged and says so", async () => {
    const report = await renderWeekly(h.db, "2025-W01", ctx);
    expect(report.markdown).toContain("| Store split (this week) | no lines |");
    expect(report.markdown).not.toContain("check the importer's store tagging");
  });
});

describe("store choice section (DESIGN §4.8)", () => {
  const at = "2026-10-21T18:00:00.000Z";
  const row = (metricType: string, payload: Record<string, unknown>) => ({
    source: "state_engine",
    metricType,
    payload,
    createdAt: at,
  });

  it("counts planned items by store / why / timing, trips, and pins; flags expiry", async () => {
    const eggs = await h.itemId("Eggs");
    const tp = await h.itemId("Toilet Paper");
    const milk = await h.itemId("Whole Milk");
    const choice = (itemId: string, o: Record<string, unknown>) =>
      row("store_choice", { cycleId: "c", itemId, ...o });
    await h.db.insert(systemTelemetry).values([
      choice(eggs, { store: "costco", why: "cheaper", savingsRatio: 0.27, timing: "wait" }),
      choice(tp, {
        store: "costco",
        why: "cheaper",
        savingsRatio: 0.31,
        timing: "bridge",
        bridgeCause: "needed_now",
      }),
      choice(milk, {
        store: "regular",
        why: "no_costco_product",
        savingsRatio: null,
        timing: null,
      }),
      row("costco_trip_planned", { tripId: "t", plannedFor: "2026-10-24", created: true }),
      {
        ...row("costco_trip", {
          tripId: "t",
          plannedFor: "2026-10-12",
          outcome: "expired",
          listLines: 4,
          bridged: 1,
        }),
        source: "cron",
      },
      row("store_override", {
        itemId: eggs,
        to: "regular",
        kind: "store_override_to_regular",
        thresholdBefore: 0.15,
        thresholdAfter: 0.2,
      }),
    ]);
    const { markdown: md, extracts } = await renderWeekly(h.db, "2026-W43", ctx);
    const section = md.slice(md.indexOf("## 6. Store choice"), md.indexOf("## 7. Cart injection"));
    expect(section).toContain("| costco | cheaper | wait | 1 |");
    expect(section).toContain("| costco | cheaper | bridge (needed_now) | 1 |");
    expect(section).toContain("| regular | no_costco_product | – | 1 |");
    expect(section).toContain("median 27% over 2 planned item(s)");
    expect(section).toContain(
      "Trips: 1 planned / moved, 1 closed (expired 1). Store pins: 1, 1 moved the Costco threshold (0.15 → 0.2).",
    );
    expect(section).toContain("| 2026-10-12 | expired | 4 | 1 |");
    expect(section).toContain("Eggs: pinned to regular (store_override_to_regular)");
    expect(section).toContain("A trip expired unclosed");
    expect(md).toContain('1 Costco trip(s) expired with nobody saying "back from Costco".');
    const rows = extracts
      .find((e) => e.name === "store_choice.jsonl")!
      .jsonl.trim()
      .split("\n");
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => JSON.parse(r) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ metric: "store_choice", item: "Eggs", timing: "wait" }),
    );
  });

  it("says why nothing goes to Costco before the receipt importer", async () => {
    await h.db
      .insert(systemTelemetry)
      .values([row("store_choice", { itemId: "x", store: "regular", why: "no_costco_product" })]);
    const { markdown } = await renderWeekly(h.db, "2026-W43", ctx);
    expect(markdown).toContain("No planned item has a Costco product yet");
  });
});
