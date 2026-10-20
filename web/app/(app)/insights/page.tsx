import { PageSkeleton } from "@/components/page-skeleton";
import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { StackedBars } from "@/components/stacked-bars";
import { Card, CardContent } from "@/components/ui/card";
import { currentMember } from "@/lib/auth/current";
import { weeklyInsights } from "@/lib/diagnostics/insights";
import { lastCompleteWeek, renderWeekly } from "@/lib/diagnostics/weekly";
import { qty } from "@/lib/format";
import { pendingReviews } from "@/lib/services/reviews";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Insights" };

const pct = (n: number, d: number) => (d === 0 ? "–" : `${Math.round((100 * n) / d)}%`);

export default function InsightsPage(props: PageProps<"/insights">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <InsightsPageContent {...props} />
    </Suspense>
  );
}

async function InsightsPageContent(props: PageProps<"/insights">) {
  const { db, ctx } = await currentMember();
  const params = await props.searchParams;
  const weeks = await weeklyInsights(db, ctx, 8);
  const defaultWeek = lastCompleteWeek(ctx.now, ctx.config.householdTz);
  const choices = [...new Set([...weeks.map((w) => w.week).slice(0, -1), defaultWeek])]
    .sort()
    .reverse();
  const week =
    typeof params.week === "string" && choices.includes(params.week) ? params.week : defaultWeek;
  const [report, reviews] = await Promise.all([renderWeekly(db, week, ctx), pendingReviews(db)]);

  const sum = (f: (w: (typeof weeks)[number]) => number) => weeks.reduce((s, w) => s + f(w), 0);
  const lines = sum((w) => w.lines.auto + w.lines.human + w.lines.provisional + w.lines.pending);
  const cart = sum((w) => w.cart.tier1 + w.cart.tier2 + w.cart.failed);
  const errs = weeks.flatMap((w) => (w.estimateError === null ? [] : [w.estimateError]));
  const short = (w: string) => w.replace(/^\d+-W/, "W");

  return (
    <>
      <PageHeader title="Insights" subtitle="How well PandaBase is learning — last 8 weeks." />
      <div className="grid grid-cols-2 gap-3">
        <Tile
          label="Receipt lines matched automatically"
          value={pct(
            sum((w) => w.lines.auto + w.lines.human),
            lines,
          )}
        />
        <Tile
          label="Cart lines added directly (tier 1)"
          value={pct(
            sum((w) => w.cart.tier1),
            cart,
          )}
          hint={cart ? undefined : "No carts yet"}
        />
        <Tile
          label="Estimate vs count, avg. miss"
          value={errs.length ? qty(errs.reduce((a, b) => a + b, 0) / errs.length) : "–"}
          hint="base units"
        />
        <Tile
          label="Reviews answered / expired"
          value={`${sum((w) => w.reviews.answered)} / ${sum((w) => w.reviews.expired)}`}
          hint={`${reviews.length} waiting`}
        />
      </div>

      <section aria-labelledby="lines-chart">
        <SectionTitle>
          <span id="lines-chart">Receipt lines per week</span>
        </SectionTitle>
        <Card>
          <CardContent>
            <StackedBars
              caption="Receipt lines per week by how they were matched"
              series={[
                {
                  key: "confirmed",
                  label: "Confirmed",
                  fill: "fill-chart-1",
                  swatch: "bg-chart-1",
                },
                {
                  key: "provisional",
                  label: "Provisional",
                  fill: "fill-chart-2",
                  swatch: "bg-chart-2",
                },
                { key: "pending", label: "Unmatched", fill: "fill-chart-3", swatch: "bg-chart-3" },
              ]}
              rows={weeks.map((w) => ({
                label: short(w.week),
                values: {
                  confirmed: w.lines.auto + w.lines.human,
                  provisional: w.lines.provisional,
                  pending: w.lines.pending,
                },
              }))}
            />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="report">
        <SectionTitle>
          <span id="report">Weekly report</span>
        </SectionTitle>
        <nav aria-label="Report week" className="-mx-1 mb-3 flex gap-1 overflow-x-auto pb-1">
          {choices.map((w) => (
            <Link
              key={w}
              href={`/insights?week=${w}`}
              aria-current={w === week ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-md border px-2.5 py-1 text-sm",
                w === week ? "border-primary bg-primary text-primary-foreground" : "bg-card",
              )}
            >
              {short(w)}
            </Link>
          ))}
        </nav>
        <article
          className={cn(
            "overflow-x-auto rounded-xl border bg-card p-4 text-sm",
            "[&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold",
            "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:border-t [&_h2]:pt-3 [&_h2]:text-base [&_h2]:font-semibold",
            "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:tracking-wide [&_h3]:text-muted-foreground [&_h3]:uppercase",
            "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
            "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs [&_td]:border-b [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-b [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left",
            "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_code]:break-all",
          )}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.markdown}</ReactMarkdown>
        </article>
      </section>
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
