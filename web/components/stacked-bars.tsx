/**
 * Small stacked-bar chart: one bar per week, ≤ 3 series in fixed slot order, legend always shown,
 * hover titles per segment, 2px surface gaps between segments, and a table view.
 */
export interface StackSeries {
  key: string;
  label: string;
  /** Tailwind fill class for the slot, e.g. `fill-chart-1`. */
  fill: string;
  swatch: string;
}

export function StackedBars({
  rows,
  series,
  caption,
}: {
  rows: { label: string; values: Record<string, number> }[];
  series: StackSeries[];
  caption: string;
}) {
  const W = 340;
  const H = 140;
  const pad = { l: 26, r: 4, t: 6, b: 18 };
  const totals = rows.map((r) => series.reduce((s, x) => s + (r.values[x.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const slot = (W - pad.l - pad.r) / rows.length;
  const bw = Math.min(22, slot * 0.6);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  return (
    <figure>
      <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={`size-2.5 rounded-sm ${s.swatch}`} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {[0, max].map((v) => (
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
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          let acc = 0;
          return (
            <g key={r.label}>
              {series.map((s, j) => {
                const v = r.values[s.key] ?? 0;
                if (v <= 0) return null;
                const top = y(acc + v);
                const bottom = y(acc);
                acc += v;
                const isTop = series.slice(j + 1).every((n) => (r.values[n.key] ?? 0) <= 0);
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={top}
                    width={bw}
                    height={Math.max(0, bottom - top)}
                    rx={isTop ? 3 : 0}
                    className={`${s.fill} stroke-card`}
                    strokeWidth={1}
                  >
                    <title>{`${r.label}: ${v} ${s.label.toLowerCase()}`}</title>
                  </rect>
                );
              })}
              <text
                x={x + bw / 2}
                y={H - 5}
                textAnchor="middle"
                className="fill-muted-foreground text-[9px]"
              >
                {r.label}
              </text>
            </g>
          );
        })}
      </svg>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-muted-foreground">Show as table</summary>
        <table className="mt-2 w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="font-medium">Week</th>
              {series.map((s) => (
                <th key={s.key} className="font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                {series.map((s) => (
                  <td key={s.key}>{r.values[s.key] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
