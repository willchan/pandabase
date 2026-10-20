// Daily maintenance (DESIGN §4.6, §4.2 shelf life, §5 leases, §2.7 retention, §4.7 open-by).
import {
  auditJob,
  groceryCycle,
  idempotencyKey,
  inventoryEvent,
  reviewItem,
  systemTelemetry,
} from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

const DAY = 86_400_000;
const run = () =>
  h.call<Record<string, number | string | null>>(
    HANDLERS.cronMaintenance.GET,
    "/api/cron/maintenance",
    {
      auth: "cron",
    },
  );

describe("cron maintenance", () => {
  it("expires due reviews, discards expired perishables, purges old rows, releases leases", async () => {
    // A stale lease and an old idempotency key / telemetry row.
    const [queued] = await h.db.select().from(auditJob).where(eq(auditJob.status, "queued"));
    await h.db
      .update(auditJob)
      .set({ status: "claimed", attempts: 1, leaseExpiresAt: "2026-10-20T15:00:00.000Z" })
      .where(eq(auditJob.id, queued!.id));
    await h.db.insert(idempotencyKey).values({
      key: "old",
      scope: "agent:x",
      responseStatus: 200,
      responseBody: {},
      createdAt: "2026-10-18T00:00:00.000Z",
    });
    await h.db.insert(systemTelemetry).values({
      id: "01OLD",
      source: "api",
      metricType: "api_request",
      payload: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const first = await run();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      expired_reviews: 0,
      released_leases: 1,
      failed_jobs: 0,
      purged_idempotency_keys: 1,
      purged_telemetry: 1,
      opened_cycle_id: null,
    });
    expect(first.body.presumed_discards).toBeGreaterThanOrEqual(0);
    const [released] = await h.db.select().from(auditJob).where(eq(auditJob.id, queued!.id));
    expect(released).toMatchObject({ status: "queued", leaseExpiresAt: null });

    // Two weeks on: the seeded receipt review (14d) and failed_job review (14d) are past due,
    // and perishables bought long ago are presumed discarded.
    h.advance(15 * DAY);
    const later = await run();
    expect(later.body.expired_reviews).toBeGreaterThanOrEqual(2);
    expect(later.body.presumed_discards).toBeGreaterThan(0);
    const expired = await h.db.select().from(reviewItem).where(eq(reviewItem.status, "expired"));
    expect(expired.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["receipt", "failed_job", "trash_cam"]),
    );
    const unverified = await h.db
      .select()
      .from(reviewItem)
      .where(eq(reviewItem.kind, "unverified_item"));
    expect(unverified.every((r) => r.status === "pending")).toBe(true);
    const discards = await h.db
      .select()
      .from(inventoryEvent)
      .where(
        and(eq(inventoryEvent.kind, "presumed_discarded"), eq(inventoryEvent.occurredAt, h.now())),
      );
    expect(discards.length).toBe(later.body.presumed_discards);
    expect(discards.every((d) => d.trust === "provisional" && d.source === "system")).toBe(true);
    const metrics = (
      await h.db.select().from(systemTelemetry).where(eq(systemTelemetry.source, "cron"))
    ).map((t) => t.metricType);
    expect(metrics).toEqual(
      expect.arrayContaining(["review_expired", "presumed_discarded", "maintenance_run"]),
    );

    // Idempotent: a second run the same day finds nothing new.
    const again = await run();
    expect(again.body).toMatchObject({
      expired_reviews: 0,
      presumed_discards: 0,
      released_leases: 0,
    });
  });

  it("opens the next cycle by Monday 9am if the agent didn't", async () => {
    const [open] = await h.db.select().from(groceryCycle).where(eq(groceryCycle.status, "open"));
    await h.db
      .update(groceryCycle)
      .set({ status: "closed", closedAt: "2026-10-24T20:00:00.000Z", closeReason: "done" })
      .where(eq(groceryCycle.id, open!.id));
    h.setNow("2026-10-26T15:00:00.000Z"); // Mon 8am PT: not yet
    expect((await run()).body.opened_cycle_id).toBeNull();
    h.setNow("2026-10-26T16:30:00.000Z"); // Mon 9:30am PT
    const res = await run();
    expect(res.body.opened_cycle_id).toEqual(expect.any(String));
    const [c] = await h.db
      .select()
      .from(groceryCycle)
      .where(eq(groceryCycle.id, res.body.opened_cycle_id as string));
    expect(c).toMatchObject({ weekLabel: "2026-W44", status: "open", discordThreadId: null });
    // The agent's open call later attaches its thread.
    const opened = await h.call<{
      created: boolean;
      cycle: { id: string; discord_thread_id: string };
    }>(HANDLERS.cycleOpen.POST, "/api/grocery/cycle/open", { body: { discord_thread_id: "t-99" } });
    expect(opened.body).toMatchObject({
      created: false,
      cycle: { id: c!.id, discord_thread_id: "t-99" },
    });
  });
});
