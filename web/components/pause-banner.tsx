// This Week: shown while a cart pause covers today or this week's build (PRD §4.1 paused weeks).
import { PauseIcon } from "lucide-react";
import { endPauseAction } from "@/app/(app)/settings/actions";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { dateOnly } from "@/lib/format";

export function PauseBanner({
  pause,
  today,
}: {
  pause: { id: string; startsOn: string; endsOn: string; note: string | null };
  today: string;
}) {
  const started = pause.startsOn <= today;
  return (
    <Alert className="mb-3">
      <PauseIcon aria-hidden="true" />
      <AlertTitle>
        {started
          ? `Carts paused until ${dateOnly(pause.endsOn)}`
          : `Carts pause ${dateOnly(pause.startsOn)} – ${dateOnly(pause.endsOn)}`}
      </AlertTitle>
      <AlertDescription>
        <p>
          No weekly cart{pause.note ? ` (${pause.note})` : ""}. Purchases still count toward
          what&apos;s on hand, but usage rates won&apos;t learn from them.
        </p>
        <ActionForm action={endPauseAction} className="mt-2">
          <input type="hidden" name="id" value={pause.id} />
          <SubmitButton variant="secondary" size="sm">
            {started ? "Resume carts" : "Cancel pause"}
          </SubmitButton>
        </ActionForm>
      </AlertDescription>
    </Alert>
  );
}
