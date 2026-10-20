import { item, member, setting, systemTelemetry } from "@pandabase/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/config";
import { loadConfig } from "@/lib/repo/settings";
import { awayPeriods, loadEstimates } from "@/lib/repo/inventory";
import { ALEX, SAM, setup, type Harness } from "@/test/harness";
import { itemDetail, updateItemSettings } from "./catalog";
import { createAwayPeriod, markItem } from "./inventory";
import { deleteAwayPeriod, setCartAccount, updateMember, updateSettings } from "./settings";
import type { ServiceCtx } from "./types";

let h: Harness;
let ctx: ServiceCtx;

beforeEach(async () => {
  h = await setup();
  ctx = {
    now: h.now(),
    config: DEFAULT_CONFIG,
    actor: { memberId: await h.memberId(ALEX), system: null },
  };
});
afterEach(() => h.close());

describe("itemDetail", () => {
  it("returns the estimate, products, recent events with actors and a replayed EMA", async () => {
    const eggs = await h.itemId("Eggs");
    const d = await itemDetail(h.db, eggs, ctx, { eventLimit: 5 });
    expect(d.estimate.item.canonicalName).toBe("Eggs");
    expect(d.products).toHaveLength(2);
    expect(d.events).toHaveLength(5);
    expect(d.events.map((e) => e.occurredAt)).toEqual(
      [...d.events.map((e) => e.occurredAt)].sort().reverse(),
    );
    expect(d.events.some((e) => e.actorName === "Alex")).toBe(true);
    expect(d.emaHistory.length).toBeGreaterThan(5);
    expect(d.emaHistory.at(-1)!.emaDays).toBeGreaterThan(0);
    expect(d.emaHistory.every((p) => p.at !== "")).toBe(true);
    await expect(itemDetail(h.db, "nope", ctx)).rejects.toThrow(/not found/);
  });
});

describe("updateItemSettings", () => {
  it("saves hint / shelf life / threshold, validates, logs telemetry", async () => {
    const milk = await h.itemId("Oat Milk");
    await updateItemSettings(
      h.db,
      milk,
      { auditHint: "  check the fridge door ", shelfLifeDays: 10, reorderThreshold: null },
      ctx,
    );
    const [row] = await h.db.select().from(item).where(eq(item.id, milk));
    expect(row).toMatchObject({ auditHint: "check the fridge door", shelfLifeDays: 10 });
    const [t] = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "item_settings_changed"));
    expect(t!.payload).toMatchObject({
      itemId: milk,
      fields: ["auditHint", "shelfLifeDays", "reorderThreshold"],
    });
    await updateItemSettings(h.db, milk, { auditHint: "" }, ctx);
    expect((await h.db.select().from(item).where(eq(item.id, milk)))[0]!.auditHint).toBeNull();
    await expect(updateItemSettings(h.db, milk, { shelfLifeDays: 1.5 }, ctx)).rejects.toThrow(
      /whole/,
    );
    await expect(updateItemSettings(h.db, milk, { reorderThreshold: -1 }, ctx)).rejects.toThrow(
      /0 or more/,
    );
    await expect(
      updateItemSettings(h.db, milk, { auditHint: "x".repeat(201) }, ctx),
    ).rejects.toThrow(/long/);
    await updateItemSettings(h.db, milk, {}, ctx); // no-op
  });
});

describe("markItem", () => {
  it("we're out / running low / count from the UI", async () => {
    const eggs = await h.itemId("Eggs");
    const est = async () => (await loadEstimates(h.db, ctx.now, ctx.config, [eggs])).get(eggs)!;
    await markItem(h.db, eggs, { kind: "low" }, ctx);
    expect((await est()).estimate.status).toBe("critical");
    await markItem(h.db, eggs, { kind: "out" }, ctx);
    expect((await est()).estimate.status).toBe("consumed");
    const res = await markItem(h.db, eggs, { kind: "count", quantity: 7 }, ctx);
    expect(res.estimates[0]).toMatchObject({ item_id: eggs, on_hand: 7 });
    const evo = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "estimate_vs_observed"));
    expect(evo.map((t) => t.payload)).toContainEqual(
      expect.objectContaining({ itemId: eggs, observed: 7 }),
    );
  });
});

describe("settings", () => {
  it("updates a member's name and Discord id; refuses duplicates and junk", async () => {
    const sam = await h.memberId(SAM);
    await updateMember(
      h.db,
      sam,
      { displayName: " Sam R ", discordUserId: "123456789", amazonSweep: "weekly" },
      ctx,
    );
    const [row] = await h.db.select().from(member).where(eq(member.id, sam));
    expect(row).toMatchObject({
      displayName: "Sam R",
      discordUserId: "123456789",
      amazonSweep: "weekly",
    });
    await expect(
      updateMember(h.db, sam, { displayName: "Sam", discordUserId: ALEX, amazonSweep: "off" }, ctx),
    ).rejects.toThrow(/someone else/);
    await expect(
      updateMember(
        h.db,
        sam,
        { displayName: "Sam", discordUserId: "abc", amazonSweep: "off" },
        ctx,
      ),
    ).rejects.toThrow(/digits/);
    await expect(
      updateMember(h.db, sam, { displayName: "", discordUserId: null, amazonSweep: "off" }, ctx),
    ).rejects.toThrow(/name/);
    await expect(
      updateMember(
        h.db,
        "nope",
        { displayName: "x", discordUserId: null, amazonSweep: "off" },
        ctx,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("keeps exactly one cart account", async () => {
    const sam = await h.memberId(SAM);
    await setCartAccount(h.db, sam, ctx);
    const rows = await h.db.select().from(member);
    expect(rows.filter((m) => m.isCartAccount).map((m) => m.id)).toEqual([sam]);
    await expect(setCartAccount(h.db, "nope", ctx)).rejects.toThrow(/not found/);
  });

  it("adds and removes away periods", async () => {
    const { away_period } = await createAwayPeriod(
      h.db,
      { startsOn: "2026-11-01", endsOn: "2026-11-03", note: "Tahoe" },
      ctx,
    );
    expect(await awayPeriods(h.db)).toHaveLength(2);
    await deleteAwayPeriod(h.db, away_period.id, ctx);
    expect(await awayPeriods(h.db)).toHaveLength(1);
    await expect(deleteAwayPeriod(h.db, away_period.id, ctx)).rejects.toThrow(/not found/);
  });

  it("saves tunables as setting rows, resets with null, refuses bad keys", async () => {
    await updateSettings(h.db, { lowWithinDays: 4, "matching.fuzzyApplyThreshold": 0.9 }, ctx);
    expect((await loadConfig(h.db)).config).toMatchObject({
      lowWithinDays: 4,
      matching: { fuzzyApplyThreshold: 0.9 },
    });
    await updateSettings(h.db, { lowWithinDays: null }, ctx);
    expect(await h.db.select().from(setting)).toHaveLength(1);
    await expect(updateSettings(h.db, { nope: 1 }, ctx)).rejects.toThrow(/nope/);
    await expect(updateSettings(h.db, { lowWithinDays: -2 }, ctx)).rejects.toThrow(/lowWithinDays/);
    await updateSettings(h.db, {}, ctx);
    const [t] = await h.db
      .select()
      .from(systemTelemetry)
      .where(eq(systemTelemetry.metricType, "settings_changed"));
    expect(t!.payload).toEqual({ keys: ["lowWithinDays", "matching.fuzzyApplyThreshold"] });
  });
});
