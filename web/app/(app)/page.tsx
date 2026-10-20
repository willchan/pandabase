import { PageSkeleton } from "@/components/page-skeleton";
import { Suspense } from "react";
import { groceryCycleOverride, item, member } from "@pandabase/db";
import { asc, eq, isNull } from "drizzle-orm";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  InboxIcon,
  PlusIcon,
  SnowflakeIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { ReasonBadge, onHandText } from "@/components/reason";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { currentMember } from "@/lib/auth/current";
import { cycleSchedule } from "@/lib/domain/cycle";
import { amount, dayTime, money, monthDay, qty, relativeDay, vendorName } from "@/lib/format";
import { activeCycle } from "@/lib/repo/cycles";
import { checkin, predictions } from "@/lib/services/cycles";
import { pendingReviews } from "@/lib/services/reviews";
import {
  addToListAction,
  cycleStatusAction,
  markItemAction,
  openCycleAction,
  setProductAction,
  setQuantityAction,
  skipItemAction,
  unskipItemAction,
} from "./actions";

export const metadata: Metadata = { title: "This Week" };

const STATUS_LABEL = {
  open: "Open",
  building: "Building cart",
  ready: "Cart ready",
  closed: "Closed",
  skipped: "Skipped",
  other_store: "Other store",
} as const;

export default function ThisWeekPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ThisWeekPageContent />
    </Suspense>
  );
}

