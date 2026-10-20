// Server-action plumbing: resolve the member, run a service, turn domain errors into a message the
// form can show, refresh the page, and log `ui_action` telemetry (source `session`, DESIGN §7).
import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { currentMember, type Current } from "./auth/current";
import { ApiError } from "./http";
import { emitTelemetry } from "./telemetry";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string } | null;

export async function runAction(
  action: string,
  fn: (c: Current) => Promise<string | void>,
): Promise<ActionResult> {
  const c = await currentMember();
  const started = performance.now();
  let result: ActionResult;
  try {
    const message = await fn(c);
    result = message ? { ok: true, message } : { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (!(err instanceof ApiError)) console.error(err);
    result = {
      ok: false,
      error: err instanceof ApiError ? err.message : "Something went wrong — try again.",
    };
  }
  await emitTelemetry(
    c.db,
    "session",
    [
      {
        metric: "ui_action",
        action,
        ok: result.ok,
        latencyMs: Math.round(performance.now() - started),
        ...(result.ok ? {} : { error: result.error }),
      },
    ],
    c.ctx.now,
  ).catch(() => {});
  if (result.ok) refresh();
  return result;
}

/** FormData helpers. */
export const str = (f: FormData, k: string): string | null => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
export const num = (f: FormData, k: string): number | null => {
  const v = str(f, k);
  return v === null ? null : Number(v);
};
