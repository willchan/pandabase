// Inventory events (counts, flags, consumed, moved, text purchases), lookup, freezer aging,
// "never buy X", client telemetry.
import { inventoryEvent, product, receipt, systemTelemetry } from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALEX, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

interface EventsBody {
  event_ids: string[];
  receipt_id: string | null;
  estimates: { item_id: string; on_hand: number; status: string }[];
}
const post = (events: Record<string, unknown>[], headers?: Record<string, string>) =>
  h.call<EventsBody>(HANDLERS.inventoryEvents.POST, "/api/inventory/events", {
    body: { actor_discord_id: ALEX, events },
    headers,
  });
const telemetry = async (metric: string) =>
  (await h.db.select().from(systemTelemetry).where(eq(systemTelemetry.metricType, metric))).map(
    (t) => t.payload as Record<string, unknown>,
  );

describe("inventory events", () => {
  it("a count re-anchors the estimate and logs estimate_vs_observed", async () => {
    const eggs = await h.itemId("Eggs");
    const before = await telemetry("estimate_vs_observed");
    const res = await post([{ item_id: eggs, kind: "observed", quantity: 7, source: "checkin" }]);
    expect(res.status).toBe(200);
    expect(res.body.estimates).toEqual([expect.objectContaining({ item_id: eggs, on_hand: 7 })]);
    const [ev] = await h.db
      .select()
      .from(inventoryEvent)
      .where(eq(inventoryEvent.id, res.body.event_ids[0]!));
    expect(ev).toMatchObject({
      kind: "observed",
      quantity: 7,
      location: "fridge",
      source: "checkin",
      actorSystem: "agent",
      trust: "confirmed",
    });
    const after = await telemetry("estimate_vs_observed");
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      itemId: eggs,
      item: "Eggs",
      observed: 7,
      estimated: expect.any(Number),
      location: "fridge",
    });
  });

  // Regression: shelf life ran FIFO over acquisitions only, so counting chicken bought outside its
  // 3-day shelf life read as 0 on hand and the daily cron presumed the counted units discarded.
  it("a fresh count of a perishable bought long ago is on hand, and the cron keeps it", async () => {
    const chicken = await h.itemId("Chicken Thighs"); // shelf life 3 days
    h.advance(10 * 86_400_000); // every seeded acquisition is past its shelf life
    const res = await post([
      { item_id: chicken, kind: "observed", quantity: 2 }, // fridge
      { item_id: chicken, kind: "observed", quantity: 0, location: "freezer" }, // no reserve
    ]);
    expect(res.body.estimates).toEqual([expect.objectContaining({ item_id: chicken, on_hand: 2 })]);
    const cron = await h.call<{ presumed_discards: number }>(
      HANDLERS.cronMaintenance.GET,
      "/api/cron/maintenance",
      { auth: "cron" },
    );
    expect(cron.status).toBe(200);
    const discarded = await h.db
      .select()
      .from(inventoryEvent)
      .where(
        and(
          eq(inventoryEvent.itemId, chicken),
          eq(inventoryEvent.kind, "presumed_discarded"),
          eq(inventoryEvent.occurredAt, h.now()),
        ),
      );
    expect(discarded).toEqual([]);
  });

  it("critical flag, we're out, discarded", async () => {
    const milk = await h.itemId("Whole Milk");
    const yogurt = await h.itemId("Greek Yogurt");
    const res = await post([
      { item_id: milk, kind: "critical" },
      { item_id: yogurt, kind: "consumed" },
    ]);
    const est = Object.fromEntries(res.body.estimates.map((e) => [e.item_id, e]));
    expect(est[milk]!.status).toBe("critical");
    expect(est[yogurt]).toMatchObject({ status: "consumed", on_hand: 0 });
    const [flag] = await h.db
      .select()
      .from(inventoryEvent)
      .where(eq(inventoryEvent.id, res.body.event_ids[0]!));
    expect(flag).toMatchObject({ kind: "observed", quantity: null, statusOverride: "critical" });
    // No quantity = everything at that location (see the regression test below).
    expect((await post([{ item_id: milk, kind: "discarded" }])).status).toBe(200);
  });

  it("moving stock to the freezer shows up in freezer aging", async () => {
    const beef = await h.itemId("Peanut Butter"); // pantry, no shelf life
    const before = (await post([{ item_id: beef, kind: "observed", quantity: 2 }])).body;
    expect(before.estimates[0]!.on_hand).toBe(2);
    h.advance(60_000);
    expect(
      (await post([{ item_id: beef, kind: "moved", quantity: 1, to_location: "freezer" }])).status,
    ).toBe(200);
    const aging = await h.call<{
      items: { item_id: string; quantity: number; frozen_at: string | null }[];
    }>(HANDLERS.freezerAging.GET, "/api/freezer/aging", { query: { limit: "50" } });
    expect(aging.body.items.find((i) => i.item_id === beef)).toEqual(
      expect.objectContaining({ quantity: 1, frozen_at: h.now() }),
    );
    // Oldest first.
    const since = aging.body.items.map((i) => i.frozen_at ?? "");
    expect(aging.body.items.length).toBeGreaterThan(1);
    expect(since.at(-1)).toBe(h.now());
    expect((await post([{ item_id: beef, kind: "moved", quantity: 1 }])).status).toBe(400);
    const limited = await h.call<{ items: unknown[] }>(
      HANDLERS.freezerAging.GET,
      "/api/freezer/aging",
      { query: { limit: "1" } },
    );
    expect(limited.body.items).toHaveLength(1);
  });

  // Regression (system test, tier A): discord-intake sends "froze the chicken" / "threw out the
  // spinach" without a quantity (people don't say how much), and the API answered 400.
  it("moved / discarded without a quantity take everything at that location", async () => {
    const pb = await h.itemId("Peanut Butter"); // pantry
    await post([{ item_id: pb, kind: "observed", quantity: 3 }]);
    h.advance(60_000);
    const moved = await post([{ item_id: pb, kind: "moved", to_location: "freezer" }]);
    expect(moved.status).toBe(200);
    const [ev] = await h.db
      .select()
      .from(inventoryEvent)
      .where(eq(inventoryEvent.id, moved.body.event_ids[0]!));
    expect(ev).toMatchObject({ kind: "moved", location: "pantry", toLocation: "freezer" });
    expect(ev!.quantity).toBeCloseTo(3, 2); // minus a minute of estimated use
    h.advance(60_000);
    const tossed = await post([{ item_id: pb, kind: "discarded", location: "freezer" }]);
    expect(tossed.status).toBe(200);
    expect(tossed.body.estimates[0]!.on_hand).toBe(0);
  });

  it("text purchases become a manual receipt (EMA, stats) — idempotent with the key", async () => {
    const eggs = await h.itemId("Eggs");
    const headers = { "idempotency-key": "bought-eggs-1" };
    const res = await post(
      [{ item_id: eggs, kind: "acquired", quantity: 1, vendor: "wholefoods" }],
      headers,
    );
    expect(res.status).toBe(200);
    const [r] = await h.db.select().from(receipt).where(eq(receipt.id, res.body.receipt_id!));
    expect(r).toMatchObject({
      source: "manual",
      vendor: "wholefoods",
      dedupeKey: "manual:bought-eggs-1:wholefoods",
      status: "applied",
    });
    const [ev] = await h.db
      .select()
      .from(inventoryEvent)
      .where(eq(inventoryEvent.sourceRef, r!.id));
    expect(ev).toMatchObject({
      itemId: eggs,
      kind: "acquired",
      quantity: 12,
      source: "manual",
      trust: "confirmed",
    });
    const replay = await post(
      [{ item_id: eggs, kind: "acquired", quantity: 1, vendor: "wholefoods" }],
      headers,
    );
    expect(replay.body).toEqual(res.body);
    expect(await h.db.select().from(receipt).where(eq(receipt.source, "manual"))).toHaveLength(1);
  });

  it("unknown items are 404s", async () => {
    expect((await post([{ item_id: "nope", kind: "consumed" }])).status).toBe(404);
  });
});

