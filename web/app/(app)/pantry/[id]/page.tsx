import { PageSkeleton } from "@/components/page-skeleton";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { EmaChart } from "@/components/ema-chart";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { StatusBadge, TrustBadge } from "@/components/status";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { currentMember } from "@/lib/auth/current";
import {
  amount,
  LOCATION_LABELS,
  money,
  monthDay,
  qty,
  relativeDay,
  shortDate,
  bestBeforeDate,
  vendorName,
} from "@/lib/format";
import { ApiError } from "@/lib/http";
import { itemDetail } from "@/lib/services/catalog";
import { markItemAction } from "../../actions";
import { rejectProductAction, updateItemSettingsAction } from "../actions";

export const metadata: Metadata = { title: "Item" };

const EVENT_LABEL: Record<string, string> = {
  acquired: "Bought",
  observed: "Counted",
  consumed: "Ran out",
  discarded: "Threw away",
  presumed_discarded: "Presumed past use-by",
  moved: "Moved",
};
const SOURCE_LABEL: Record<string, string> = {
  digital_receipt: "online order",
  paper_receipt: "paper receipt",
  manual: "by hand",
  trash_cam: "Trash Cam",
  checkin: "check-in",
  backfill: "backfill",
  task: "task",
  system: "system",
};

export default function ItemPage(props: PageProps<"/pantry/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ItemPageContent {...props} />
    </Suspense>
  );
}

