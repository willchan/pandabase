import { describe, expect, it } from "vitest";
import { createTestDb } from "./client";
import { projectNaive } from "./rebuild-state";
import * as schema from "./schema/index";
import { buildSeed, isoWeekLabel, seed } from "./seed";

describe("seed", () => {
  const rows = buildSeed();

  it("is deterministic", () => {
    expect(buildSeed()).toEqual(rows);
    expect(buildSeed({ seed: 7 })).not.toEqual(rows);
  });

  it("matches the M2 seed brief", () => {
    expect(rows.member).toHaveLength(2);
    expect(rows.member.filter((m) => m.isCartAccount)).toHaveLength(1);
    expect(rows.item.length).toBeGreaterThanOrEqual(35);
    expect(rows.item.length).toBeLessThanOrEqual(45);
    expect(new Set(rows.item.map((i) => i.trackingType))).toEqual(new Set(["velocity", "static"]));
    expect(rows.item.some((i) => i.shelfLifeDays)).toBe(true);
    expect(rows.item.some((i) => i.auditHint)).toBe(true);

    const productsPerItem = new Map<string, number>();
    for (const p of rows.product)
      productsPerItem.set(p.itemId, (productsPerItem.get(p.itemId) ?? 0) + 1);
    expect([...productsPerItem.values()].filter((n) => n > 1).length).toBeGreaterThanOrEqual(8);

    const acquired = rows.receipt.map((r) => Date.parse(r.acquiredAt)).sort();
    expect((acquired.at(-1)! - acquired[0]!) / 86_400_000).toBeGreaterThan(150);
    expect(new Set(rows.receipt.map((r) => r.source))).toEqual(new Set(["digital", "paper"]));

    expect(rows.awayPeriod).toHaveLength(1);
    expect(rows.groceryCycle.filter((c) => c.status === "open")).toHaveLength(1);
    expect(
      rows.reviewItem.filter((r) => (r.status ?? "pending") === "pending").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("uses only synthetic identities", () => {
    for (const m of rows.member) expect(m.email).toMatch(/@example\.com$/);
  });

  it("loads into a fresh database with identical contents each time", async () => {
    const dump = async () => {
      const db = await createTestDb();
      await seed(db);
      const out = {
        items: await db.select().from(schema.item).orderBy(schema.item.id),
        events: await db.select().from(schema.inventoryEvent).orderBy(schema.inventoryEvent.id),
        state: await db.select().from(schema.inventoryState),
      };
      db.$client.close();
      return out;
    };
    const a = await dump();
    expect(a.events.length).toBe(rows.inventoryEvent.length);
    expect(a.state.length).toBeGreaterThan(30);
    expect(await dump()).toEqual(a);
  });
});

describe("isoWeekLabel", () => {
  it.each([
    ["2026-10-20", "2026-W43"],
    ["2026-01-01", "2026-W01"],
    ["2027-01-01", "2026-W53"],
    ["2024-12-30", "2025-W01"],
  ])("%s → %s", (d, label) => {
    expect(isoWeekLabel(new Date(`${d}T12:00:00Z`))).toBe(label);
  });
});

describe("projectNaive (M2 stub)", () => {
  const base = {
    id: "",
    createdAt: "",
    updatedAt: "",
    toLocation: null,
    statusOverride: null,
    source: "manual",
    sourceRef: null,
    actorMemberId: null,
    actorSystem: null,
    trust: "confirmed",
  } as const;
  const e = (
    kind: (typeof schema.INVENTORY_EVENT_KINDS)[number],
    quantity: number,
    t: string,
    extra = {},
  ) => ({
    ...base,
    itemId: "i",
    location: "fridge" as const,
    kind,
    quantity,
    occurredAt: t,
    ...extra,
  });

  it("adds, anchors, overrides and moves", () => {
    const rows = projectNaive(
      [
        e("acquired", 6, "t1"),
        e("acquired", 6, "t2"),
        e("observed", 5, "t3"),
        e("moved", 2, "t4", { toLocation: "freezer" }),
        e("consumed", 0, "t5", { statusOverride: "consumed" }),
      ],
      "now",
    );
    const fridge = rows.find((r) => r.location === "fridge")!;
    const freezer = rows.find((r) => r.location === "freezer")!;
    expect(fridge).toMatchObject({
      anchorQty: 0,
      statusOverride: "consumed",
      lastVerifiedAt: "t3",
    });
    expect(freezer).toMatchObject({ anchorQty: 2, anchorAt: "t4", frozenAt: "t4" });
  });
});
