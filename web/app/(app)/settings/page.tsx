import { PageSkeleton } from "@/components/page-skeleton";
import { Suspense } from "react";
import { awayPeriod, member } from "@pandabase/db";
import { asc, desc } from "drizzle-orm";
import { PlaneIcon, Trash2Icon } from "lucide-react";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { SubmitButton } from "@/components/submit-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { currentMember } from "@/lib/auth/current";
import { DEFAULT_CONFIG } from "@/lib/config";
import { localDate } from "@/lib/domain/time";
import { dateOnly } from "@/lib/format";
import { TUNABLES } from "@/lib/tunables";
import {
  addAwayAction,
  cartAccountAction,
  deleteAwayAction,
  signOutAction,
  updateMemberAction,
  updateTunablesAction,
} from "./actions";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SettingsPageContent />
    </Suspense>
  );
}

async function SettingsPageContent() {
  const { db, ctx, member: me } = await currentMember();
  const today = localDate(ctx.now, ctx.config.householdTz);
  const [away, members] = await Promise.all([
    db.select().from(awayPeriod).orderBy(desc(awayPeriod.startsOn)),
    db.select().from(member).orderBy(asc(member.displayName)),
  ]);
  const cart = members.find((m) => m.isCartAccount);

  return (
    <>
      <PageHeader title="Settings" subtitle={`Signed in as ${me.email}`} />

      <section aria-labelledby="away">
        <SectionTitle>
          <span id="away">Away periods</span>
        </SectionTitle>
        <p className="mb-2 text-sm text-muted-foreground">
          Days away don&apos;t count toward how fast things get used, and a cart build during them
          is skipped.
        </p>
        <ul className="mb-3 overflow-hidden rounded-xl border bg-card empty:hidden">
          {away.map((a) => {
            const state = a.endsOn < today ? "past" : a.startsOn <= today ? "now" : "upcoming";
            return (
              <li
                key={a.id}
                className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
              >
                <PlaneIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">
                    {dateOnly(a.startsOn)}
                    {a.endsOn !== a.startsOn ? ` – ${dateOnly(a.endsOn)}` : ""}
                  </span>
                  {a.note ? <span className="text-muted-foreground"> · {a.note}</span> : null}
                </span>
                {state === "now" ? <Badge variant="info">now</Badge> : null}
                {state === "past" ? <Badge variant="secondary">past</Badge> : null}
                <ActionForm action={deleteAwayAction}>
                  <input type="hidden" name="id" value={a.id} />
                  <SubmitButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove away period starting ${dateOnly(a.startsOn)}`}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </SubmitButton>
                </ActionForm>
              </li>
            );
          })}
        </ul>
        <ActionForm
          action={addAwayAction}
          className="flex flex-col gap-2 rounded-xl border bg-card p-4"
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="startsOn" className="text-sm font-medium">
                From
              </label>
              <Input id="startsOn" name="startsOn" type="date" required min={today} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="endsOn" className="text-sm font-medium">
                Until (incl.)
              </label>
              <Input id="endsOn" name="endsOn" type="date" required min={today} />
            </div>
          </div>
          <label htmlFor="note" className="sr-only">
            Note
          </label>
          <Input id="note" name="note" placeholder="Note (optional)" maxLength={200} />
          <SubmitButton variant="secondary" className="self-start">
            Add away period
          </SubmitButton>
        </ActionForm>
      </section>

      <section aria-labelledby="members">
        <SectionTitle>
          <span id="members">Members</span>
        </SectionTitle>
        <p className="mb-2 text-sm text-muted-foreground">
          The agent recognizes people by Discord user id — unknown ids can&apos;t change anything.
        </p>
        <div className="flex flex-col gap-3">
          {members.map((m) => (
            <ActionForm
              key={m.id}
              action={updateMemberAction}
              className="flex flex-col gap-2 rounded-xl border bg-card p-4"
            >
              <input type="hidden" name="memberId" value={m.id} />
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-muted-foreground">{m.email}</span>
                {m.isCartAccount ? <Badge variant="ok">cart account</Badge> : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`name-${m.id}`} className="text-sm font-medium">
                    Name
                  </label>
                  <Input
                    id={`name-${m.id}`}
                    name="displayName"
                    defaultValue={m.displayName}
                    required
                    maxLength={60}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`discord-${m.id}`} className="text-sm font-medium">
                    Discord user id
                  </label>
                  <Input
                    id={`discord-${m.id}`}
                    name="discordUserId"
                    inputMode="numeric"
                    defaultValue={m.discordUserId ?? ""}
                    pattern="\d{5,25}"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`sweep-${m.id}`} className="text-sm font-medium">
                  Amazon order sweep
                </label>
                <NativeSelect id={`sweep-${m.id}`} name="amazonSweep" defaultValue={m.amazonSweep}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="off">Off</option>
                </NativeSelect>
              </div>
              <SubmitButton variant="secondary" size="sm" className="self-start">
                Save {m.displayName}
              </SubmitButton>
            </ActionForm>
          ))}
        </div>
        <ActionForm
          action={cartAccountAction}
          className="mt-3 flex flex-col gap-2 rounded-xl border bg-card p-4"
        >
          <label htmlFor="cart-account" className="text-sm font-medium">
            Cart account
          </label>
          <p className="text-xs text-muted-foreground">
            Whose Whole Foods / Amazon cart the agent fills.
          </p>
          <div className="flex gap-2">
            <NativeSelect
              id="cart-account"
              name="memberId"
              defaultValue={cart?.id ?? ""}
              className="flex-1"
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </NativeSelect>
            <SubmitButton variant="secondary">Set</SubmitButton>
          </div>
        </ActionForm>
      </section>

      <section aria-labelledby="defaults">
        <SectionTitle>
          <span id="defaults">Default thresholds</span>
        </SectionTitle>
        <ActionForm
          action={updateTunablesAction}
          className="flex flex-col gap-4 rounded-xl border bg-card p-4"
        >
          {TUNABLES.map((t) => {
            const current = t.get(ctx.config);
            const dflt = t.get(DEFAULT_CONFIG);
            return (
              <div key={t.key} className="flex flex-col gap-1.5">
                <label htmlFor={t.key} className="text-sm font-medium">
                  {t.label}
                </label>
                <Input
                  id={t.key}
                  name={t.key}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={t.step}
                  defaultValue={current}
                  className="w-32"
                  aria-describedby={`${t.key}-hint`}
                />
                <p id={`${t.key}-hint`} className="text-xs text-muted-foreground">
                  {t.hint}
                  {current !== dflt ? ` Default: ${dflt}.` : ""}
                </p>
              </div>
            );
          })}
          <SubmitButton variant="secondary" className="self-start">
            Save thresholds
          </SubmitButton>
        </ActionForm>
      </section>

      <form action={signOutAction} className="mt-8">
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </form>
    </>
  );
}
