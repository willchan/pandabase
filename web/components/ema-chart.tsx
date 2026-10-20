import { monthDay, qty } from "@/lib/format";

export interface EmaChartPoint {
  at: string;
  emaDays: number | null;
  observedDays: number | null;
}

/**
 * "Days one unit lasts" over time: the EMA (line) and each measured interval (dots). One y-axis;
 * hover a point for its values; a table view sits underneath for screen readers and exact numbers.
 */
export function EmaChart({
  points,
  unit,
  tz,
}: {
  points: EmaChartPoint[];
  unit: string;
  tz: string;
}) {
  const pts = points.filter((p) => p.at && (p.emaDays !== null || p.observedDays !== null));
  if (pts.length < 2) {
    return <p className="text-sm text-muted-foreground">Not enough purchases yet to chart.</p>;
  }
  const W = 340;
  const H = 150;
  const pad = { l: 34, r: 8, t: 8, b: 22 };
  const t0 = Date.parse(pts[0]!.at);
  const t1 = Date.parse(pts.at(-1)!.at);
  const values = pts
    .flatMap((p) => [p.emaDays, p.observedDays])
    .filter((v): v is number => v !== null);
  const yMax = Math.max(...values) * 1.1 || 1;
  const x = (at: string) =>
    pad.l + ((Date.parse(at) - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const ema = pts.filter((p) => p.emaDays !== null);
  const path = ema
    .map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.emaDays!).toFixed(1)}`)
    .join("");
  const ticks = [0, yMax / 2, yMax].map((v) => Math.round(v * 10) / 10);

  return (
    <figure>
      <div className="mb-1 flex gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-chart-1" aria-hidden="true" /> Average (EMA)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-muted-foreground/50" aria-hidden="true" />{" "}
          Measured
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Days one ${unit} lasts, from ${monthDay(pts[0]!.at, tz)} to ${monthDay(pts.at(-1)!.at, tz)}; latest average ${qty(ema.at(-1)?.emaDays ?? 0)} days.`}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(v)}
              y2={y(v)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={pad.l - 4}
              y={y(v) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px]"
            >
              {qty(v)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 6} className="fill-muted-foreground text-[9px]">
          {monthDay(pts[0]!.at, tz)}
        </text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[9px]">
          {monthDay(pts.at(-1)!.at, tz)}
        </text>
        {pts
          .filter((p) => p.observedDays !== null)
          .map((p) => (
            <circle
              key={`o-${p.at}`}
              cx={x(p.at)}
              cy={y(Math.min(p.observedDays!, yMax))}
              r={3}
              className="fill-muted-foreground/45 stroke-card"
              strokeWidth={1}
            />
          ))}
        <path
          d={path}
          fill="none"
          className="stroke-chart-1"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {pts.map((p) => (
          <circle
            key={`h-${p.at}`}
            cx={x(p.at)}
            cy={y(p.emaDays ?? p.observedDays ?? 0)}
            r={9}
            fill="transparent"
          >
            <title>
              {`${monthDay(p.at, tz)}: average ${p.emaDays === null ? "–" : qty(p.emaDays)} d/${unit}` +
                (p.observedDays === null ? "" : `, measured ${qty(p.observedDays)}`)}
            </title>
          </circle>
        ))}
      </svg>
      <details className="mt-1 text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">Show as table</summary>
        <table className="mt-2 w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="font-medium">Purchase</th>
              <th className="font-medium">Measured (days/{unit})</th>
              <th className="font-medium">Average</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.at}>
                <td>{monthDay(p.at, tz)}</td>
                <td>{p.observedDays === null ? "–" : qty(p.observedDays)}</td>
                <td>{p.emaDays === null ? "–" : qty(p.emaDays)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
