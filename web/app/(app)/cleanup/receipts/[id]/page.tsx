import { PageSkeleton } from "@/components/page-skeleton";
import { Suspense } from "react";
import { item } from "@pandabase/db";
import { asc, isNull } from "drizzle-orm";
import { ArrowLeftIcon, ImageOffIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { TrustBadge } from "@/components/status";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { currentMember } from "@/lib/auth/current";
import { appContext } from "@/lib/context";
import { money, monthDay, qty, shortDate, vendorName } from "@/lib/format";
import { ApiError } from "@/lib/http";
import { receiptReviewDetail } from "@/lib/services/reviews";
import { answerReceiptAction } from "../../actions";

export const metadata: Metadata = { title: "Receipt review" };

export default function ReceiptReviewPage(props: PageProps<"/cleanup/receipts/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReceiptReviewPageContent {...props} />
    </Suspense>
  );
}

async function ReceiptReviewPageContent(props: PageProps<"/cleanup/receipts/[id]">) {
  const { db, ctx } = await currentMember();
  const tz = ctx.config.householdTz;
  const { id } = await props.params;
  const detail = await receiptReviewDetail(db, id).catch((err) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const items = await db
    .select({ id: item.id, name: item.canonicalName })
    .from(item)
    .where(isNull(item.mergedIntoItemId))
    .orderBy(asc(item.canonicalName));
  const photo = detail.mediaKey
    ? await appContext()
        .r2.presign("GET", detail.mediaKey, ctx.config.jobs.presignSeconds)
        .catch(() => null)
    : null;
  const { review, receipt: rec } = detail;
  const open = detail.lines.filter((l) => l.state === "pending" || l.state === "provisional");
  const settled = detail.lines.filter((l) => l.state === "confirmed" || l.state === "ignored");
  const pending = review.status === "pending";

  return (
    <>
      <Link
        href="/cleanup?tab=receipts"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" /> Cleanup
      </Link>
      <PageHeader
        title={`${vendorName(rec.vendor)} · ${monthDay(rec.acquiredAt, tz)}`}
        subtitle={
          <>
            {rec.source === "paper"
              ? "Paper receipt"
              : rec.source === "digital"
                ? "Online order"
                : "Manual"}
            {money(rec.totalCents) ? ` · ${money(rec.totalCents)}` : ""}
            {rec.totalsCheck === "fail" ? " · totals don't add up" : ""}
            {pending && review.expiresAt ? ` · expires ${shortDate(review.expiresAt, tz)}` : ""}
          </>
        }
        action={pending ? null : <Badge variant="ok">{review.status}</Badge>}
      />

      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-start">
        <figure className="overflow-hidden rounded-xl border bg-muted md:sticky md:top-4">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL, not optimizable
            <img
              src={photo}
              alt={`Photo of the ${vendorName(rec.vendor)} receipt`}
              className="max-h-[60vh] w-full object-contain md:max-h-[80vh]"
            />
          ) : (
            <div className="flex h-32 flex-col items-center justify-center gap-1 text-sm text-muted-foreground md:h-64">
              <ImageOffIcon className="size-6" aria-hidden="true" />
              {detail.mediaKey ? "Photo unavailable" : "No photo for this receipt"}
            </div>
          )}
        </figure>

        <div>
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing left to check on this receipt.</p>
          ) : (
            <ActionForm action={answerReceiptAction} className="flex flex-col gap-3">
              <input type="hidden" name="reviewId" value={review.id} />
              <p className="text-sm text-muted-foreground">
                Check each line against the photo, then confirm once.
              </p>
              <ul className="flex flex-col gap-3">
                {open.map((l) => (
                  <li key={l.id} className="rounded-xl border bg-card p-3">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <span className="font-mono text-sm break-all">{l.rawText}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        ×{qty(l.qty)}
                        {money(l.lineTotalCents) ? ` · ${money(l.lineTotalCents)}` : ""}
                      </span>
                    </div>
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {l.state === "provisional" ? (
                        <>
                          <TrustBadge trust="provisional" />
                          Best guess {l.itemName}
                          {l.matchScore !== null
                            ? ` (${Math.round(l.matchScore * 100)}% match)`
                            : ""}
                        </>
                      ) : (
                        <Badge variant="warn">No match yet</Badge>
                      )}
                    </div>
                    <label htmlFor={`line-${l.id}`} className="sr-only">
                      What is “{l.rawText}”?
                    </label>
                    <NativeSelect
                      id={`line-${l.id}`}
                      name={`line:${l.id}`}
                      defaultValue={l.state === "provisional" ? "keep" : "leave"}
                      disabled={!pending}
                    >
                      {l.state === "provisional" ? (
                        <option value="keep">✓ {l.itemName}</option>
                      ) : (
                        <option value="leave">Leave unmatched</option>
                      )}
                      <option value="ignore">Not an item (fee, bag, tax…)</option>
                      <optgroup label="It's…">
                        {items
                          .filter((i) => i.id !== l.itemId)
                          .map((i) => (
                            <option key={i.id} value={`item:${i.id}`}>
                              {i.name}
                            </option>
                          ))}
                      </optgroup>
                    </NativeSelect>
                  </li>
                ))}
              </ul>
              {pending ? (
                <SubmitButton size="lg" className="w-full" pendingLabel="Confirming…">
                  Confirm receipt
                </SubmitButton>
              ) : null}
            </ActionForm>
          )}

          {settled.length > 0 ? (
            <details className="mt-4 rounded-xl border bg-card">
              <summary className="cursor-pointer px-4 py-3 text-sm">
                {settled.length} line{settled.length === 1 ? "" : "s"} matched automatically
              </summary>
              <ul className="border-t px-4 py-2 text-sm">
                {settled.map((l) => (
                  <li key={l.id} className="flex justify-between gap-2 py-1">
                    <span className="truncate font-mono text-xs">{l.rawText}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {l.state === "ignored" ? "ignored" : l.itemName}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
    </>
  );
}
