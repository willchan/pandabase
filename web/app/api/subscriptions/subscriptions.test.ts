// Subscribe & Save (DESIGN §4.9). Regression (2026-11): the Amazon cart filled with one-time buys
// of items the household already gets on Subscribe & Save.
import { subscription, systemTelemetry } from "@pandabase/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALEX, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

interface Plan {
  lines: { item_id: string | null; name: string; product: { asin: string | null } | null }[];
  subscribed: { item_id: string; name: string; asin: string; next_delivery_on: string | null }[];
}
const plan = async () => (await h.call<Plan>(HANDLERS.predictions.GET, "/api/predictions")).body;
const sync = (subscriptions: Record<string, unknown>[], account = ALEX) =>
  h.call<Record<string, unknown>>(HANDLERS.subscriptionsSync.POST, "/api/subscriptions/sync", {
    body: { account, subscriptions },
  });

/** A seeded line the plan buys as an ASIN. */
async function asinLine() {
  const line = (await plan()).lines.find((l) => l.item_id && l.product?.asin);
  expect(line).toBeDefined();
  return { itemId: line!.item_id!, asin: line!.product!.asin!, name: line!.name };
}

describe("POST /api/subscriptions/sync", () => {
  it("a subscribed item leaves the plan, the cart and please-check; ending it brings it back", async () => {
    const { itemId, asin, name } = await asinLine();
    const res = await sync([
      {
        asin,
        title: "Synthetic refill",
        next_delivery_on: "2026-11-29",
        schedule: "1 unit every 1 month",
      },
      { asin: "B0SYNTHX99", title: "Not in the catalog" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: 2, added: 2, ended: 0, reopened: 0 });

    let p = await plan();
    expect(p.lines.some((l) => l.item_id === itemId)).toBe(false);
    expect(p.subscribed).toEqual([
      expect.objectContaining({ item_id: itemId, name, asin, next_delivery_on: "2026-11-29" }),
    ]);

    const cycleId = (
      await h.call<{ cycle: { id: string } }>(
        HANDLERS.cycleCurrent.GET,
        "/api/grocery/cycle/current",
      )
    ).body.cycle.id;
    const cart = await h.call<{ lines: { item_id: string | null }[]; subscribed: unknown[] }>(
      HANDLERS.cycleCart.GET,
      `/api/grocery/cycle/${cycleId}/cart`,
      { params: { id: cycleId } },
    );
    expect(cart.body.lines.some((l) => l.item_id === itemId)).toBe(false);
    expect(cart.body.subscribed).toHaveLength(1);
    const checkin = await h.call<{ please_check: { item_id: string }[] }>(
      HANDLERS.checkin.GET,
      "/api/grocery/checkin",
    );
    expect(checkin.body.please_check.some((c) => c.item_id === itemId)).toBe(false);

    // Re-syncing the same list is a refresh, not a change.
    expect((await sync([{ asin }, { asin: "B0SYNTHX99" }])).body).toMatchObject({
      active: 2,
      added: 0,
      ended: 0,
    });

    // Cancelled on Amazon: the next sync no longer lists it.
    expect((await sync([{ asin: "B0SYNTHX99" }])).body).toMatchObject({ active: 1, ended: 1 });
    p = await plan();
    expect(p.lines.some((l) => l.item_id === itemId)).toBe(true);
    expect(p.subscribed).toEqual([]);

    // Re-subscribed: the ended row is reopened, not duplicated.
    expect((await sync([{ asin }, { asin: "B0SYNTHX99" }])).body).toMatchObject({ reopened: 1 });
    expect(await h.db.select().from(subscription)).toHaveLength(2);

    const tel = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "subscription_sync"));
    expect(tel).toHaveLength(4);
  });

  it("a subscription no sync has listed for staleAfterDays stops counting", async () => {
    const { itemId, asin } = await asinLine();
    await sync([{ asin }]);
    h.advance(22 * 86_400_000);
    const p = await plan();
    expect(p.subscribed.some((s) => s.item_id === itemId)).toBe(false);
  });

  it("rejects an unknown member and a malformed ASIN", async () => {
    expect((await sync([], "nobody@example.com")).status).toBe(400);
    expect((await sync([{ asin: "not-an-asin" }])).status).toBe(400);
  });
});
