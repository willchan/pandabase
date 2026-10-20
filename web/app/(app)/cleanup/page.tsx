import { item } from "@pandabase/db";
import { asc, isNull } from "drizzle-orm";
import { ChevronRightIcon, ReceiptTextIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { PageHeader } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { currentMember } from "@/lib/auth/current";
import { monthDay, shortDate, vendorName } from "@/lib/format";
import { pendingReviews, type ReviewSummary } from "@/lib/services/reviews";
import {
  answerTrashCamAction,
  confirmItemAction,
  dismissAction,
  mergeAction,
} from "./actions";

export const metadata: Metadata = { title: "Cleanup" };

const TABS = [
  { id: "receipts", label: "Receipts", kinds: ["receipt"] },
  { id: "merges", label: "Merges", kinds: ["merge_suggestion", "new_product"] },
  { id: "unverified", label: "Unverified", kinds: ["unverified_item"] },
  { id: "jobs", label: "Jobs", kinds: ["failed_job", "trash_cam"] },
] as const;

type ItemOption = { id: string; name: string };

export default async function CleanupPage(props: PageProps<"/cleanup">) {
  const { db, ctx } = await currentMember();
  const tz = ctx.config.householdTz;
  const params = await props.searchParams;
  const [reviews, items] = await Promise.all([
    pendingReviews(db),
    db
      .select({ id: item.id, name: item.canonicalName })
      .from(item)
      .where(isNull(item.mergedIntoItemId))
      .orderBy(asc(item.canonicalName)),
  ]);
  const byTab = TABS.map((t) => ({
    ...t,
    reviews: reviews.filter((r) => (t.kinds as readonly string[]).includes(r.kind)),
  }));
  const first = byTab.find((t) => t.reviews.length > 0)?.id ?? "receipts";
  const requested = typeof params.tab === "string" ? params.tab : null;

  return (
    <>
      <PageHeader
        title="Cleanup"
        subtitle={
          reviews.length === 0
            ? "All caught up."
            : `${reviews.length} waiting · nothing here blocks the cart`
        }
      />
      {params.done === "receipt" ? (
        <Alert className="mb-4">
          <AlertDescription>Receipt confirmed — thanks, matching learns from it.</AlertDescription>
        </Alert>
      ) : null}
      <Tabs defaultValue={byTab.some((t) => t.id === requested) ? requested! : first}>
        <TabsList>
          {byTab.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
              {t.reviews.length > 0 ? (
                <span className="rounded-full bg-primary/15 px-1.5 text-xs text-primary">
                  {t.reviews.length}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {byTab.map((t) => (
          <TabsContent key={t.id} value={t.id} className="flex flex-col gap-3">
            {t.reviews.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                Nothing here.
              </p>
            ) : (
              t.reviews.map((r) => (
                <ReviewCard key={r.id} review={r} items={items} now={ctx.now} tz={tz} />
              ))
            )}
          </TabsContent>
        ))}
      </Tabs>
      <p className="mt-6 text-xs text-muted-foreground">
        Sorted by how much each one affects this week&apos;s cart. Anything you leave alone expires
        and keeps the system&apos;s best guess.
      </p>
    </>
  );
}

function Meta({ review, tz }: { review: ReviewSummary; tz: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {review.urgency === "this_week" ? <Badge variant="warn">Affects this week</Badge> : null}
      <span>
        {review.expiresAt ? `Expires ${shortDate(review.expiresAt, tz)}` : "Never expires"}
      </span>
    </span>
  );
}

function ItemSelect({
  items,
  name,
  id,
  exclude,
  defaultValue,
  label,
}: {
  items: ItemOption[];
  name: string;
  id: string;
  exclude?: string | null;
  defaultValue?: string;
  label: string;
}) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <NativeSelect id={id} name={name} defaultValue={defaultValue ?? ""} required className="flex-1">
        <option value="" disabled>
          {label}…
        </option>
        {items
          .filter((i) => i.id !== exclude)
          .map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
      </NativeSelect>
    </>
  );
}

function DismissForm({ id, label = "Dismiss" }: { id: string; label?: string }) {
  return (
    <ActionForm action={dismissAction}>
      <input type="hidden" name="reviewId" value={id} />
      <SubmitButton variant="ghost" size="sm">
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

function ReviewCard({
  review: r,
  items,
  tz,
}: {
  review: ReviewSummary;
  items: ItemOption[];
  now: string;
  tz: string;
}) {
  const p = r.payload;
  const detected = typeof p.detected_name === "string" ? p.detected_name : null;

  switch (r.kind) {
    case "receipt":
      return (
        <Link href={`/cleanup/receipts/${r.id}`} className="group block">
          <Card className="transition-colors group-hover:bg-accent/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ReceiptTextIcon className="size-4 text-primary" aria-hidden="true" />
                {r.receipt ? vendorName(r.receipt.vendor) : "Receipt"}
                {r.receipt ? ` · ${monthDay(r.receipt.acquiredAt, tz)}` : ""}
              </CardTitle>
              <CardDescription>
                {r.receipt?.lines ?? 0} line{r.receipt?.lines === 1 ? "" : "s"} to check
                {r.receipt?.source === "paper" ? " against the photo" : ""}
              </CardDescription>
              <ChevronRightIcon
                className="col-start-2 row-span-2 row-start-1 self-center text-muted-foreground"
                aria-hidden="true"
              />
            </CardHeader>
            <CardContent>
              <Meta review={r} tz={tz} />
            </CardContent>
          </Card>
        </Link>
      );

    case "new_product":
    case "unverified_item":
      return (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {r.itemName ?? "New item"} <Badge variant="unverified">unverified</Badge>
            </CardTitle>
            <CardDescription>
              {r.kind === "new_product"
                ? `Created from ${detected ? `“${detected}”` : "a new product on a receipt"}. Is it really new?`
                : "Created automatically. Does the name look right?"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ActionForm action={confirmItemAction} className="flex flex-col gap-2">
              <input type="hidden" name="reviewId" value={r.id} />
              <label htmlFor={`name-${r.id}`} className="text-sm font-medium">
                Keep as its own item
              </label>
              <div className="flex gap-2">
                <Input
                  id={`name-${r.id}`}
                  name="name"
                  defaultValue={r.itemName ?? ""}
                  maxLength={120}
                />
                <SubmitButton size="default" variant="secondary">
                  Keep
                </SubmitButton>
              </div>
            </ActionForm>
            <ActionForm action={mergeAction} className="flex flex-col gap-2">
              <input type="hidden" name="reviewId" value={r.id} />
              <input type="hidden" name="itemId" value={r.itemId ?? ""} />
              <span className="text-sm font-medium">…or it&apos;s something we already have</span>
              <div className="flex gap-2">
                <ItemSelect
                  items={items}
                  name="intoItemId"
                  id={`into-${r.id}`}
                  exclude={r.itemId}
                  label="Same as"
                />
                <ConfirmButton confirmLabel="Merge" size="default">
                  Merge
                </ConfirmButton>
              </div>
            </ActionForm>
            <Meta review={r} tz={tz} />
          </CardContent>
        </Card>
      );

    case "merge_suggestion":
      return (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {r.itemName ?? "An item"} → {r.mergeInto?.name ?? "?"}
            </CardTitle>
            <CardDescription>
              Looks like the same thing
              {typeof p.confidence === "number" ? ` (${Math.round(p.confidence * 100)}% sure)` : ""}
              {typeof p.reason === "string" ? ` — ${p.reason}` : "."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <ActionForm action={mergeAction}>
              <input type="hidden" name="reviewId" value={r.id} />
              <input type="hidden" name="itemId" value={r.itemId ?? ""} />
              <input type="hidden" name="intoItemId" value={r.mergeInto?.id ?? ""} />
              <ConfirmButton confirmLabel="Yes, merge" variant="default">
                Merge
              </ConfirmButton>
            </ActionForm>
            <DismissForm id={r.id} label="Not the same" />
            <span className="basis-full">
              <Meta review={r} tz={tz} />
            </span>
          </CardContent>
        </Card>
      );

    case "trash_cam": {
      const conf = typeof p.confidence === "number" ? Math.round(p.confidence * 100) : null;
      return (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Trash Cam: not sure what that was</CardTitle>
            <CardDescription>
              Saw {detected ? `“${detected}”` : "something"}
              {conf !== null ? ` (${conf}% sure)` : ""}
              {r.itemName ? ` — maybe ${r.itemName}?` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <ActionForm action={answerTrashCamAction} className="flex gap-2">
              <input type="hidden" name="reviewId" value={r.id} />
              <ItemSelect
                items={items}
                name="itemId"
                id={`trash-${r.id}`}
                defaultValue={r.itemId ?? undefined}
                label="It was"
              />
              <SubmitButton variant="secondary">Mark out</SubmitButton>
            </ActionForm>
            <div className="flex items-center justify-between gap-2">
              <Meta review={r} tz={tz} />
              <DismissForm id={r.id} />
            </div>
          </CardContent>
        </Card>
      );
    }

    case "failed_job":
      return (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {r.job?.type === "paper_receipt"
                ? "A receipt photo couldn't be read"
                : r.job?.type === "trash_cam"
                  ? "A Trash Cam photo couldn't be read"
                  : "A job failed"}
            </CardTitle>
            <CardDescription>
              {r.job?.error ?? (typeof p.error === "string" ? p.error : "Unknown error")}
              {r.job ? ` · ${r.job.attempts} attempt${r.job.attempts === 1 ? "" : "s"}` : ""}. Send
              a clearer photo in Discord if it matters.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-2">
            <Meta review={r} tz={tz} />
            <DismissForm id={r.id} />
          </CardContent>
        </Card>
      );
  }
}
