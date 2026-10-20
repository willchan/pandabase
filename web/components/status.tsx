import { Badge } from "@/components/ui/badge";

export type InventoryStatus = "out" | "low" | "stocked" | "unknown" | "critical" | "consumed";

const STATUS: Record<
  InventoryStatus,
  { label: string; variant: "ok" | "warn" | "bad" | "secondary" }
> = {
  stocked: { label: "Stocked", variant: "ok" },
  low: { label: "Low", variant: "warn" },
  critical: { label: "Running low", variant: "warn" },
  out: { label: "Out", variant: "bad" },
  consumed: { label: "Out", variant: "bad" },
  unknown: { label: "Unknown", variant: "secondary" },
};

export function StatusBadge({ status }: { status: InventoryStatus }) {
  const s = STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** Machine guesses that no human has confirmed yet (PRD §3.3) — shown, never nagged about. */
export function TrustBadge({
  trust,
  title,
}: {
  trust: "provisional" | "unverified" | "confirmed" | "expired" | null | undefined;
  title?: string;
}) {
  if (trust === "provisional")
    return (
      <Badge
        variant="unverified"
        title={title ?? "Applied from a likely match — not yet confirmed"}
      >
        provisional
      </Badge>
    );
  if (trust === "unverified")
    return (
      <Badge variant="unverified" title={title ?? "Created automatically — not yet confirmed"}>
        unverified
      </Badge>
    );
  if (trust === "expired")
    return (
      <Badge variant="secondary" className="line-through" title="Reversed">
        reversed
      </Badge>
    );
  return null;
}