describe("item lookup", () => {
  it("answers with matches, estimate and a confidence hint", async () => {
    const res = await h.call<{
      matches: { name: string; text: string; confidence: string; by_location: unknown[] }[];
    }>(HANDLERS.itemsLookup.GET, "/api/items/lookup", { query: { q: "eggs" } });
    const [top] = res.body.matches;
    expect(top).toMatchObject({
      name: "Eggs",
      confidence: expect.stringMatching(/^(high|medium|low)$/),
    });
    expect(top!.text).toMatch(
      /^~[\d.]+ eggs \((counted|bought) [A-Z][a-z]{2} \d+(, unverified)?\) → /,
    );
    expect(top!.by_location.length).toBeGreaterThan(0);
    const none = await h.call<{ matches: unknown[] }>(
      HANDLERS.itemsLookup.GET,
      "/api/items/lookup",
      { query: { q: "zzzz" } },
    );
    expect(none.body.matches).toEqual([]);
  });
});

describe("never buy X", () => {
  it("rejects the product once and logs a preference event", async () => {
    const id = await h.productId("Pasture Hen Large Eggs 12ct");
    const reject = () =>
      h.call<{ changed: boolean; stance: string }>(
        HANDLERS.productReject.POST,
        `/api/products/${id}/reject`,
        {
          params: { id },
          body: { actor_discord_id: ALEX },
        },
      );
    expect((await reject()).body).toMatchObject({ stance: "rejected", changed: true });
    expect((await reject()).body.changed).toBe(false);
    const [p] = await h.db.select().from(product).where(eq(product.id, id));
    expect(p!.stance).toBe("rejected");
    expect(await telemetry("preference_event")).toEqual([
      expect.objectContaining({ kind: "reject", fromProductId: id }),
    ]);
  });
});

describe("client telemetry", () => {
  it("stores batched events with the caller as source", async () => {
    const res = await h.call(HANDLERS.telemetry.POST, "/api/telemetry", {
      auth: "worker",
      body: {
        events: [
          { metric_type: "vlm_inference", payload: { model: "qwen-vl:8b", latency_ms: 4200 } },
          { metric_type: "vlm_parse_failure", payload: {}, occurred_at: "2026-10-19T10:00:00Z" },
        ],
      },
    });
    expect(res.body).toEqual({ accepted: 2 });
    const rows = await h.db
      .select()
      .from(systemTelemetry)
      .where(and(eq(systemTelemetry.source, "worker")));
    expect(rows.map((r) => [r.metricType, r.createdAt])).toEqual([
      ["vlm_inference", h.now()],
      ["vlm_parse_failure", "2026-10-19T10:00:00.000Z"],
    ]);
    const bad = await h.call(HANDLERS.telemetry.POST, "/api/telemetry", {
      body: { events: [{ metric_type: "Bad Name", payload: {} }] },
    });
    expect(bad.status).toBe(400);
  });
});
