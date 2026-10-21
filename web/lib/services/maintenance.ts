// Daily maintenance (`GET /api/cron/maintenance`, Vercel Cron): review expiries (§4.6), shelf-life
// discards (§4.2), stale leases (§5), retention purges (§2.7), the Monday-9am cycle fallback
// (§4.7) and the weekly merge suggestions (§4.5). Each step is idempotent, so a re-run the same day
// is harmless.
import {
  groceryCycle,
  idempotencyKey,
  inventoryEvent,
  item,
  reviewItem,
  systemTelemetry,
  type Db,
} from "@pandabase/db";
import { and, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { z } from "zod";
import type { MaintenanceResponse, WorkerHealthResponse } from "../contracts";
import { isOpenOverdue } from "../domain/cycle";
import { shelfLifeDiscards } from "../domain/inventory";
import { dueExpiries } from "../domain/review";
import { addDaysToInstant } from "../domain/time";
import { asRecord } from "../repo/db";
import { awayPeriods, loadEstimates, refreshInventoryState } from "../repo/inventory";
import { emitTelemetry } from "../telemetry";
import { openCycle } from "./cycles";
import { releaseExpiredLeases } from "./jobs";
import { scheduledMergeSuggestions } from "./mergeSuggest";
import { newId } from "./receipts";
import type { ServiceCtx } from "./types";

type Location = typeof inventoryEvent.$inferInsert.location;

export async function runMaintenance(
  db: Db,
  ctx: Pick<ServiceCtx, "now" | "config">,
): Promise<z.input<typeof MaintenanceResponse>> {
  const { now, config } = ctx;
  const sys = { ...ctx, actor: { memberId: null, system: "cron" as const } };

  const expired = await db.transaction(async (tx) => {
    const pending = await tx.select().from(reviewItem).where(eq(reviewItem.status, "pending"));
    const due = dueExpiries(pending, now);
    if (due.length === 0) return 0;
    await tx
      .update(reviewItem)
      .set({ status: "expired", updatedAt: now })
      .where(
        inArray(
          reviewItem.id,
          due.map((d) => d.id),
        ),
      );
    // Every default is "leave things as they are" (§4.6): provisional lines stay provisional,
    // pending lines stay unapplied, auto-created items are kept, failed jobs are dismissed.
    await emitTelemetry(
      tx,
      "cron",
      due.map((d) => ({
        metric: "review_expired",
        reviewId: d.id,
        kind: d.kind,
        action: d.apply.action,
      })),
      now,
    );
    return due.length;
  });

  const leases = await db.transaction((tx) => releaseExpiredLeases(tx, ctx));

  const discards = await db.transaction(async (tx) => {
    const ids = (
      await tx.select({ id: item.id }).from(item).where(isNotNull(item.shelfLifeDays))
    ).map((r) => r.id);
    const estimates = await loadEstimates(tx, now, config, ids);
    const away = await awayPeriods(tx);
    let n = 0;
    for (const e of estimates.values()) {
      const events = shelfLifeDiscards(
        e.inv,
        e.states,
        now,
        { away, config },
        e.acquisitionsByLocation,
      );
      for (const ev of events) {
        await tx.insert(inventoryEvent).values({
          id: newId(),
          createdAt: now,
          updatedAt: now,
          itemId: e.item.id,
          location: ev.location as Location,
          kind: "presumed_discarded",
          quantity: ev.quantity,
          occurredAt: now,
          source: "system",
          actorSystem: "cron",
          trust: "provisional",
        });
      }
      if (events.length > 0) await refreshInventoryState(tx, [e.item.id], now, config);
      await emitTelemetry(
        tx,
        "cron",
        events.map((ev) => ({
          metric: "presumed_discarded",
          itemId: e.item.id,
          item: e.item.canonicalName,
          location: ev.location,
          quantity: ev.quantity,
        })),
        now,
      );
      n += events.length;
    }
    return n;
  });

  const idemCutoff = addDaysToInstant(now, -config.retention.idempotencyHours / 24);
  const purgedIdem = await db
    .delete(idempotencyKey)
    .where(lt(idempotencyKey.createdAt, idemCutoff));
  const telCutoff = addDaysToInstant(now, -config.retention.telemetryDays);
  const purgedTel = await db
    .delete(systemTelemetry)
    .where(lt(systemTelemetry.createdAt, telCutoff));

  const cycles = await db
    .select({ status: groceryCycle.status, closedAt: groceryCycle.closedAt })
    .from(groceryCycle);
  let openedCycleId: string | null = null;
  if (cycles.length > 0 && isOpenOverdue(cycles, now, config)) {
    const res = await openCycle(db, null, sys, "cron");
    if (res.created) openedCycleId = res.cycle.id;
  }

  const merges = await scheduledMergeSuggestions(db, ctx);

  const summary = {
    expired_reviews: expired,
    released_leases: leases.released,
    failed_jobs: leases.failed,
    presumed_discards: discards,
    purged_idempotency_keys: purgedIdem.rowsAffected,
    purged_telemetry: purgedTel.rowsAffected,
    opened_cycle_id: openedCycleId,
    merge_suggest_jobs: merges.jobs.length,
  };
  await emitTelemetry(db, "cron", [{ metric: "maintenance_run", ...summary }], now);
  return summary;
}

/** Client telemetry (`POST /api/telemetry`): one row per event, source = the caller's scope. */
export async function ingestTelemetry(
  db: Db,
  source: "agent" | "worker" | "session",
  events: readonly {
    metric_type: string;
    payload: Record<string, unknown>;
    occurred_at?: string;
  }[],
  ctx: Pick<ServiceCtx, "now">,
): Promise<number> {
  const rows = events.map((e) => ({
    id: newId(),
    source,
    metricType: e.metric_type,
    payload: e.payload,
    createdAt: e.occurred_at ? new Date(e.occurred_at).toISOString() : ctx.now,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    await db.insert(systemTelemetry).values(rows.slice(i, i + 100));
  }
  return rows.length;
}

/** The worker's latest `worker_heartbeat` (`GET /api/health/worker`, the deploy health check). */
export async function workerHealth(db: Db): Promise<z.infer<typeof WorkerHealthResponse>> {
  const [row] = await db
    .select({ at: systemTelemetry.createdAt, payload: systemTelemetry.payload })
    .from(systemTelemetry)
    .where(
      and(eq(systemTelemetry.source, "worker"), eq(systemTelemetry.metricType, "worker_heartbeat")),
    )
    .orderBy(desc(systemTelemetry.createdAt), desc(systemTelemetry.id))
    .limit(1);
  if (!row) return { heartbeat: null };
  const p = asRecord(row.payload);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    heartbeat: {
      at: row.at,
      version: str(p.version),
      sha: str(p.sha),
      vlm_model: str(p.vlm_model),
      text_model: str(p.text_model),
      ollama_ok: typeof p.ollama_ok === "boolean" ? p.ollama_ok : null,
    },
  };
}
