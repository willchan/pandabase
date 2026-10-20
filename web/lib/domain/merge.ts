// Confirmed merges (Cleanup → merges, DESIGN §4.5): a duplicate or auto-created item folds into an
// existing one. Its products move to the target as `acceptable` (NEW_PRODUCT_STANCE; rejected stays
// rejected) and its history moves with them, rescaled when the human corrects the pack size.
import { NEW_PRODUCT_STANCE, type Stance } from "./productChoice";

export interface MergeProduct {
  id: string;
  stance: Stance;
  unitQuantity: number;
}

export interface MergeInput {
  source: { id: string; mergedIntoItemId: string | null };
  target: { id: string; mergedIntoItemId: string | null };
  sourceProducts: readonly MergeProduct[];
  /**
   * Target base units per purchase unit of the source's product, when the human set it (only
   * meaningful when the source has exactly one product, e.g. an auto-created ASIN item).
   */
  unitQuantity: number | null;
}

export type MergePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      productPatches: {
        id: string;
        stance: Stance;
        unitQuantity?: number;
        unitQuantityTrust?: "confirmed";
      }[];
      /** Multiply the source's event quantities by this (base units change with the pack size). */
      eventScale: number;
    };

export function planMerge(input: MergeInput): MergePlan {
  const { source, target, sourceProducts, unitQuantity } = input;
  if (source.id === target.id) return { ok: false, error: "an item can't merge into itself" };
  if (source.mergedIntoItemId) return { ok: false, error: "item was already merged" };
  if (target.mergedIntoItemId) return { ok: false, error: "target item was merged away" };
  if (unitQuantity !== null) {
    if (!(unitQuantity > 0)) return { ok: false, error: "pack size must be positive" };
    if (sourceProducts.length !== 1) {
      return { ok: false, error: "pack size applies only to an item with one product" };
    }
  }
  const only = sourceProducts.length === 1 ? sourceProducts[0]! : null;
  const eventScale = only && unitQuantity !== null ? unitQuantity / only.unitQuantity : 1;
  return {
    ok: true,
    eventScale,
    productPatches: sourceProducts.map((p) => ({
      id: p.id,
      stance: p.stance === "rejected" ? "rejected" : NEW_PRODUCT_STANCE,
      ...(unitQuantity !== null ? { unitQuantity, unitQuantityTrust: "confirmed" as const } : {}),
    })),
  };
}
