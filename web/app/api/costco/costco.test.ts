// Costco trips, the weekly cart's wait / bridge, store pins and trip expiry (DESIGN §4.8).
import { costcoTrip, groceryCycle, item, product, setting, systemTelemetry } from "@pandabase/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CycleT } from "@/lib/contracts";
import { countRoundTrips } from "@/test/roundTrips";
import { ALEX, setup, TOKENS, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup(); // seed "now": Tue 2026-10-20, 9am Los Angeles
});
afterEach(() => h.close());

type Body = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const plan = (plannedFor: string, extra: Record<string, unknown> = {}) =>
  h.call<Body>(HANDLERS.costcoTripPlan.POST, "/api/costco/trip", {
    body: { planned_for: plannedFor, ...extra },
  });
const current = async () =>
  (await h.call<Body>(HANDLERS.costcoTripCurrent.GET, "/api/costco/trip")).body;
const tripStatus = (id: string, status: "done" | "cancelled") =>
  h.call<Body>(HANDLERS.costcoTripStatus.POST, `/api/costco/trip/${id}/status`, {
    params: { id },
    body: { status, actor_discord_id: ALEX },
  });
const pin = (id: string, store: "costco" | "regular" | null, actor: string | null = ALEX) =>
  h.call<Body>(HANDLERS.itemStorePin.POST, `/api/items/${id}/store-pin`, {
    params: { id },
    body: actor ? { store, actor_discord_id: actor } : { store },
  });
const predictions = async () =>
  (await h.call<Body>(HANDLERS.predictions.GET, "/api/predictions")).body;
const events = (evs: Record<string, unknown>[]) =>
  h.call<Body>(HANDLERS.inventoryEvents.POST, "/api/inventory/events", {
    body: { actor_discord_id: ALEX, events: evs },
  });
const telemetry = async (metric: string) =>
  (await h.db.select().from(systemTelemetry).where(eq(systemTelemetry.metricType, metric))).map(
    (t) => t.payload as Body,
  );
const activeCycle = async () =>
  (await h.call<{ cycle: CycleT }>(HANDLERS.cycleCurrent.GET, "/api/grocery/cycle/current")).body
    .cycle;

/** Eggs down to 2 (0.55 days each): they run out tomorrow, so the restock rule plans them. */
const eggsRunningOut = async () => {
  const eggs = await h.itemId("Eggs");
  expect((await events([{ item_id: eggs, kind: "observed", quantity: 2 }])).status).toBe(200);
  return eggs;
};

