"use server";
// Pantry item actions → `web/lib/services/*`.
import { num, runAction, str, type ActionResult } from "@/lib/actions";
import { badRequest } from "@/lib/http";
import { updateItemSettings } from "@/lib/services/catalog";
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
