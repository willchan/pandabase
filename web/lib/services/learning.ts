// DESIGN §4.10 / PLAN M11.2: rebuild the learning of the items a write touched, inside the
// caller's transaction. Ingest, a re-read order's replacement and the import reset call this
// instead of patching product stats, stances, EMA columns, tracking promotion and switch
// thresholds in place. Round trips stay constant (§8 *Database round trips*): one batch reads
// every input of the items, the fold runs in memory, one batch writes the differences — when the
// handle can batch (`batchTransaction`, a `Db`); inside Drizzle's own transaction the same few
// statements go one by one.
import {
  learningWrites,
  planFromRows,
  readLearningRows,
  summaryPayload,
  type LearningRebuildPlan,
  type LearningRows,
} from "@pandabase/db/rebuild-learning";
import type { ReceiptEffects } from "../domain/receipts";
import type { Q } from "../repo/db";
import { monotonicFactory } from "ulid";
import { telemetryWrites } from "../telemetry";
import type { ServiceCtx } from "./types";

const newId = monotonicFactory();
type Stmts = unknown[];

async function send(q: Q, writes: Stmts): Promise<void> {
  if (writes.length === 0) return;
  const b = (q as { batch?: (s: Stmts) => Promise<unknown> }).batch;
  if (typeof b === "function") {
    await b.call(q, writes);
    return;
  }
  for (const w of writes) await w;
}

/**
 * What ingest's in-place patches (`applyReceipt`'s effects) would have left: the stored rows with
 * `fx`'s item / product patches and preference events laid over them. A rebuild that differs from
 * this is a correction the patches would have missed (a late receipt, an edited line, a merge).
 */
export function withPatches(rows: LearningRows, fx: ReceiptEffects, now: string): LearningRows {
  const itemPatch = new Map(fx.itemPatches.map((p) => [p.id, p.patch]));
  const productPatch = new Map<string, Record<string, unknown>>();
  for (const { id, ...patch } of fx.productPatches) {
    productPatch.set(id, { ...productPatch.get(id), ...patch });
  }
  return {
    ...rows,
    items: rows.items.map((i) => {
      const p = itemPatch.get(i.id);
      if (!p) return i;
      return {
        ...i,
        ...("emaDays" in p ? { currentEmaDays: p.emaDays ?? null } : {}),
        ...("outlierStreak" in p ? { emaOutlierStreak: p.outlierStreak ?? 0 } : {}),
        ...("outlierDirection" in p ? { emaOutlierDirection: p.outlierDirection ?? null } : {}),
        ...(p.trackingType ? { trackingType: p.trackingType } : {}),
        ...(p.switchThreshold !== undefined ? { switchThreshold: p.switchThreshold } : {}),
      };
    }),
    products: rows.products.map((p) => ({ ...p, ...productPatch.get(p.id) })),
    prefs: [
      ...rows.prefs,
      ...fx.preferenceEvents.map((e, n) => ({
        id: `patch-${n}`,
        createdAt: now,
        updatedAt: now,
        ...e,
      })),
    ],
  };
}

export interface ItemRebuild {
  /** What was written (stored → rebuilt). */
  plan: LearningRebuildPlan;
  /** With `patched`: what the in-place patches would have got wrong. */
  corrections: LearningRebuildPlan | null;
}

/**
 * Rebuild `itemIds`' learning and write the differences. `patched` (ingest) also compares the
 * rebuild with what `applyReceipt`'s patches would have written and, when they differ, emits one
 * `learning_rebuilt` row (`scope`, counts only). Callers emit their own telemetry otherwise.
 */
export async function rebuildItemsIn(
  q: Q,
  itemIds: Iterable<string>,
  ctx: ServiceCtx,
  opts: { scope: "ingest" | "replace" | "reset"; patched?: ReceiptEffects; receiptId?: string },
): Promise<ItemRebuild> {
  const items = [...new Set(itemIds)].sort();
  const empty = planFromRows(
    {
      items: [],
      products: [],
      receipts: [],
      lines: [],
      acquired: [],
      prefs: [],
      cycles: [],
      away: [],
      paused: [],
    },
    { items: [], config: ctx.config },
  );
  if (items.length === 0) return { plan: empty, corrections: null };
  const rows = await readLearningRows(q, items);
  const plan = planFromRows(rows, { items, config: ctx.config });
  const writes: Stmts = learningWrites(q, plan, ctx.now, () => newId());
  let corrections: LearningRebuildPlan | null = null;
  if (opts.patched) {
    corrections = planFromRows(withPatches(rows, opts.patched, ctx.now), {
      items,
      config: ctx.config,
    });
    if (corrections.changes.length > 0) {
      writes.push(
        ...telemetryWrites(
          q,
          "state_engine",
          [{ metric: "learning_rebuilt", ...summaryPayload(corrections, opts.scope) }],
          ctx.now,
          opts.receiptId ? { receiptId: opts.receiptId } : {},
        ),
      );
    }
  }
  await send(q, writes);
  return { plan, corrections };
}