describe("trips", () => {
  it("plans a trip with its list, moves it, and reads it back", async () => {
    expect(await current()).toEqual({ trip: null, lines: [] });
    const res = await plan("2026-10-24", { discord_thread_id: "m-1" });
    expect(res.status).toBe(200);
    const { trip, lines, created, moved_from } = res.body;
    expect([created, moved_from, trip.status, trip.planned_for]).toEqual([
      true,
      null,
      "planned",
      "2026-10-24",
    ]);
    // The seed's Costco items that are cheaper and keep (spinach spoils first, olive oil isn't
    // cheaper enough, items never bought at Costco stay off).
    const names = lines.map((l: Body) => l.name).sort();
    expect(names).toEqual(["Eggs", "Frozen Blueberries", "Jasmine Rice", "Toilet Paper"]);
    const eggs = lines.find((l: Body) => l.name === "Eggs");
    expect(eggs).toMatchObject({ reason: "runout", product: { vendor: "costco" } });
    expect(eggs.quantity).toBeGreaterThanOrEqual(1);
    expect(eggs.store_reason).toMatch(/^Costco: \d+% cheaper per egg than /);
    expect(trip.list).toEqual(lines); // snapshot as posted

    const moved = await plan("2026-10-25");
    expect(moved.body).toMatchObject({ created: false, moved_from: "2026-10-24" });
    expect(moved.body.trip).toMatchObject({ id: trip.id, discord_thread_id: "m-1" });
    expect((await current()).trip.planned_for).toBe("2026-10-25");
    expect(await h.db.select().from(costcoTrip)).toHaveLength(1);
    expect((await telemetry("costco_trip_planned")).map((t) => [t.created, t.movedFrom])).toEqual([
      [true, null],
      [false, "2026-10-24"],
    ]);
  });

  it.each([
    ["in the past", "2026-10-19", /in the past/],
    ["too far ahead", "2027-01-01", /more than 60 days ahead/],
    ["not a date", "Saturday", /invalid body/],
  ])("refuses a date %s", async (_, date, error) => {
    const res = await plan(date);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(error);
  });

  it("closes a trip done or cancelled; repeats are no-ops, changes are 409s", async () => {
    const { trip } = (await plan("2026-10-24")).body;
    const done = await tripStatus(trip.id, "done");
    expect(done.body).toMatchObject({
      changed: true,
      trip: { status: "done", close_reason: "back_from_costco", receipt_id: null },
    });
    expect(done.body.trip.closed_at).toBe(h.now());
    expect((await tripStatus(trip.id, "done")).body.changed).toBe(false);
    expect((await tripStatus(trip.id, "cancelled")).status).toBe(409);
    expect((await tripStatus("nope", "done")).status).toBe(404);
    expect(await current()).toEqual({ trip: null, lines: [] });
    const [closed] = await telemetry("costco_trip");
    expect(closed).toMatchObject({ tripId: trip.id, outcome: "done", listLines: 4, bridged: 0 });
    // A new trip can be planned once the last one is closed.
    expect((await plan("2026-11-14")).body.created).toBe(true);
  });

  it("closes the trip in a constant number of round trips", async () => {
    const { trip } = (await plan("2026-10-24")).body;
    const trips = countRoundTrips(h.db);
    await tripStatus(trip.id, "done");
    trips.restore();
    // Auth + config reads, then the service: one read batch, one write batch, commit.
    expect(trips.count()).toBeLessThanOrEqual(8);
  });
});

