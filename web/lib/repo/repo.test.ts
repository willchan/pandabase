// Drizzle repositories against the seeded database (in-memory libSQL).
import { groceryCycle, inventoryState, item, setting } from "@pandabase/db";
import { rebuildInventoryState } from "@pandabase/db/rebuild-state";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { setup, SEED_NOW, type Harness } from "@/test/harness";
import { lastBuiltCycle, parseCartResult } from "./cycles";
import { loadEstimates, refreshInventoryState } from "./inventory";
import { receiptRepository } from "./receipts";
import { loadConfig } from "./settings";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

describe("receiptRepository", () => {
  it("maps aliases, products by ASIN (case-insensitive), items, history", async () => {
    const repo = receiptRepository(h.db);
    const aliases = await repo.aliases("wholefoods");
    expect(aliases.find((a) => a.vendorString === "BAG FEE")).toMatchObject({
      ignored: true,
      itemId: null,
    });
    expect(aliases.every((a) => a.vendor === "wholefoods")).toBe(true);

    const byAsin = await repo.productsByAsin("amazon", ["b0seed0004", "B0NOPE"]);
    expect(byAsin).toEqual([expect.objectContaining({ asin: "B0SEED0004", vendor: "amazon" })]);

    const eggs = await h.itemId("Eggs");
    expect(await repo.item(eggs)).toMatchObject({
      id: eggs,
      canonicalName: "Eggs",
      trackingType: "velocity",
      emaDays: expect.any(Number),
      outlierStreak: 0,
      outlierDirection: null,
      defaultLocation: "fridge",
      switchThreshold: 0.15,
    });
    await expect(repo.item("nope")).rejects.toThrow(/not found/);
    const products = await repo.products(eggs);
    expect(products.map((p) => p.unitQuantity)).toEqual([12, 12]);
    const acq = await repo.acquisitions(eggs);
    expect(acq.length).toBeGreaterThan(5);
    expect(acq.map((a) => a.at)).toEqual([...acq.map((a) => a.at)].sort());
    expect((await repo.inventory(eggs))[0]).toMatchObject({
      location: "fridge",
      anchorAt: expect.any(String),
    });
    expect(await repo.awayPeriods()).toHaveLength(1);

    const canonical = await repo.canonicalItems();
    expect(canonical).toHaveLength(42);
    await h.db
      .update(item)
      .set({ mergedIntoItemId: eggs })
      .where(eq(item.id, await h.itemId("Kombucha")));
    expect(await repo.canonicalItems()).toHaveLength(41);
  });

  it("lastBuiltCycle reads cart_result; foreign shapes are ignored", async () => {
    // Seeded cycles store a summary, not the M4 shape.
    const seeded = await lastBuiltCycle(h.db);
    expect(seeded).toMatchObject({ status: "closed", cartVendors: [], orderIds: [], lines: [] });
    expect(parseCartResult({ vendor: "wholefoods", lines: 3 })).toBeNull();

    const [open] = await h.db.select().from(groceryCycle).where(eq(groceryCycle.status, "open"));
    await h.db
      .update(groceryCycle)
      .set({
        status: "ready",
        builtAt: SEED_NOW,
        cartResult: {
          vendors: ["wholefoods"],
          order_ids: ["o-1"],
          lines: [
            { item_id: "i1", product_id: "p1", quantity: 1, outcome: "tier1" },
            { item_id: "i2", product_id: "p2", quantity: 1, outcome: "failed" },
            {
              item_id: null,
              product_id: null,
              free_text: "candles",
              quantity: 1,
              outcome: "tier2",
            },
          ],
          please_check_item_ids: ["i3"],
          recorded_at: SEED_NOW,
        },
      })
      .where(eq(groceryCycle.id, open!.id));
    expect(await lastBuiltCycle(h.db)).toEqual({
      cycleId: open!.id,
      status: "ready",
      builtAt: SEED_NOW,
      cartVendors: ["wholefoods"],
      orderIds: ["o-1"],
      lines: [{ itemId: "i1", productId: "p1" }],
      pleaseCheckItemIds: ["i3"],
    });
  });
});

describe("inventory", () => {
  it("refreshInventoryState matches a full rebuild", async () => {
    const all = await h.db.select({ id: item.id }).from(item);
    await h.db.delete(inventoryState);
    await refreshInventoryState(
      h.db,
      all.map((i) => i.id),
      SEED_NOW,
      DEFAULT_CONFIG,
    );
    const partial = await h.db.select().from(inventoryState);
    await rebuildInventoryState(h.db, SEED_NOW, { tz: DEFAULT_CONFIG.householdTz });
    const full = await h.db.select().from(inventoryState);
    const key = (r: (typeof full)[number]) => `${r.itemId}:${r.location}`;
    expect(partial.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      full.sort((a, b) => key(a).localeCompare(key(b))),
    );
    await refreshInventoryState(h.db, [], SEED_NOW, DEFAULT_CONFIG);
  });

  it("loadEstimates covers active items with last purchase / count", async () => {
    const est = await loadEstimates(h.db, SEED_NOW, DEFAULT_CONFIG);
    expect(est.size).toBe(42);
    const eggs = est.get(await h.itemId("Eggs"))!;
    expect(eggs.lastVerifiedAt).not.toBeNull();
    expect(eggs.lastAcquired).toMatchObject({ trust: "confirmed" });
    expect(eggs.estimate.onHand).toBeGreaterThan(0);
    expect((await loadEstimates(h.db, SEED_NOW, DEFAULT_CONFIG, [])).size).toBe(0);
  });
});

describe("loadConfig", () => {
  it("applies setting rows over HOUSEHOLD_TZ over defaults, rejecting bad keys", async () => {
    const env = { HOUSEHOLD_TZ: "America/New_York" } as unknown as NodeJS.ProcessEnv;
    expect((await loadConfig(h.db, env)).config.householdTz).toBe("America/New_York");
    await h.db.insert(setting).values([
      { key: "ema.alpha", value: 0.4 },
      { key: "nope", value: 1 },
      { key: "cartVendors", value: ["amazon"] },
    ]);
    const { config, rejected } = await loadConfig(h.db, env);
    expect(config.ema.alpha).toBe(0.4);
    expect(rejected.sort()).toEqual(["cartVendors", "nope"]);
  });
});
