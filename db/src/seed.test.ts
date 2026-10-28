import { describe, expect, it } from "vitest";
import { createTestDb } from "./client";
import { projectRows } from "./rebuild-state";
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

  // Regression (system test, tier A): e2e/system suites seed relative to the real clock. Seeded
  // on a Sunday evening PT (already Monday in UTC), the open cycle was labelled with the *UTC*
  // ISO week and opened "Monday 09:00" — in the future.
  it("seeded at any hour of any weekday, nothing happens after now and the week is local", () => {
    for (let h = 0; h < 7 * 24; h += 5) {
      const now = new Date(Date.parse("2026-10-19T07:30:00.000Z") + h * 3_600_000).toISOString();
      const r = buildSeed({ now });
      const open = r.groceryCycle.find((c) => c.status === "open")!;
      expect(open.openedAt! <= now, `opened_at ${open.openedAt} > now ${now}`).toBe(true);
      const local = new Date(
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(
          Date.parse(now),
        ),
      );
      // The household-local week of the coming Saturday shop (today, on a Saturday).
      const shop = local.getTime() + ((6 - local.getUTCDay() + 7) % 7) * 86_400_000;
      expect(open.weekLabel, now).toBe(isoWeekLabel(new Date(shop)));
      expect(new Set(r.groceryCycle.map((c) => c.weekLabel)).size).toBe(r.groceryCycle.length);
      for (const [table, list] of Object.entries(r)) {
        for (const row of list as { createdAt?: string }[]) {
          if (row.createdAt) expect(row.createdAt <= now, `${table} at ${now}`).toBe(true);
        }
      }
    }
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

describe("projectRows (§4.2 projection)", () => {
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
    quantity: number | null,
    t: string,
    extra = {},
  ) => ({
    ...base,
    itemId: "i",
    location: "fridge" as const,
    kind,
    quantity,
    occurredAt: `2026-10-${t}T12:00:00.000Z`,
    ...extra,
  });
  const items = [
    {
      id: "i",
      trackingType: "velocity" as const,
      currentEmaDays: 1,
      defaultLocation: "fridge" as const,
      reorderThreshold: null,
      shelfLifeDays: null,
    },
  ];

  it("decays, anchors, overrides and moves; ignores expired events and unknown items", () => {
    const rows = projectRows(
      items,
      [
        e("acquired", 6, "01"),
        e("acquired", 6, "03"), // 6 − 2 days decay + 6 = 10
        e("acquired", 99, "04", { trust: "expired" }),
        e("observed", 5, "05"),
        e("moved", 2, "06", { toLocation: "freezer" }), // 5 − 1 = 4 → 2 left, 2 frozen
        e("observed", null, "07", { statusOverride: "critical" }),
        { ...e("acquired", 1, "07"), itemId: "unknown" },
      ],
      [],
      "now",
    );
    expect(rows).toHaveLength(2);
    const fridge = rows.find((r) => r.location === "fridge")!;
    const freezer = rows.find((r) => r.location === "freezer")!;
    expect(fridge).toMatchObject({
      anchorQty: 2,
      anchorAt: "2026-10-06T12:00:00.000Z",
      statusOverride: "critical",
      lastVerifiedAt: "2026-10-05T12:00:00.000Z",
      createdAt: "now",
    });
    expect(freezer).toMatchObject({ anchorQty: 2, frozenAt: "2026-10-06T12:00:00.000Z" });
  });
});
