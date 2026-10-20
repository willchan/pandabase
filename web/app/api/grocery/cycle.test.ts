// Grocery cycle lifecycle (DESIGN §4.3, §4.4, §4.7): overrides, predictions with price quotes,
// nudge, build, cart, cart result, closure by the ingested order, skip / other store / away.
import { groceryCycle, item, preferenceEvent, systemTelemetry } from "@pandabase/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CycleT } from "@/lib/contracts";
import { ALEX, SAM, setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

interface ProductRef {
  id: string;
  title: string;
  vendor: string;
  quote_cents: number | null;
}
interface PlanLine {
  item_id: string | null;
  name: string;
  free_text: string | null;
  quantity: number;
  reason: string | null;
  overrides: string[];
  product: ProductRef | null;
  candidates: ProductRef[];
  needs_price_check: boolean;
}
interface CartLine {
  item_id: string | null;
  product: ProductRef | null;
  quantity: number;
  reason_text: string;
  switched: boolean;
}

const current = async () =>
  (await h.call<{ cycle: CycleT | null }>(HANDLERS.cycleCurrent.GET, "/api/grocery/cycle/current"))
    .body.cycle;
const open = (thread = "t-new") =>
  h.call<{ cycle: CycleT; created: boolean }>(HANDLERS.cycleOpen.POST, "/api/grocery/cycle/open", {
    body: { discord_thread_id: thread },
  });
const status = (id: string, s: string, reason?: string) =>
  h.call<{ cycle: CycleT; changed: boolean }>(
    HANDLERS.cycleStatus.POST,
    `/api/grocery/cycle/${id}/status`,
    {
      params: { id },
      body: { status: s, reason, actor_discord_id: ALEX },
    },
  );
const override = (id: string, body: Record<string, unknown>) =>
  h.call(HANDLERS.cycleOverrides.POST, `/api/grocery/cycle/${id}/overrides`, {
    params: { id },
    body: { actor_discord_id: SAM, ...body },
  });
const plan = async (cycleId?: string) =>
  (
    await h.call<{
      lines: PlanLine[];
      skipped_item_ids: string[];
      needs_price_check_item_ids: string[];
    }>(HANDLERS.predictions.GET, "/api/predictions", {
      query: cycleId ? { cycle_id: cycleId } : {},
    })
  ).body;
const cart = async (id: string) =>
  (
    await h.call<{ lines: CartLine[] }>(HANDLERS.cycleCart.GET, `/api/grocery/cycle/${id}/cart`, {
      params: { id },
    })
  ).body.lines;

describe("cycle lifecycle", () => {
  it("open cycle: overrides + price quotes drive predictions and the cart; learning on product override", async () => {
    const cycle = (await current())!;
    expect(cycle).toMatchObject({ week_label: "2026-W43", status: "open" });
    // Opening while a cycle is active is idempotent.
    expect((await open()).body).toMatchObject({ created: false, cycle: { id: cycle.id } });

    const coffee = await h.itemId("Coffee Beans");
    const ridgeline = await h.productId("Ridgeline Roasters House Blend 12oz");
    const summit = await h.productId("Summit Coffee Dark Roast Whole Bean 18oz");
    expect((await override(cycle.id, { kind: "add", item_id: coffee, quantity: 1 })).status).toBe(
      200,
    );

    // Seeded overrides: free-text add, skip ice cream, qty bananas.
    let p = await plan();
    const byName = (n: string) => p.lines.find((l) => l.name === n);
    expect(byName("birthday candles")).toMatchObject({
      free_text: "birthday candles",
      item_id: null,
      quantity: 1,
    });
    expect(byName("Bananas")).toMatchObject({ quantity: 2, overrides: ["qty"] });
    expect(p.lines.some((l) => l.name === "Ice Cream")).toBe(false);
    const coffeeLine = byName("Coffee Beans")!;
    expect(coffeeLine).toMatchObject({ needs_price_check: true, quantity: 1, overrides: ["add"] });
    expect(coffeeLine.candidates.map((c) => c.id).sort()).toEqual([ridgeline, summit].sort());
    expect(p.needs_price_check_item_ids).toContain(coffee);

    // The agent posts quotes: Ridgeline is now 40% cheaper per oz than the usual Summit.
    const quotes = await h.call(HANDLERS.priceQuotes.POST, "/api/grocery/price-quotes", {
      body: {
        cycle_id: cycle.id,
        quotes: [
          { product_id: ridgeline, price_cents: 600 },
          { product_id: summit, price_cents: 1499 },
        ],
      },
    });
    expect(quotes.body).toEqual({ accepted: 2 });
    p = await plan(cycle.id);
    expect(byName("Coffee Beans")!.product).toMatchObject({ id: ridgeline, quote_cents: 600 });
    const coffeeCart = (await cart(cycle.id)).find((l) => l.item_id === coffee)!;
    expect(coffeeCart).toMatchObject({ switched: true, product: { id: ridgeline } });
    expect(coffeeCart.reason_text).toBe(
      "40% cheaper per oz than your usual Summit Coffee Dark Roast Whole Bean 18oz",
    );

    // "Get the usual" → override toward the pricier preferred product raises the threshold.
    expect(
      (await override(cycle.id, { kind: "product", item_id: coffee, product_id: summit })).status,
    ).toBe(200);
    const [it] = await h.db.select().from(item).where(eq(item.id, coffee));
    expect(it!.switchThreshold).toBe(0.2);
    const events = await h.db
      .select()
      .from(preferenceEvent)
      .where(eq(preferenceEvent.cycleId, cycle.id));
    expect(events).toEqual([
      expect.objectContaining({
        kind: "override_to_preferred",
        fromProductId: ridgeline,
        toProductId: summit,
        thresholdAfter: 0.2,
      }),
    ]);
    expect((await cart(cycle.id)).find((l) => l.item_id === coffee)).toMatchObject({
      switched: false,
      reason_text: "Your pick: Summit Coffee Dark Roast Whole Bean 18oz",
    });

    // Bad overrides.
    expect((await override(cycle.id, { kind: "skip" })).status).toBe(400);
    expect(
      (
        await override(cycle.id, {
          kind: "product",
          item_id: coffee,
          product_id: await h.productId("Organic Lemon"),
        })
      ).status,
    ).toBe(400);
    expect((await override(cycle.id, { kind: "qty", item_id: coffee })).status).toBe(400);
  });

  it("nudge → check-in → build → cart result → order ingested → closed → next cycle", async () => {
    const cycle = (await current())!;
    const nudged = await status(cycle.id, "nudged");
    expect(nudged.body).toMatchObject({
      changed: true,
      cycle: { status: "open", nudge_sent_at: h.now() },
    });
    expect((await status(cycle.id, "nudged")).body.changed).toBe(false);
    expect((await status(cycle.id, "ready")).status).toBe(409);

    const checkin = await h.call<{
      cycle_id: string;
      likely_needed: { item_id: string; reason: string }[];
      please_check: { reason: string }[];
      freezer: { name: string; quantity: number }[];
      pending_review_count: number;
    }>(HANDLERS.checkin.GET, "/api/grocery/checkin");
    expect(checkin.body.cycle_id).toBe(cycle.id);
    expect(checkin.body.likely_needed.length).toBeGreaterThan(0);
    expect(checkin.body.freezer).toHaveLength(3); // the 3 oldest (see freezer aging tests)
    expect(checkin.body.pending_review_count).toBe(5);
    expect(
      checkin.body.please_check.every((x) => ["near_runout", "audit_hint"].includes(x.reason)),
    ).toBe(true);

    h.advance(4 * 86_400_000); // Saturday
    expect((await status(cycle.id, "building")).body.cycle.status).toBe("building");
    const lines = (await cart(cycle.id)).filter((l) => l.product);
    expect(lines.length).toBeGreaterThan(1);
    const [failed, ...added] = lines;
    const result = await h.call<{ cycle: CycleT }>(
      HANDLERS.cycleCartResult.POST,
      `/api/grocery/cycle/${cycle.id}/cart-result`,
      {
        params: { id: cycle.id },
        body: {
          lines: [
            {
              item_id: failed!.item_id,
              product_id: failed!.product!.id,
              quantity: failed!.quantity,
              outcome: "failed",
              error: "out of stock",
            },
            ...added.map((l) => ({
              item_id: l.item_id,
              product_id: l.product!.id,
              quantity: l.quantity,
              outcome: "tier1",
            })),
          ],
        },
      },
    );
    expect(result.status).toBe(200);
    const ready = result.body.cycle;
    expect(ready).toMatchObject({ status: "ready", built_at: h.now() });
    expect(ready.cart_result!.vendors).toContain("wholefoods");
    expect(ready.cart_result!.lines).toHaveLength(lines.length);
    const lineTelemetry = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "cart_line_result"));
    expect(lineTelemetry.map((t) => (t.payload as { outcome: string }).outcome).sort()).toEqual(
      [...added.map(() => "tier1"), "failed"].sort(),
    );

    // The pickup order's digital receipt closes the cycle.
    h.advance(3 * 3_600_000);
    const tp = added.find((l) => l.product!.vendor === "wholefoods")!;
    const receipt = await h.call<{ closed_cycle_id: string | null }>(
      HANDLERS.receiptsIngest.POST,
      "/api/receipts/ingest",
      {
        body: {
          actor_discord_id: ALEX,
          source: "digital",
          vendor: "wholefoods",
          account: ALEX,
          external_order_id: "WF-PICKUP-1",
          fulfillment: "pickup",
          acquired_at: h.now(),
          lines: [
            {
              raw_text: tp.product!.title,
              qty: 1,
              item_id: tp.item_id,
              product_id: tp.product!.id,
            },
          ],
        },
      },
    );
    expect(receipt.body.closed_cycle_id).toBe(cycle.id);
    const [closed] = await h.db.select().from(groceryCycle).where(eq(groceryCycle.id, cycle.id));
    expect(closed).toMatchObject({ status: "closed", closeReason: "order_ingested" });
    expect(await current()).toBeNull();

    // Next cycle opens immediately for the next free week.
    const next = await open("t-44");
    expect(next.body).toMatchObject({
      created: true,
      cycle: { week_label: "2026-W44", status: "open", discord_thread_id: "t-44" },
    });
  });

  it("skip, other store and away", async () => {
    const w43 = (await current())!;
    expect((await status(w43.id, "skipped", "busy week")).body.cycle).toMatchObject({
      status: "skipped",
      close_reason: "busy week",
      closed_at: h.now(),
    });
    expect((await status(w43.id, "closed")).status).toBe(409);
    expect((await override(w43.id, { kind: "add", free_text: "x" })).status).toBe(409);

    const w44 = (await open()).body.cycle;
    expect(w44.week_label).toBe("2026-W44");
    expect((await status(w44.id, "other_store")).body.cycle).toMatchObject({
      status: "other_store",
      close_reason: "other_store",
    });

    const w45 = (await open()).body.cycle;
    expect(w45.week_label).toBe("2026-W45");
    // Away over W45's Saturday (Nov 7): the build becomes a skip, and away days are recorded.
    const away = await h.call(HANDLERS.awayPeriods.POST, "/api/away-periods", {
      body: {
        actor_discord_id: ALEX,
        starts_on: "2026-11-05",
        ends_on: "2026-11-09",
        note: "trip",
      },
    });
    expect(away.status).toBe(200);
    expect((await status(w45.id, "building")).body.cycle).toMatchObject({
      status: "skipped",
      close_reason: "away",
    });

    const bad = await h.call(HANDLERS.awayPeriods.POST, "/api/away-periods", {
      body: { actor_discord_id: ALEX, starts_on: "2026-11-09", ends_on: "2026-11-05" },
    });
    expect(bad.status).toBe(400);
    expect((await status("nope", "skipped")).status).toBe(404);
  });

  it("a build that picks the cheaper product logs a switch event", async () => {
    const cycle = (await current())!;
    const coffee = await h.itemId("Coffee Beans");
    const ridgeline = await h.productId("Ridgeline Roasters House Blend 12oz");
    await override(cycle.id, { kind: "add", item_id: coffee });
    await h.call(HANDLERS.priceQuotes.POST, "/api/grocery/price-quotes", {
      body: { cycle_id: cycle.id, quotes: [{ product_id: ridgeline, price_cents: 600 }] },
    });
    await status(cycle.id, "building");
    const res = await h.call<{ cycle: CycleT }>(
      HANDLERS.cycleCartResult.POST,
      `/api/grocery/cycle/${cycle.id}/cart-result`,
      {
        params: { id: cycle.id },
        body: {
          lines: [{ item_id: coffee, product_id: ridgeline, quantity: 1, outcome: "tier2" }],
          order_ids: ["WF-1"],
        },
      },
    );
    expect(res.body.cycle).toMatchObject({
      status: "ready",
      cart_result: { order_ids: ["WF-1"], vendors: ["wholefoods"] },
    });
    const events = await h.db
      .select()
      .from(preferenceEvent)
      .where(eq(preferenceEvent.cycleId, cycle.id));
    expect(events.map((e) => [e.kind, e.toProductId])).toEqual([["switch", ridgeline]]);
  });
});
