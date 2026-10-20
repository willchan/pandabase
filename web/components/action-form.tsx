"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/actions";
import { cn } from "@/lib/utils";

type Action = (prev: ActionResult, form: FormData) => Promise<ActionResult>;

/**
 * A `<form>` bound to a server action via `useActionState`; shows the action's error (or success
 * message) inline, politely announced to screen readers.
 */
export function ActionForm({
  action,
  children,
  className,
  successClassName,
  ...props
}: Omit<React.ComponentProps<"form">, "action"> & { action: Action; successClassName?: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className} {...props}>
      {children}
      <p
        aria-live="polite"
        className={cn(
          "text-sm empty:hidden",
          state?.ok === false ? "text-destructive" : "text-muted-foreground",
          state?.ok ? successClassName : null,
        )}
      >
        {state?.ok === false ? state.error : state?.ok ? (state.message ?? "") : ""}
      </p>
    </form>
  );
}