async function ThisWeekPageContent() {
  const { db, ctx } = await currentMember();
  const tz = ctx.config.householdTz;
  const cycle = await activeCycle(db);
  const [plan, check, reviews, items] = await Promise.all([
    predictions(db, cycle?.id ?? null, ctx),
    checkin(db, ctx),
    pendingReviews(db),
    db
      .select({ id: item.id, name: item.canonicalName })
      .from(item)
      .where(isNull(item.mergedIntoItemId))
      .orderBy(asc(item.canonicalName)),
  ]);
  const runout = new Map(check.likely_needed.map((l) => [l.item_id, l.runout_at]));
  const names = new Map(items.map((i) => [i.id, i.name]));
  const urgent = reviews.filter((r) => r.urgency === "this_week");

  if (!cycle) {
    return (
      <>
        <PageHeader title="This Week" subtitle="No list is open right now." />
        <Card>
          <CardHeader>
            <CardTitle>Start this week&apos;s list</CardTitle>
            <CardDescription>
              The agent opens one automatically on Monday morning. Open it now to start adding
              things — {plan.lines.length} items are already predicted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={openCycleAction}>
              <SubmitButton>Open this week&apos;s list</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      </>
    );
  }

  const schedule = cycleSchedule(cycle.weekLabel, ctx.config);
  const overrides = await db
    .select({
      id: groceryCycleOverride.id,
      kind: groceryCycleOverride.kind,
      itemId: groceryCycleOverride.itemId,
      freeText: groceryCycleOverride.freeText,
      quantity: groceryCycleOverride.quantity,
      createdAt: groceryCycleOverride.createdAt,
      who: member.displayName,
    })
    .from(groceryCycleOverride)
    .leftJoin(member, eq(member.id, groceryCycleOverride.actorMemberId))
    .where(eq(groceryCycleOverride.cycleId, cycle.id))
    .orderBy(asc(groceryCycleOverride.createdAt));
  const cycleId = cycle.id;
  const editable =
    cycle.status === "open" || cycle.status === "building" || cycle.status === "ready";
  const steps = [
    { label: "Opened", at: cycle.openedAt, done: true },
    {
      label: "Nudge",
      at: cycle.nudgeSentAt ?? schedule.nudgeAt,
      done: cycle.nudgeSentAt !== null,
    },
    {
      label: "Cart build",
      at: cycle.builtAt ?? schedule.buildAt,
      done: cycle.builtAt !== null,
    },
  ];
  const needsYou = urgent.length + check.please_check.length;

  return (
    <>
      <PageHeader
        title="This Week"
        subtitle={`${cycle.weekLabel.replace(/^\d+-W/, "Week ")} · ${plan.lines.length} on the list`}
        action={<Badge variant="secondary">{STATUS_LABEL[cycle.status]}</Badge>}
      />

      <ol className="mb-2 grid grid-cols-3 gap-2 text-xs" aria-label="This week's schedule">
        {steps.map((s) => (
          <li key={s.label} className="flex flex-col gap-0.5 rounded-lg border bg-card px-2.5 py-2">
            <span className="flex items-center gap-1 font-medium">
              {s.done ? (
                <CheckCircle2Icon className="size-3.5 text-ok" aria-label="done" />
              ) : (
                <CircleIcon className="size-3.5 text-muted-foreground" aria-label="upcoming" />
              )}
              {s.label}
            </span>
            <span className="text-muted-foreground">{dayTime(s.at, tz)}</span>
          </li>
        ))}
      </ol>

      {needsYou > 0 ? (
        <section aria-labelledby="needs-you">
          <SectionTitle>
            <span id="needs-you">Needs you</span>
          </SectionTitle>
          <Card className="gap-0 py-0">
            {urgent.length > 0 ? (
              <Link
                href="/cleanup"
                className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-accent/50"
              >
                <InboxIcon className="size-5 text-primary" aria-hidden="true" />
                <span className="flex-1 text-sm">
                  <span className="font-medium">
                    {urgent.length} review{urgent.length === 1 ? "" : "s"}
                  </span>{" "}
                  {urgent.length === 1 ? "touches" : "touch"} this week&apos;s cart
                </span>
                <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            ) : null}
            {check.please_check.map((p) => (
              <details key={p.item_id} className="group border-b last:border-b-0">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">Check: {p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {p.audit_hint ??
                        (p.runout_at
                          ? `Might run out ${relativeDay(p.runout_at, ctx.now, tz)}`
                          : onHandText(p.on_hand, p.base_unit))}
                    </span>
                  </span>
                  <ChevronRightIcon
                    className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                </summary>
                <div className="flex flex-wrap items-start gap-2 px-4 pb-3">
                  <ActionForm action={markItemAction} className="flex items-center gap-2">
                    <input type="hidden" name="itemId" value={p.item_id} />
                    <input type="hidden" name="mark" value="count" />
                    <label className="sr-only" htmlFor={`count-${p.item_id}`}>
                      How many {p.base_unit === "count" ? "" : `${p.base_unit}s `}do you have?
                    </label>
                    <Input
                      id={`count-${p.item_id}`}
                      name="quantity"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      placeholder="Count"
                      className="w-24"
                      required
                    />
                    <SubmitButton size="sm" variant="secondary">
                      Save count
                    </SubmitButton>
                  </ActionForm>
                  <ActionForm action={markItemAction}>
                    <input type="hidden" name="itemId" value={p.item_id} />
                    <input type="hidden" name="mark" value="out" />
                    <SubmitButton size="sm" variant="outline">
                      We&apos;re out
                    </SubmitButton>
                  </ActionForm>
                </div>
              </details>
            ))}
          </Card>
        </section>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          Nothing needs you right now. The cart builds {dayTime(schedule.buildAt, tz)} from
          predictions.
        </p>
      )}

      <section aria-labelledby="cart-plan">
        <SectionTitle aside={<span className="text-xs text-muted-foreground">tap to change</span>}>
          <span id="cart-plan">Planned cart</span>
        </SectionTitle>
        {plan.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing predicted yet.</p>
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-xl border bg-card">
            {plan.lines.map((l) => {
              const key = l.item_id ?? `free:${l.free_text}`;
              const product = l.product;
              const unitLabel = product
                ? `${qty(l.quantity)} × ${product.title}`
                : amount(l.quantity, l.base_unit ?? "count");
              const price = money(product?.quote_cents ?? product?.last_price_cents ?? null);
              return (
                <li key={key} className="border-b last:border-b-0">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium">{l.name}</span>
                          <ReasonBadge
                            reason={l.reason}
                            runoutAt={l.item_id ? runout.get(l.item_id) : null}
                            added={l.overrides.includes("add")}
                            now={ctx.now}
                            tz={tz}
                          />
                        </span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">
                          {unitLabel}
                          {price ? ` · ${price}` : ""}
                          {product ? ` · ${vendorName(product.vendor)}` : ""}
                        </span>
                        {l.choice_reason && l.candidates.length > 1 ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {l.overrides.includes("product") ? "Your pick" : l.choice_reason}
                          </span>
                        ) : null}
                      </span>
                      {l.item_id ? (
                        <ChevronRightIcon
                          className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                          aria-hidden="true"
                        />
                      ) : null}
                    </summary>
                    {l.item_id && editable ? (
                      <div className="flex flex-col gap-3 border-t bg-muted/40 px-4 py-3">
                        <div className="flex flex-wrap items-start gap-2">
                          <ActionForm
                            action={setQuantityAction}
                            className="flex items-center gap-2"
                          >
                            <input type="hidden" name="cycleId" value={cycleId} />
                            <input type="hidden" name="itemId" value={l.item_id} />
                            <label htmlFor={`qty-${key}`} className="text-sm">
                              Qty
                            </label>
                            <Input
                              id={`qty-${key}`}
                              name="quantity"
                              type="number"
                              inputMode="decimal"
                              min={0.1}
                              step="any"
                              defaultValue={l.quantity}
                              className="w-20"
                            />
                            <SubmitButton size="sm" variant="secondary">
                              Set
                            </SubmitButton>
                          </ActionForm>
                          <ActionForm action={skipItemAction} className="ml-auto">
                            <input type="hidden" name="cycleId" value={cycleId} />
                            <input type="hidden" name="itemId" value={l.item_id} />
                            <SubmitButton size="sm" variant="outline">
                              Skip this week
                            </SubmitButton>
                          </ActionForm>
                        </div>
                        {l.candidates.length > 1 ? (
                          <ActionForm action={setProductAction} className="flex items-center gap-2">
                            <input type="hidden" name="cycleId" value={cycleId} />
                            <input type="hidden" name="itemId" value={l.item_id} />
                            <label htmlFor={`product-${key}`} className="sr-only">
                              Product for {l.name}
                            </label>
                            <NativeSelect
                              id={`product-${key}`}
                              name="productId"
                              defaultValue={product?.id}
                              className="flex-1"
                            >
                              {l.candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.title}
                                  {c.stance === "preferred" ? " (usual)" : ""}
                                  {money(c.quote_cents ?? c.last_price_cents)
                                    ? ` · ${money(c.quote_cents ?? c.last_price_cents)}`
                                    : ""}
                                </option>
                              ))}
                            </NativeSelect>
                            <SubmitButton size="sm" variant="secondary">
                              Use
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        <Link
                          href={`/pantry/${l.item_id}`}
                          className="text-sm text-primary underline-offset-4 hover:underline"
                        >
                          Item details
                        </Link>
                      </div>
                    ) : null}
                  </details>
                </li>
              );
            })}
          </ul>
        )}

        {plan.skipped_item_ids.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Skipped:</span>
            {plan.skipped_item_ids.map((id) => (
              <ActionForm key={id} action={unskipItemAction} className="inline">
                <input type="hidden" name="cycleId" value={cycleId} />
                <input type="hidden" name="itemId" value={id} />
                <SubmitButton size="sm" variant="ghost" aria-label={`Add ${names.get(id)} back`}>
                  <PlusIcon aria-hidden="true" />
                  {names.get(id) ?? "item"}
                </SubmitButton>
              </ActionForm>
            ))}
          </div>
        ) : null}

        {editable ? (
          <ActionForm action={addToListAction} className="mt-4 flex flex-col gap-1">
            <input type="hidden" name="cycleId" value={cycleId} />
            <label htmlFor="add-text" className="text-sm font-medium">
              Add to the list
            </label>
            <div className="flex gap-2">
              <Input
                id="add-text"
                name="text"
                list="item-names"
                placeholder="Milk, birthday candles…"
                autoComplete="off"
                required
                maxLength={200}
              />
              <label htmlFor="add-qty" className="sr-only">
                Quantity
              </label>
              <Input
                id="add-qty"
                name="quantity"
                type="number"
                inputMode="decimal"
                min={0.1}
                step="any"
                placeholder="Qty"
                className="w-20"
              />
              <SubmitButton aria-label="Add">
                <PlusIcon aria-hidden="true" />
              </SubmitButton>
            </div>
            <datalist id="item-names">
              {items.map((i) => (
                <option key={i.id} value={i.name} />
              ))}
            </datalist>
          </ActionForm>
        ) : null}
      </section>

      {overrides.length > 0 ? (
        <section aria-labelledby="running-list">
          <SectionTitle>
            <span id="running-list">Running list</span>
          </SectionTitle>
          <ul className="flex flex-col gap-1 text-sm">
            {overrides.map((o) => (
              <li key={o.id} className="flex gap-2">
                <span className="w-20 shrink-0 text-muted-foreground">
                  {monthDay(o.createdAt, tz)}
                </span>
                <span>
                  <span className="font-medium">{o.who ?? "Agent"}</span>{" "}
                  {o.kind === "skip"
                    ? "skipped"
                    : o.kind === "qty"
                      ? `set ${qty(o.quantity ?? 0)} ×`
                      : o.kind === "product"
                        ? "picked a product for"
                        : "added"}{" "}
                  {o.freeText ?? (o.itemId ? names.get(o.itemId) : null) ?? "an item"}
                  {o.kind === "add" && o.quantity && o.quantity !== 1
                    ? ` (${qty(o.quantity)})`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {check.freezer.length > 0 ? (
        <section aria-labelledby="freezer">
          <SectionTitle>
            <span id="freezer" className="inline-flex items-center gap-1">
              <SnowflakeIcon className="size-3.5" aria-hidden="true" />
              Oldest in the freezer
            </span>
          </SectionTitle>
          <ul className="flex flex-col gap-1 text-sm">
            {check.freezer.map((f) => (
              <li key={f.item_id} className="flex justify-between gap-2">
                <Link href={`/pantry/${f.item_id}`} className="underline-offset-4 hover:underline">
                  {f.name}
                </Link>
                <span className="text-muted-foreground">
                  {amount(f.quantity, f.base_unit)}
                  {f.frozen_at ? ` · since ${monthDay(f.frozen_at, tz)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {editable ? (
        <section aria-labelledby="week-actions" className="mt-8 border-t pt-4">
          <h2 id="week-actions" className="sr-only">
            Change this week
          </h2>
          <p className="mb-2 text-sm text-muted-foreground">
            Not shopping this week? Nothing is ever checked out for you — these just stop the cart.
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={cycleStatusAction}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <input type="hidden" name="status" value="skipped" />
              <ConfirmButton confirmLabel="Yes, skip this week">Skip this week</ConfirmButton>
            </ActionForm>
            <ActionForm action={cycleStatusAction}>
              <input type="hidden" name="cycleId" value={cycleId} />
              <input type="hidden" name="status" value="other_store" />
              <ConfirmButton confirmLabel="Yes, shopping elsewhere">
                Shopping elsewhere
              </ConfirmButton>
            </ActionForm>
            {cycle.status === "ready" ? (
              <ActionForm action={cycleStatusAction}>
                <input type="hidden" name="cycleId" value={cycleId} />
                <input type="hidden" name="status" value="closed" />
                <ConfirmButton confirmLabel="Yes, we're done">Done shopping</ConfirmButton>
              </ActionForm>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
