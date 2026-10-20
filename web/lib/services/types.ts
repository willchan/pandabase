import type { Actor } from "../auth/withAuth";
import type { Config } from "../config";

/** What every service call needs besides its input. `now` is fixed per request. */
export interface ServiceCtx {
  now: string;
  config: Config;
  actor: Actor;
}

/** Normalize a client timestamp (any offset) to the stored `toISOString()` form. */
export const isoUtc = (t: string): string => new Date(t).toISOString();
