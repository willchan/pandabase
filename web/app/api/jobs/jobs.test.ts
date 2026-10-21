// Job lifecycle (DESIGN §5): upload URL → create → claim → lease expiry → re-claim → complete →
// notifications → notified; retries and final failure; Trash Cam and merge-suggest results.
import { auditJob, inventoryEvent, inventoryState, item, reviewItem } from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALEX, SAM, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  // The seed's queued trash_cam job would be claimed first; start from an empty queue.
  h = await setup();
  await h.db.delete(auditJob).where(eq(auditJob.status, "queued"));
});
afterEach(() => h.close());

interface Claimed {
  id: string;
  attempt: number;
  lease_expires_at: string;
  media_url: string | null;
  keyframe_uploads: { key: string; url: string }[];
}
type JobBody = {
  job: {
    id: string;
    status: string;
    attempts: number;
    error: string | null;
    notified_at: string | null;
  };
};

const create = async (body: Record<string, unknown> = {}) =>
  (
    await h.call<JobBody>(HANDLERS.jobsCreate.POST, "/api/jobs", {
      body: {
        actor_discord_id: SAM,
        job_type: "trash_cam",
        media_r2_key: "media/2026/10/trash.jpg",
        discord_channel_id: "c1",
        discord_message_id: "m1",
        ...body,
      },
    })
  ).body.job;
const claim = async () =>
  (
    await h.call<{ job: Claimed | null }>(HANDLERS.jobsClaim.POST, "/api/jobs/claim", {
      auth: "worker",
      body: {},
    })
  ).body.job;
const complete = (body: Record<string, unknown>) =>
  h.call<{ outcome: string; review_ids: string[]; job: JobBody["job"] }>(
    HANDLERS.jobsComplete.POST,
    "/api/jobs/complete",
    {
      auth: "worker",
      body: { status: "completed", model: "qwen-vl:8b", prompt_version: "trash_cam.v1", ...body },
    },
  );
const notifications = async () =>
  (
    await h.call<{ notifications: { job: { id: string }; summary: string }[] }>(
      HANDLERS.jobsNotifications.GET,
      "/api/jobs/notifications",
    )
  ).body.notifications;

describe("media upload", () => {
  it("presigns a PUT for media/{yyyy}/{mm}/{ulid}.{ext}", async () => {
    const res = await h.call<{
      key: string;
      url: string;
      headers: Record<string, string>;
      expires_at: string;
    }>(HANDLERS.mediaUploadUrl.POST, "/api/media/upload-url", {
      body: { content_type: "image/jpeg", ext: "jpeg" },
    });
    expect(res.body.key).toMatch(/^media\/2026\/10\/[0-9A-Z]{26}\.jpg$/);
    expect(res.body.url).toBe(`https://r2.test/${res.body.key}?method=PUT&expires=900`);
    expect(res.body.headers).toEqual({ "content-type": "image/jpeg" });
    expect(res.body.expires_at).toBe("2026-10-20T16:15:00.000Z");
  });
});

