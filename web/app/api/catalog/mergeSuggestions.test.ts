// Suggested merges end to end (DESIGN §4.5, §4.6, §5) on the seeded DB: a backfill creates
// unverified items → the agent's run route (or the weekly cron) queues merge_suggest jobs → the
// worker claims one and completes it → merge_suggestion reviews in Cleanup → confirming one merges
// the items and keeps the target's EMA history.
import { auditJob, inventoryEvent, item, reviewItem, systemTelemetry } from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { MergeSuggestInput } from "@/lib/contracts";
import { mergeItems, pendingReviews } from "@/lib/services/reviews";
import { ALEX, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

const DAY = 86_400_000;
let h: Harness;
beforeEach(async () => {
  h = await setup();
  // The seed's queued trash_cam job would be claimed first; start from an empty queue.
  await h.db.delete(auditJob).where(eq(auditJob.status, "queued"));
});
afterEach(() => h.close());

type RunBody = {
  jobs: { id: string; job_type: string; status: string }[];
  created: boolean;
  skipped: string | null;
  candidates: number;
};
const run = (key?: string) =>
  h.call<RunBody>(HANDLERS.mergeSuggestionsRun.POST, "/api/catalog/merge-suggestions/run", {
    body: { actor_discord_id: ALEX },
    headers: key ? { "idempotency-key": key } : {},
  });

/** A backfilled Amazon order whose products are all new (unknown ASINs → unverified items). */
const backfill = (n: number, lines: { asin: string; title: string }[]) =>
  h.call(HANDLERS.receiptsIngest.POST, "/api/receipts/ingest", {
    body: {
      actor_discord_id: ALEX,
      source: "digital",
      vendor: "amazon",
      account: ALEX,
      external_order_id: `112-BACKFILL-${n}`,
      fulfillment: "delivery",
      acquired_at: new Date(Date.parse(h.now()) - (30 + n) * DAY).toISOString(),
      lines: lines.map((l) => ({ raw_text: l.title, ...l, qty: 1, unit_price_cents: 499 })),
    },
  });

const metrics = async (name: string) =>
  (await h.db.select().from(systemTelemetry).where(eq(systemTelemetry.metricType, name))).map(
    (t) => t.payload as Record<string, unknown>,
  );

describe("suggested merges", () => {
  it("backfill → run → claim → complete → reviews → confirm merges with history intact", async () => {
    expect(
      (
        await backfill(1, [
          { asin: "B0SYNEGGS1", title: "Happy Hen Organic Large Brown Eggs, 12 Count" },
          { asin: "B0SYNTOWL1", title: "Synthetic Select-A-Size Paper Towels, 6 Double Rolls" },
        ])
      ).status,
    ).toBe(200);
    const newEggs = (await h.db.select().from(item).where(eq(item.trust, "unverified"))).find((i) =>
      i.canonicalName.includes("Eggs"),
    )!;
    expect(newEggs).toBeDefined();
    const eggs = await h.itemId("Eggs");
    const [eggsBefore] = await h.db.select().from(item).where(eq(item.id, eggs));
    const eggsEvents = await h.db
      .select({ id: inventoryEvent.id })
      .from(inventoryEvent)
      .where(eq(inventoryEvent.itemId, eggs));
    const newEggsEvents = await h.db
      .select({ id: inventoryEvent.id })
      .from(inventoryEvent)
      .where(eq(inventoryEvent.itemId, newEggs.id));
    expect(newEggsEvents.length).toBeGreaterThan(0);

    // The agent's call at the end of the backfill queues one job (the catalog fits one batch).
    const first = await run("backfill-merges:alex");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ created: true, skipped: null, candidates: 3 });
    expect(first.body.jobs).toHaveLength(1);
    // Idempotent: a second call (new key) returns the waiting job instead of queuing another.
    const again = await run();
    expect(again.body).toMatchObject({ created: false, skipped: "already_queued" });
    expect(again.body.jobs.map((j) => j.id)).toEqual(first.body.jobs.map((j) => j.id));
    expect(
      await h.db.select().from(auditJob).where(eq(auditJob.jobType, "merge_suggest")),
    ).toHaveLength(1);
    expect(await metrics("merge_suggest_requested")).toEqual([
      expect.objectContaining({
        trigger: "backfill",
        candidates: 3,
        jobIds: [first.body.jobs[0]!.id],
      }),
    ]);

    // The worker claims it; its input is a valid MergeSuggestInput naming the new items and Eggs.
    const claim = await h.call<{ job: { id: string; attempt: number; input: unknown } }>(
      HANDLERS.jobsClaim.POST,
      "/api/jobs/claim",
      { auth: "worker", body: { job_types: ["merge_suggest"] } },
    );
    const input = MergeSuggestInput.parse(claim.body.job.input);
    const sent = new Map(input.items.map((i) => [i.item_id, i]));
    expect(sent.get(eggs)?.name).toBe("Eggs");
    expect(sent.get(newEggs.id)?.aliases).toContain("Happy Hen Organic Large Brown Eggs, 12 Count");

    // A realistic model answer (after the worker's own pair dedupe): the new eggs are Eggs, plus a
    // self-pair and a low-confidence guess the State Engine drops.
    const kombucha = await h.itemId("Kombucha");
    const complete = await h.call<{ outcome: string; review_ids: string[] }>(
      HANDLERS.jobsComplete.POST,
      "/api/jobs/complete",
      {
        auth: "worker",
        headers: { "idempotency-key": `complete:${claim.body.job.id}:1` },
        body: {
          job_id: claim.body.job.id,
          attempt: claim.body.job.attempt,
          status: "completed",
          model: "qwen3.5:4b",
          prompt_version: "merge_suggest.v1",
          result: {
            suggestions: [
              {
                item_id: newEggs.id,
                merge_into_item_id: eggs,
                confidence: 0.94,
                reason: "same eggs, brand name",
              },
              { item_id: kombucha, merge_into_item_id: kombucha, confidence: 0.9 },
              { item_id: kombucha, merge_into_item_id: eggs, confidence: 0.2 },
            ],
          },
        },
      },
    );
    expect(complete.status).toBe(200);
    expect(complete.body).toMatchObject({ outcome: "review", review_ids: [expect.any(String)] });
    expect((await metrics("merge_suggestions_created"))[0]).toMatchObject({
      suggestions: 3,
      created: 1,
      self: 1,
      low_confidence: 1,
    });

    // Cleanup → Merges lists it with a 30-day expiry that does nothing.
    const reviewId = complete.body.review_ids[0]!;
    const listed = (await pendingReviews(h.db)).find((r) => r.id === reviewId)!;
    expect(listed).toMatchObject({
      kind: "merge_suggestion",
      itemId: newEggs.id,
      mergeInto: { id: eggs, name: "Eggs" },
      expiresAt: new Date(Date.parse(h.now()) + 30 * DAY).toISOString(),
      payload: { confidence: 0.94, reason: "same eggs, brand name" },
    });
    const [row] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, reviewId));
    expect(row!.defaultAction).toEqual({ action: "none" });

    // Confirm (the Cleanup "Merge" button's service): merged, events moved, Eggs' EMA untouched.
    await mergeItems(
      h.db,
      { reviewId, itemId: newEggs.id, intoItemId: eggs, unitQuantity: null },
      {
        now: h.now(),
        config: DEFAULT_CONFIG,
        actor: { memberId: await h.memberId(ALEX), system: null },
      },
    );
    const [merged] = await h.db.select().from(item).where(eq(item.id, newEggs.id));
    expect(merged!.mergedIntoItemId).toBe(eggs);
    const [eggsAfter] = await h.db.select().from(item).where(eq(item.id, eggs));
    expect(eggsAfter).toMatchObject({
      currentEmaDays: eggsBefore!.currentEmaDays,
      emaOutlierStreak: eggsBefore!.emaOutlierStreak,
    });
    const after = (
      await h.db
        .select({ id: inventoryEvent.id })
        .from(inventoryEvent)
        .where(eq(inventoryEvent.itemId, eggs))
    ).map((e) => e.id);
    expect(after).toEqual(
      expect.arrayContaining([...eggsEvents, ...newEggsEvents].map((e) => e.id)),
    );
    const [answered] = await h.db.select().from(reviewItem).where(eq(reviewItem.id, reviewId));
    expect(answered!.status).toBe("confirmed");
    // Accepted shows up in the review telemetry the weekly report reads.
    expect((await metrics("review_resolved")).find((p) => p.reviewId === reviewId)).toMatchObject({
      kind: "merge_suggestion",
      outcome: "confirmed",
    });

    // A later run doesn't re-suggest the merged pair; the job is done, so it queues a new one.
    const later = await run();
    expect(later.body).toMatchObject({ created: true, candidates: 2 });
    const laterInput = MergeSuggestInput.parse(
      (await h.db.select().from(auditJob).where(eq(auditJob.id, later.body.jobs[0]!.id)))[0]!.input,
    );
    expect(laterInput.items.map((i) => i.item_id)).not.toContain(newEggs.id);
  });

  it("queues nothing without unverified items", async () => {
    await h.db.update(item).set({ trust: "confirmed" });
    expect((await run()).body).toEqual({
      jobs: [],
      created: false,
      skipped: "no_candidates",
      candidates: 0,
    });
  });

  it("the weekly cron queues a run once enough unverified items arrived, at most weekly", async () => {
    const cron = () =>
      h.call<{ merge_suggest_jobs: number }>(
        HANDLERS.cronMaintenance.GET,
        "/api/cron/maintenance",
        {
          auth: "cron",
        },
      );
    // The seed has one unverified item (< mergeSuggest.minNewItems).
    expect((await cron()).body.merge_suggest_jobs).toBe(0);
    await backfill(
      2,
      Array.from({ length: 10 }, (_, i) => ({
        asin: `B0SYNNEW${i}`,
        title: `Synthetic Snack Bar Flavor ${i}`,
      })),
    );
    expect((await cron()).body.merge_suggest_jobs).toBe(1);
    // Same day: the job is still queued → nothing new.
    expect((await cron()).body.merge_suggest_jobs).toBe(0);
    // The worker finishes it; more items arrive; a week hasn't passed → nothing.
    await h.db
      .update(auditJob)
      .set({ status: "completed" })
      .where(and(eq(auditJob.jobType, "merge_suggest"), eq(auditJob.status, "queued")));
    h.advance(DAY);
    await backfill(
      3,
      Array.from({ length: 10 }, (_, i) => ({
        asin: `B0SYNMORE${i}`,
        title: `Synthetic Tea Flavor ${i}`,
      })),
    );
    expect((await cron()).body.merge_suggest_jobs).toBe(0);
    h.advance(6 * DAY);
    expect((await cron()).body.merge_suggest_jobs).toBe(1);
    expect((await metrics("merge_suggest_requested")).map((p) => p.trigger)).toEqual([
      "cron",
      "cron",
    ]);
  });
});
