import { Badge } from "@/components/ui/badge";
import { amount, relativeDay } from "@/lib/format";

type Reason =
  "runout" | "critical" | "consumed" | "static_threshold" | "near_runout" | "audit_hint";

/** Why a line is on the list (DESIGN §4.3 restock reasons), in household words. */
export function ReasonBadge({
  reason,
  runoutAt,
  added,
  now,
  tz,
}: {
  reason: Reason | null;
  runoutAt?: string | null;
  added?: boolean;
  now: string;
  tz: string;
}) {
  switch (reason) {
    case "runout":
    case "near_runout":
      return (
        <Badge variant="warn">
          {runoutAt ? `Runs out ${relativeDay(runoutAt, now, tz)}` : "Running low"}
        </Badge>
      );
    case "critical":
      return <Badge variant="warn">Flagged low</Badge>;
    case "consumed":
      return <Badge variant="bad">We&apos;re out</Badge>;
    case "static_threshold":
      return <Badge variant="info">At reorder level</Badge>;
    case "audit_hint":
      return <Badge variant="info">Worth a check</Badge>;
    default:
      return added ? <Badge variant="secondary">Added</Badge> : null;
  }
}

export const onHandText = (onHand: number, unit: string) => `~${amount(onHand, unit)} left`;