describe("job lifecycle", () => {
  it("create → claim → lease expiry → re-claim → complete → notifications → notified", async () => {
    const job = await create();
    expect(job).toMatchObject({ status: "queued", attempts: 0 });
    expect(await notifications()).toEqual([]);

    const first = (await claim())!;
    expect(first).toMatchObject({
      id: job.id,
      attempt: 1,
      lease_expires_at: "2026-10-20T16:05:00.000Z",
      media_url: "https://r2.test/media/2026/10/trash.jpg?method=GET&expires=900",
    });
    expect(first.keyframe_uploads[0]!.key).toBe(`keyframes/${job.id}/0.jpg`);
    expect(first.keyframe_uploads).toHaveLength(8);
    expect(await claim()).toBeNull(); // leased

    h.advance(5 * 60_000); // lease expires
    const second = (await claim())!;
    expect(second).toMatchObject({ id: job.id, attempt: 2 });

    // The first attempt's late result is rejected.
    const stale = await complete({ job_id: job.id, attempt: 1, result: { detections: [] } });
    expect(stale.status).toBe(409);

    const done = await complete({
      job_id: job.id,
      attempt: 2,
      result: { detections: [{ name: "strawberries", confidence: 0.93 }] },
      keyframe_r2_keys: [`keyframes/${job.id}/0.jpg`],
    });
    expect(done.body).toMatchObject({
      outcome: "applied",
      job: { status: "completed", attempts: 2 },
    });

    // Trash Cam ≥ 0.8 and resolved → provisional consumed event → item flagged.
    const strawberries = await h.itemId("Strawberries");
    const [ev] = await h.db
      .select()
      .from(inventoryEvent)
      .where(eq(inventoryEvent.sourceRef, job.id));
    expect(ev).toMatchObject({
      itemId: strawberries,
      kind: "consumed",
      statusOverride: "consumed",
      source: "trash_cam",
      trust: "provisional",
      actorSystem: "worker",
      actorMemberId: await h.memberId(SAM),
    });
    const [state] = await h.db
      .select()
      .from(inventoryState)
      .where(eq(inventoryState.itemId, strawberries));
    expect(state!.statusOverride).toBe("consumed");
    const [row] = await h.db.select().from(auditJob).where(eq(auditJob.id, job.id));
    expect(row).toMatchObject({
      model: "qwen-vl:8b",
      promptVersion: "trash_cam.v1",
      keyframeR2Keys: [`keyframes/${job.id}/0.jpg`],
    });

    // Completing twice is stale too.
    expect(
      (await complete({ job_id: job.id, attempt: 2, result: { detections: [] } })).status,
    ).toBe(409);

    const pending = await notifications();
    expect(pending).toEqual([
      expect.objectContaining({
        job: expect.objectContaining({ id: job.id }),
        summary: "✅ Marked Strawberries as finished.",
      }),
    ]);
    const marked = await h.call<JobBody>(
      HANDLERS.jobsNotified.POST,
      `/api/jobs/${job.id}/notified`,
      {
        params: { id: job.id },
        body: {},
      },
    );
    expect(marked.body.job.notified_at).toBe(h.now());
    expect(await notifications()).toEqual([]);
  });

  it("failures retry until the third attempt, then fail with a failed_job review", async () => {
    const job = await create();
    for (const attempt of [1, 2]) {
      const c = (await claim())!;
      const res = await complete({
        job_id: job.id,
        attempt: c.attempt,
        status: "failed",
        error: `boom ${attempt}`,
      });
      expect(res.body).toMatchObject({
        outcome: "retry",
        job: { status: "queued", error: `boom ${attempt}` },
      });
    }
    const c = (await claim())!;
    const res = await complete({
      job_id: job.id,
      attempt: c.attempt,
      status: "failed",
      error: "boom 3",
    });
    expect(res.body).toMatchObject({ outcome: "failed", job: { status: "failed", attempts: 3 } });
    const [review] = await h.db
      .select()
      .from(reviewItem)
      .where(eq(reviewItem.id, res.body.review_ids[0]!));
    expect(review).toMatchObject({
      kind: "failed_job",
      jobId: job.id,
      defaultAction: { action: "dismiss" },
    });
    expect(await notifications()).toEqual([
      expect.objectContaining({ summary: "⚠️ Couldn't process this (boom 3)." }),
    ]);
    expect(await claim()).toBeNull();
  });

  it("a lease that expires on the last attempt fails the job", async () => {
    const job = await create();
    for (let i = 0; i < 3; i++) {
      expect((await claim())!.attempt).toBe(i + 1);
      h.advance(6 * 60_000);
    }
    expect(await claim()).toBeNull();
    const [row] = await h.db.select().from(auditJob).where(eq(auditJob.id, job.id));
    expect(row!.status).toBe("failed");
  });

  it("a low-confidence Trash Cam result becomes a review", async () => {
    const job = await create();
    const c = (await claim())!;
    const res = await complete({
      job_id: job.id,
      attempt: c.attempt,
      result: { detections: [{ name: "greek yogurt", confidence: 0.4 }] },
    });
    expect(res.body.outcome).toBe("review");
    const [review] = await h.db
      .select()
      .from(reviewItem)
      .where(and(eq(reviewItem.jobId, job.id), eq(reviewItem.kind, "trash_cam")));
    expect(review).toMatchObject({
      itemId: await h.itemId("Greek Yogurt"),
      expiresAt: "2026-10-27T16:00:00.000Z",
      defaultAction: { action: "none" },
    });
    expect((await notifications())[0]!.summary).toBe(
      "❓ Not sure what that was — it's in Cleanup.",
    );
  });

  it("merge suggestions become merge_suggestion reviews", async () => {
    const kombucha = await h.itemId("Kombucha");
    const eggs = await h.itemId("Eggs");
    const job = await create({
      job_type: "merge_suggest",
      media_r2_key: null,
      discord_message_id: null,
      input: {
        items: [
          { item_id: kombucha, name: "Kombucha" },
          { item_id: eggs, name: "Eggs" },
        ],
      },
    });
    const c = (await claim())!;
    expect(c.media_url).toBeNull();
    const res = await complete({
      job_id: job.id,
      attempt: c.attempt,
      result: { suggestions: [{ item_id: kombucha, merge_into_item_id: eggs, confidence: 0.9 }] },
    });
    expect(res.body).toMatchObject({ outcome: "review", review_ids: [expect.any(String)] });
    // Not from Discord → no notification.
    expect(await notifications()).toEqual([]);
  });

  // Regression: the result was turned into reviews unchecked — an unknown item id failed the whole
  // `complete` with a 500 (review_item.item_id FK), and a self-merge or an item merged meanwhile
  // became a review whose "Merge" button could only error.
  it("drops merge suggestions naming an unknown, the same or a merged item", async () => {
    const kombucha = await h.itemId("Kombucha");
    const eggs = await h.itemId("Eggs");
    const milk = await h.itemId("Whole Milk");
    await h.db.update(item).set({ mergedIntoItemId: eggs }).where(eq(item.id, milk));
    const job = await create({
      job_type: "merge_suggest",
      media_r2_key: null,
      input: {
        items: [
          { item_id: kombucha, name: "Kombucha" },
          { item_id: eggs, name: "Eggs" },
        ],
      },
    });
    const c = (await claim())!;
    const res = await complete({
      job_id: job.id,
      attempt: c.attempt,
      result: {
        suggestions: [
          { item_id: "01UNKNOWNITEM", merge_into_item_id: eggs, confidence: 0.9 },
          { item_id: kombucha, merge_into_item_id: kombucha, confidence: 0.9 },
          { item_id: milk, merge_into_item_id: kombucha, confidence: 0.9 },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "applied", review_ids: [] });
    const reviews = await h.db
      .select()
      .from(reviewItem)
      .where(eq(reviewItem.kind, "merge_suggestion"));
    expect(reviews).toEqual([]);
  });

  it("rejects a merge_suggest job without a valid MergeSuggestInput", async () => {
    const res = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", {
      body: { actor_discord_id: ALEX, job_type: "merge_suggest", input: { items: [] } },
    });
    expect(res).toMatchObject({
      status: 400,
      body: { error: "merge_suggest input must be a MergeSuggestInput" },
    });
  });

  it("validates job input", async () => {
    const res = await h.call(HANDLERS.jobsCreate.POST, "/api/jobs", {
      body: { actor_discord_id: ALEX, job_type: "paper_receipt" },
    });
    expect(res).toMatchObject({ status: 400, body: { error: "paper_receipt needs media_r2_key" } });
    const missing = await h.call(HANDLERS.jobsNotified.POST, "/api/jobs/nope/notified", {
      params: { id: "nope" },
      body: {},
    });
    expect(missing.status).toBe(404);
    const queued = await create();
    const early = await h.call(HANDLERS.jobsNotified.POST, `/api/jobs/${queued.id}/notified`, {
      params: { id: queued.id },
      body: {},
    });
    expect(early.status).toBe(409);
  });
});
