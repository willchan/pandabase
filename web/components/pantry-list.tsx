"use client";

import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { StatusBadge, TrustBadge, type InventoryStatus } from "@/components/status";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PantryRow {
  id: string;
  name: string;
  location: string;
  status: InventoryStatus;
  amount: string;
  /** e.g. "use by Oct 24"; `useByTone` colors it. */
  useBy: string | null;
  useByTone: "past" | "soon" | null;
  itemTrust: "confirmed" | "unverified";
  lastTrust: "provisional" | null;
}

const NEEDS = new Set<InventoryStatus>(["out", "low", "critical", "consumed"]);

export function PantryList({
  rows,
  locations,
}: {
  rows: PantryRow[];
  locations: [string, string][];
}) {
  const [q, setQ] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!needle || r.name.toLowerCase().includes(needle)) && (!onlyLow || NEEDS.has(r.status)),
    );
  }, [rows, q, onlyLow]);
  const low = rows.filter((r) => NEEDS.has(r.status)).length;

  return (
    <>
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Do we have…"
            aria-label="Search the pantry"
            className="pl-9"
          />
        </div>
        <button
          type="button"
          aria-pressed={onlyLow}
          onClick={() => setOnlyLow((v) => !v)}
          className={cn(
            "h-10 shrink-0 rounded-md border px-3 text-sm font-medium",
            onlyLow ? "border-primary bg-primary text-primary-foreground" : "bg-card",
          )}
        >
          Low / out ({low})
        </button>
      </div>
      {locations.map(([loc, label]) => {
        const mine = shown.filter((r) => r.location === loc);
        if (mine.length === 0) return null;
        return (
          <section key={loc} aria-labelledby={`loc-${loc}`} className="mb-5">
            <h2
              id={`loc-${loc}`}
              className="mb-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {label}
            </h2>
            <ul className="overflow-hidden rounded-xl border bg-card">
              {mine.map((r) => (
                <li key={r.id} className="border-b last:border-b-0">
                  <Link
                    href={`/pantry/${r.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        {r.itemTrust === "unverified" ? <TrustBadge trust="unverified" /> : null}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{r.amount}</span>
                        {r.lastTrust ? <TrustBadge trust="provisional" /> : null}
                        {r.useBy ? (
                          <span
                            className={cn(
                              r.useByTone === "past" && "text-bad",
                              r.useByTone === "soon" && "text-warn",
                            )}
                          >
                            {r.useBy}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <StatusBadge status={r.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches.</p>
      ) : null}
    </>
  );
}
