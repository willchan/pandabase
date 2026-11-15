"use server";
// Pantry item actions → `web/lib/services/*`.
import { num, runAction, str, type ActionResult } from "@/lib/actions";
import { badRequest } from "@/lib/http";
import { updateItemSettings } from "@/lib/services/catalog";
import { setStorePin } from "@/lib/services/costco";
import { rejectProductById } from "@/lib/services/inventory";

const need = (v: string | null, what: string): string => {
  if (!v) throw badRequest(`${what} is required`);
  return v;
};

export async function updateItemSettingsAction(
  _: ActionResult,
  f: FormData,
): Promise<ActionResult> {
  return runAction("update_item_settings", async ({ db, ctx }) => {
    await updateItemSettings(
      db,
      need(str(f, "itemId"), "Item"),
      {
        auditHint: str(f, "auditHint"),
        shelfLifeDays: num(f, "shelfLifeDays"),
        reorderThreshold: num(f, "reorderThreshold"),
      },
      ctx,
    );
    return "Saved.";
  });
}

export async function rejectProductAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("reject_product", async ({ db, ctx }) => {
    await rejectProductById(db, need(str(f, "productId"), "Product"), ctx);
    return "We won't buy that one again.";
  });
}

/** "Get it at Costco / Whole Foods" from the item page (§4.8 `learnStoreOverride`). */
export async function setStorePinAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  return runAction("set_store_pin", async ({ db, ctx }) => {
    const raw = str(f, "store");
    const store = raw === "costco" || raw === "regular" ? raw : raw === "auto" ? null : undefined;
    if (store === undefined) throw badRequest("Pick a store");
    const res = await setStorePin(db, need(str(f, "itemId"), "Item"), store, ctx);
    return store === null
      ? `PandaBase chooses again: ${res.choice.reason}.`
      : `Saved: ${res.choice.reason}.${res.threshold_changed ? " The household's Costco threshold moved too." : ""}`;
  });
}