async function ItemPageContent(props: PageProps<"/pantry/[id]">) {
  const { db, ctx } = await currentMember();
  const tz = ctx.config.householdTz;
  const { id } = await props.params;
  const d = await itemDetail(db, id, ctx).catch((err) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const it = d.estimate.item;
  if (it.mergedIntoItemId) redirect(`/pantry/${it.mergedIntoItemId}`);
  const est = d.estimate.estimate;
  const unit = it.baseUnit;
  const useBy =
    it.shelfLifeDays && d.estimate.lastAcquired
      ? bestBeforeDate(d.estimate.lastAcquired.at, it.shelfLifeDays, tz)
      : null;

  return (
    <>
      <Link
        href="/pantry"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" /> Pantry
      </Link>
      <PageHeader
        title={it.canonicalName}
        subtitle={`${it.category} · ${LOCATION_LABELS[it.defaultLocation] ?? it.defaultLocation} · ${
          it.trackingType === "velocity" ? "used up regularly" : "restocked at a threshold"
        }`}
        action={<StatusBadge status={est.status} />}
      />
      {it.trust === "unverified" ? (
        <p className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <TrustBadge trust="unverified" /> Created automatically — confirm or merge it in{" "}
          <Link
            href="/cleanup?tab=unverified"
            className="text-primary underline-offset-4 hover:underline"
          >
            Cleanup
          </Link>
          .
        </p>
      ) : null}

      <Card className="gap-3">
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Fact label="On hand">
            {est.status === "unknown" ? "No data yet" : `~${amount(est.onHand, unit)}`}
          </Fact>
          <Fact label="Runs out">
            {est.runoutAt
              ? `${shortDate(est.runoutAt, tz)} (${relativeDay(est.runoutAt, ctx.now, tz)})`
              : "–"}
          </Fact>
          <Fact label="Last bought">
            {d.estimate.lastAcquired ? (
              <span className="inline-flex flex-wrap items-center gap-1">
                {monthDay(d.estimate.lastAcquired.at, tz)}
                {d.estimate.lastAcquired.trust === "provisional" ? (
                  <TrustBadge trust="provisional" />
                ) : null}
              </span>
            ) : (
              "–"
            )}
          </Fact>
          <Fact label="Last counted">
            {d.estimate.lastVerifiedAt ? monthDay(d.estimate.lastVerifiedAt, tz) : "Never"}
          </Fact>
          {useBy ? <Fact label="Use by">{monthDay(`${useBy}T12:00:00Z`, "UTC")}</Fact> : null}
          {it.currentEmaDays ? (
            <Fact label="One lasts">
              ~{qty(it.currentEmaDays)} days per {unit === "count" ? "unit" : unit}
            </Fact>
          ) : null}
          {est.byLocation.filter((l) => l.onHand > 0).length > 1 ? (
            <Fact label="Where" wide>
              {est.byLocation
                .filter((l) => l.onHand > 0)
                .map(
                  (l) =>
                    `${amount(l.onHand, unit)} in ${LOCATION_LABELS[l.location] ?? l.location}`,
                )
                .join(" · ")}
            </Fact>
          ) : null}
        </CardContent>
      </Card>

      <div className="mt-3 flex flex-wrap items-start gap-2">
        <ActionForm action={markItemAction} className="flex items-center gap-2">
          <input type="hidden" name="itemId" value={it.id} />
          <input type="hidden" name="mark" value="count" />
          <label htmlFor="count" className="sr-only">
            How many do you have?
          </label>
          <Input
            id="count"
            name="quantity"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder={`Count (${unit})`}
            className="w-32"
            required
          />
          <SubmitButton variant="secondary">Save count</SubmitButton>
        </ActionForm>
        <ActionForm action={markItemAction}>
          <input type="hidden" name="itemId" value={it.id} />
          <input type="hidden" name="mark" value="low" />
          <SubmitButton variant="outline">Running low</SubmitButton>
        </ActionForm>
        <ActionForm action={markItemAction}>
          <input type="hidden" name="itemId" value={it.id} />
          <input type="hidden" name="mark" value="out" />
          <SubmitButton variant="outline">We&apos;re out</SubmitButton>
        </ActionForm>
      </div>

      {it.trackingType === "velocity" ? (
        <section aria-labelledby="ema">
          <SectionTitle>
            <span id="ema">How fast it goes</span>
          </SectionTitle>
          <EmaChart points={d.emaHistory} unit={unit === "count" ? "unit" : unit} tz={tz} />
        </section>
      ) : null}

      <section aria-labelledby="products">
        <SectionTitle
          aside={
            <span className="text-xs text-muted-foreground">
              switches if ≥{Math.round(it.switchThreshold * 100)}% cheaper
            </span>
          }
        >
          <span id="products">Products</span>
        </SectionTitle>
        {d.products.length === 0 ? (
          <p className="text-sm text-muted-foreground">No products yet.</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border bg-card">
            {d.products.map((p) => (
              <li key={p.id} className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        p.stance === "rejected"
                          ? "text-muted-foreground line-through"
                          : "font-medium"
                      }
                    >
                      {p.title}
                    </span>
                    {p.stance === "preferred" ? <Badge variant="ok">usual</Badge> : null}
                    {p.stance === "rejected" ? <Badge variant="secondary">never buy</Badge> : null}
                    {p.unitQuantityTrust === "unverified" ? (
                      <TrustBadge trust="unverified" title="Pack size was guessed from the title" />
                    ) : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {vendorName(p.vendor)} · {amount(p.unitQuantity, unit)} per pack
                    {money(p.lastPriceCents) ? ` · ${money(p.lastPriceCents)}` : ""} · bought{" "}
                    {p.timesBought}×
                  </span>
                </span>
                {p.stance !== "rejected" ? (
                  <ActionForm action={rejectProductAction}>
                    <input type="hidden" name="productId" value={p.id} />
                    <ConfirmButton confirmLabel="Never buy" variant="ghost">
                      Never buy
                    </ConfirmButton>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="item-settings">
        <SectionTitle>
          <span id="item-settings">Settings</span>
        </SectionTitle>
        <ActionForm
          action={updateItemSettingsAction}
          className="flex flex-col gap-3 rounded-xl border bg-card p-4"
        >
          <input type="hidden" name="itemId" value={it.id} />
          <Field
            id="auditHint"
            label="Check-in hint"
            hint="Shown in the Friday nudge, e.g. “count the eggs”."
          >
            <Input
              id="auditHint"
              name="auditHint"
              defaultValue={it.auditHint ?? ""}
              maxLength={200}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="shelfLifeDays" label="Shelf life (days)" hint="Blank = keeps.">
              <Input
                id="shelfLifeDays"
                name="shelfLifeDays"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                defaultValue={it.shelfLifeDays ?? ""}
              />
            </Field>
            <Field id="reorderThreshold" label={`Reorder at (${unit})`} hint="Blank = by usage.">
              <Input
                id="reorderThreshold"
                name="reorderThreshold"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                defaultValue={it.reorderThreshold ?? ""}
              />
            </Field>
          </div>
          <SubmitButton variant="secondary" className="self-start">
            Save settings
          </SubmitButton>
        </ActionForm>
      </section>

      <section aria-labelledby="history">
        <SectionTitle>
          <span id="history">History</span>
        </SectionTitle>
        <ul className="flex flex-col text-sm">
          {d.events.slice(0, 12).map((e) => (
            <EventRow key={e.id} e={e} unit={unit} tz={tz} />
          ))}
        </ul>
        {d.events.length > 12 ? (
          <details className="text-sm">
            <summary className="cursor-pointer py-2 text-muted-foreground">Older events</summary>
            <ul className="flex flex-col">
              {d.events.slice(12).map((e) => (
                <EventRow key={e.id} e={e} unit={unit} tz={tz} />
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </>
  );
}

function Fact({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{children}</div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function EventRow({
  e,
  unit,
  tz,
}: {
  e: Awaited<ReturnType<typeof itemDetail>>["events"][number];
  unit: string;
  tz: string;
}) {
  return (
    <li className="flex gap-3 border-b py-2 last:border-b-0">
      <span className="w-14 shrink-0 text-muted-foreground">{monthDay(e.occurredAt, tz)}</span>
      <span className="min-w-0 flex-1">
        <span className={e.trust === "expired" ? "text-muted-foreground line-through" : undefined}>
          {e.statusOverride === "critical" && e.quantity === null
            ? "Flagged running low"
            : (EVENT_LABEL[e.kind] ?? e.kind)}
          {e.quantity !== null && e.kind !== "consumed" ? ` ${amount(e.quantity, unit)}` : ""}
          {e.kind === "moved" && e.toLocation
            ? ` to ${LOCATION_LABELS[e.toLocation] ?? e.toLocation}`
            : ""}
        </span>{" "}
        <span className="text-xs text-muted-foreground">
          {SOURCE_LABEL[e.source] ?? e.source}
          {e.actorName ? ` · ${e.actorName}` : e.actorSystem ? ` · ${e.actorSystem}` : ""}
        </span>
      </span>
      <TrustBadge trust={e.trust === "confirmed" ? null : e.trust} />
    </li>
  );
}