describe("the weekly cart and a planned trip (wait / bridge)", () => {
  it("leaves a Costco item out while a trip comes first, and bridges it otherwise", async () => {
    const eggs = await eggsRunningOut();
    // No trip: the eggs are planned from Whole Foods, bridging to Costco.
    let p = await predictions();
    const line = p.lines.find((l: Body) => l.item_id === eggs);
    expect(line.product.vendor).toBe("wholefoods");
    expect(line.store).toMatchObject({
      store: "costco",
      why: "cheaper",
      costco: { timing: "bridge", bridge_cause: "no_trip" },
    });
    expect(p.costco_waiting).toEqual([]);

    // A trip today, before they run out: they wait.
    const { trip } = (await plan("2026-10-20")).body;
    p = await predictions();
    expect(p.lines.some((l: Body) => l.item_id === eggs)).toBe(false);
    expect(p.costco_trip_date).toBe("2026-10-20");
    expect(p.costco_waiting).toEqual([
      expect.objectContaining({
        item_id: eggs,
        name: "Eggs",
        reason: expect.stringMatching(/^Costco/),
      }),
    ]);
    // Waiting isn't "please check" (they're planned, just for Costco).
    const checkin = (await h.call<Body>(HANDLERS.checkin.GET, "/api/grocery/checkin")).body;
    expect(checkin.please_check.map((x: Body) => x.item_id)).not.toContain(eggs);
    expect(checkin.likely_needed.map((x: Body) => x.item_id)).not.toContain(eggs);
    const cycle = await activeCycle();
    const cart = (
      await h.call<Body>(HANDLERS.cycleCart.GET, `/api/grocery/cycle/${cycle.id}/cart`, {
        params: { id: cycle.id },
      })
    ).body;
    expect(cart.costco_waiting.map((w: Body) => w.item_id)).toEqual([eggs]);
    expect(cart.lines.some((l: Body) => l.item_id === eggs)).toBe(false);

    // Moved past their runout: they bridge, and the cart says so.
    await plan("2026-10-31");
    const after = (
      await h.call<Body>(HANDLERS.cycleCart.GET, `/api/grocery/cycle/${cycle.id}/cart`, {
        params: { id: cycle.id },
      })
    ).body;
    const bridged = after.lines.find((l: Body) => l.item_id === eggs);
    expect(bridged.bridging_to_costco).toBe(true);
    expect(bridged.reason_text).toMatch(/^Bridging to Costco: runs out before the Oct 31 trip · /);
    expect(after.costco_waiting).toEqual([]);
    expect(trip.id).toBe((await current()).trip.id);
  });

  it("logs store_choice at the build and records bridged / waiting items in cart_result", async () => {
    const eggs = await eggsRunningOut();
    const tp = await h.itemId("Toilet Paper");
    await events([{ item_id: tp, kind: "consumed" }]); // out: bridges even with a trip planned
    const { trip } = (await plan("2026-10-20")).body;
    const cycle = await activeCycle();
    await h.call(HANDLERS.cycleStatus.POST, `/api/grocery/cycle/${cycle.id}/status`, {
      params: { id: cycle.id },
      body: { status: "building" },
    });
    const choices = await telemetry("store_choice");
    expect(choices.length).toBe(
      (await predictions()).lines.filter((l: Body) => l.store).length + 1,
    );
    const byItem = new Map(choices.map((c) => [c.itemId, c]));
    expect(byItem.get(eggs)).toMatchObject({ store: "costco", why: "cheaper", timing: "wait" });
    expect(byItem.get(tp)).toMatchObject({ timing: "bridge", bridgeCause: "needed_now" });
    expect(byItem.get(eggs)!.savingsRatio).toBeGreaterThan(0.15);

    const res = await h.call<{ cycle: CycleT }>(
      HANDLERS.cycleCartResult.POST,
      `/api/grocery/cycle/${cycle.id}/cart-result`,
      { params: { id: cycle.id }, body: { lines: [] } },
    );
    expect(res.body.cycle.cart_result).toMatchObject({
      costco_bridged_item_ids: [tp],
      costco_waiting_item_ids: [eggs],
    });
    await tripStatus(trip.id, "done");
    const [closed] = await telemetry("costco_trip");
    expect(closed).toMatchObject({ outcome: "done", bridged: 1 });
  });

  it("puts a waiting item back in the cart when someone adds it this week", async () => {
    const eggs = await eggsRunningOut();
    await plan("2026-10-20");
    const cycle = await activeCycle();
    await h.call(HANDLERS.cycleOverrides.POST, `/api/grocery/cycle/${cycle.id}/overrides`, {
      params: { id: cycle.id },
      body: { actor_discord_id: ALEX, kind: "add", item_id: eggs },
    });
    const p = await predictions();
    expect(p.costco_waiting).toEqual([]);
    expect(p.lines.find((l: Body) => l.item_id === eggs).store.costco).toEqual({
      timing: "bridge",
      bridge_cause: "needed_now",
    });
  });
});

describe("expiry (nothing blocks on a human)", () => {
  it("the daily cron cancels a trip a week past its date, and the cart stops waiting", async () => {
    const eggs = await eggsRunningOut();
    const { trip } = (await plan("2026-10-20")).body;
    const cron = () =>
      h.call<Body>(HANDLERS.cronMaintenance.GET, "/api/cron/maintenance", { auth: "cron" });
    h.setNow("2026-10-27T18:00:00.000Z"); // exactly tripExpireAfterDays later: still planned
    expect((await cron()).body.expired_costco_trips).toBe(0);
    h.setNow("2026-10-28T18:00:00.000Z");
    expect((await cron()).body.expired_costco_trips).toBe(1);
    const [row] = await h.db.select().from(costcoTrip).where(eq(costcoTrip.id, trip.id));
    expect(row).toMatchObject({ status: "cancelled", closeReason: "expired" });
    expect((await telemetry("costco_trip"))[0]).toMatchObject({ outcome: "expired" });
    expect((await cron()).body.expired_costco_trips).toBe(0); // idempotent
    const p = await predictions();
    expect(p.costco_trip_date).toBeNull();
    expect(p.costco_waiting.map((w: Body) => w.item_id)).not.toContain(eggs);
  });
});

