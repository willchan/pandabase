// `rename-items` (DESIGN §4.5). Synthetic rows.
// Regression (2026-11-09): items auto-created from Whole Foods house-brand titles were named after
// the brand ("365 By Whole Foods Market"); this re-derives those names once.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb, type Db } from "./client";
import { applyItemRenames, formatRenamePlan, planItemRenames } from "./rename-items";
import { item, product } from "./schema/index";

const AT = "2026-11-09T00:00:00.000Z";
async function add(db: Db, id: string, name: string, title: string, extra = {}) {
  await db.insert(item).values({
    id,
    createdAt: AT,
    updatedAt: AT,
    canonicalName: name,
    category: "misc",
    defaultLocation: "pantry",
    trackingType: "static",
    baseUnit: "count",
    ...extra,
  });
  await db.insert(product).values({
    id: `p-${id}`,
    createdAt: AT,
    updatedAt: AT,
    itemId: id,
    vendor: "wholefoods",
    title,
  });
}

describe("rename-items", () => {
  it("renames brand-named auto-created items only", async () => {
    const db = await createTestDb();
    const garlic = "365 By Whole Foods Market, Organic Peeled Garlic, 6 Ounce";
    await add(db, "garlic", "365 By Whole Foods Market", garlic);
    await add(
      db,
      "beans",
      "365 by Whole Foods Market",
      "365 by Whole Foods Market, Trimmed Green Beans",
    );
    // A person confirmed this name: left alone.
    await add(db, "kept", "365 By Whole Foods Market", garlic, { trust: "confirmed" });
    // A person renamed it (name no longer what the old rule made): left alone.
    await add(db, "mine", "Garlic", garlic);
    // Already fine.
    await add(db, "broccoli", "Organic Broccoli", "Organic Broccoli, 1 Each");

    const plan = await planItemRenames(db);
    expect(plan.checked).toBe(4);
    expect(plan.renames.map((r) => [r.itemId, r.to])).toEqual([
      ["beans", "Trimmed Green Beans"],
      ["garlic", "Organic Peeled Garlic"],
    ]);
    expect(formatRenamePlan(plan, false)).toContain("would rename     2");
    const [before] = await db.select().from(item).where(eq(item.id, "garlic"));
    expect(before?.canonicalName).toBe("365 By Whole Foods Market");

    await applyItemRenames(db);
    const names = Object.fromEntries(
      (await db.select().from(item)).map((i) => [i.id, i.canonicalName]),
    );
    expect(names).toEqual({
      garlic: "Organic Peeled Garlic",
      beans: "Trimmed Green Beans",
      kept: "365 By Whole Foods Market",
      mine: "Garlic",
      broccoli: "Organic Broccoli",
    });
    expect((await planItemRenames(db)).renames).toEqual([]); // idempotent
  });
});
