"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "./submit-button";

/**
 * Two-step submit for the few actions that can't be undone (skip a week, merge two items): the
 * first tap asks, the second submits. Must sit inside a form.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  variant = "outline",
  size = "sm",
  className,
}: {
  children: React.ReactNode;
  confirmLabel: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => setAsking(true)}
      >
        {children}
      </Button>
    );
  return (
    <span className="inline-flex gap-2">
      <SubmitButton
        variant={variant === "outline" ? "default" : variant}
        size={size}
        className={className}
      >
        {confirmLabel}
      </SubmitButton>
      <Button type="button" variant="ghost" size={size} onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}
