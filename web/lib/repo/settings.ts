// Effective config: code defaults ← `setting` rows ← `HOUSEHOLD_TZ` (when no row sets it).
import { setting } from "@pandabase/db";
import { DEFAULT_CONFIG, withSettings, type Config } from "../config";
import type { Q } from "./db";

export async function loadConfig(
  q: Q,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ config: Config; rejected: string[] }> {
  const rows = await q.select().from(setting);
  const settings: Record<string, unknown> = {};
  if (env.HOUSEHOLD_TZ) settings.householdTz = env.HOUSEHOLD_TZ;
  for (const r of rows) settings[r.key] = r.value;
  return withSettings(settings, DEFAULT_CONFIG);
}