describe("store pins", () => {
  const threshold = async () =>
    (await h.db.select().from(setting).where(eq(setting.key, "costco.switchThreshold")))[0]?.value;

  it('"get eggs at Whole Foods" pins them and raises the household Costco threshold', async () => {
    const eggs = await h.itemId("Eggs");
    const res = await pin(eggs, "regular");
    expect(res.body).toMatchObject({
      item_id: eggs,
      store_pin: "regular",
      choice: { store: "regular", why: "pinned" },
      switch_threshold: 0.2,
      threshold_changed: true,
    });
    expect(await threshold()).toBe(0.2);
    const [row] = await h.db.select().from(item).where(eq(item.id, eggs));
    expect(row!.storePin).toBe("regular");
    expect((await telemetry("store_override"))[0]).toMatchObject({
      itemId: eggs,
      from: null,
      to: "regular",
      kind: "store_override_to_regular",
      thresholdBefore: 0.15,
      thresholdAfter: 0.2,
    });
    // The pin keeps them off the trip list.
    const lines = (await plan("2026-10-24")).body.lines;
    expect(lines.map((l: Body) => l.name)).not.toContain("Eggs");

    // Clearing the pin teaches nothing; the threshold stays where the household moved it.
    const cleared = await pin(eggs, null);
    expect(cleared.body).toMatchObject({
      store_pin: null,
      threshold_changed: false,
      switch_threshold: 0.2,
    });
  });

  it("a pin that agrees with the choice, or one with no Costco product, only pins", async () => {
    const tp = await h.itemId("Toilet Paper");
    expect((await pin(tp, "costco")).body).toMatchObject({
      choice: { store: "costco", why: "pinned" },
      threshold_changed: false,
    });
    const milk = await h.itemId("Whole Milk");
    expect((await pin(milk, "costco")).body).toMatchObject({
      store_pin: "costco",
      // §4.8 step 1: a Costco pin needs a Costco purchase first.
      choice: { store: "regular", why: "no_costco_product" },
      threshold_changed: false,
    });
    expect(await threshold()).toBeUndefined();
  });

  it("needs the person who asked, and a real item", async () => {
    expect((await pin(await h.itemId("Eggs"), "regular", null)).status).toBe(400);
    expect((await pin("nope", "regular")).status).toBe(404);
    expect(
      (
        await h.call(HANDLERS.itemStorePin.POST, "/api/items/x/store-pin", {
          auth: { bearer: TOKENS.worker },
          params: { id: "x" },
          body: { store: "costco", actor_discord_id: ALEX },
        })
      ).status,
    ).toBe(403);
  });
});

describe('a text purchase "got 2 milk at Costco" (M10.2 gap, PLAN M10 Notes)', () => {
  it("records the purchase but creates no Costco product, so the item stays regular", async () => {
    const milk = await h.itemId("Whole Milk");
    const res = await events([{ item_id: milk, kind: "acquired", quantity: 2, vendor: "costco" }]);
    expect(res.status).toBe(200);
    const costco = await h.db
      .select()
      .from(product)
      .where(and(eq(product.itemId, milk), eq(product.vendor, "costco")));
    expect(costco).toEqual([]);
    expect((await pin(milk, null)).body.choice.why).toBe("no_costco_product");
    // The cycle state is untouched by the Costco purchase itself.
    expect(
      await h.db.select().from(groceryCycle).where(eq(groceryCycle.status, "open")),
    ).toHaveLength(1);
  });
});
