import { PageSkeleton } from "@/components/page-skeleton";
import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PantryList, type PantryRow } from "@/components/pantry-list";
import { currentMember } from "@/lib/auth/current";
import { amount, daysUntil, LOCATION_LABELS, monthDay, bestBeforeDate } from "@/lib/format";
import { loadEstimates } from "@/lib/repo/inventory";

export const metadata: Metadata = { title: "Pantry" };

export default function PantryPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <PantryPageContent />
    </Suspense>
  );
}

async function PantryPageContent() {
  const { db, ctx } = await currentMember();
  const tz = ctx.config.householdTz;
  const estimates = await loadEstimates(db, ctx.now, ctx.config);
  const rows: PantryRow[] = [...estimates.values()]
    .sort((a, b) => a.item.canonicalName.localeCompare(b.item.canonicalName))
    .map((e) => {
      const shelf = e.item.shelfLifeDays;
      const useBy = shelf && e.lastAcquired ? bestBeforeDate(e.lastAcquired.at, shelf, tz) : null;
      const left = useBy ? daysUntil(`${useBy}T12:00:00Z`, ctx.now, tz) : null;
      // Frozen reserve doesn't expire (DESIGN §4.2): use-by is about stock at the home location.
      const home =
        e.estimate.byLocation.find((l) => l.location === e.item.defaultLocation)?.onHand ?? 0;
      const where = e.estimate.byLocation
        .filter((l) => l.onHand > 0 && l.location !== e.item.defaultLocation)
        .map((l) => `${amount(l.onHand, e.item.baseUnit)} in ${l.location}`);
      return {
        id: e.item.id,
        name: e.item.canonicalName,
        location: e.item.defaultLocation,
        status: e.estimate.status,
        amount:
          e.estimate.status === "unknown"
            ? "no data yet"
            : `~${amount(e.estimate.onHand, e.item.baseUnit)}${where.length ? ` (${where.join(", ")})` : ""}`,
        useBy: useBy && home > 0 ? `use by ${monthDay(`${useBy}T12:00:00Z`, "UTC")}` : null,
        useByTone: left === null ? null : left < 0 ? "past" : left <= 2 ? "soon" : null,
        itemTrust: e.item.trust,
        lastTrust: e.lastAcquired?.trust === "provisional" ? "provisional" : null,
      };
    });
  return (
    <>
      <PageHeader
        title="Pantry"
        subtitle="Estimated from receipts, counts and how fast things go."
      />
      <PantryList rows={rows} locations={Object.entries(LOCATION_LABELS)} />
    </>
  );
}
