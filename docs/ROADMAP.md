# PandaBase — Roadmap

> Living document. Features agreed in design but deliberately deferred from the MVP. Designs here
> were discussed and accepted in principle; re-validate against current diagnostics before building.

## v1.1 — Video storage audits

**Goal:** a "lazy sweep" video of the fridge/freezer/pantry posted in Discord updates inventory,
with targeted follow-ups for what the model couldn't see.

- Job type `storage_audit` (already reserved in the schema).
- App attaches `expected_state_snapshot` (what inventory believes is in that location).
- Worker: FFmpeg scene-change keyframe extraction (dedupe, ~5–20 frames), saved to
  `keyframes/{job_id}/`; VLM per frame + merge; output observed items with confidence and optional bbox.
- Diff vs expected → follow-ups: expected-but-unseen, seen-low-confidence, items with `audit_hint`
  ("count eggs"). The agent replies in the upload's thread; replies (text/photo) continue the same
  audit. Unanswered follow-ups expire when the cycle closes.
- Typing "fridge audit" first makes the agent post the audit hints before recording.
- Raw video R2 lifecycle: 90 days. Keyframes forever.
- Video size: presigned direct-to-R2 upload; Discord attachment limits may require the agent to fetch
  from the CDN URL.

## v2 — Chores & maintenance

**Goal:** recurring household tasks (HVAC filter, garden fertilizer) with Discord prompts that don't
nag, and automatic inventory deduction for consumables used by the task.

Agreed design (from the design interview):

- **Schedules:** `rolling` (`interval_days` from last completion) and `seasonal` (rolling +
  `active_months`, dormant out of season, due on season start). No full RRULE until diagnostics show a need.
- **Assignee:** optional member, or "either of us".
- **Prompts:** daily 08:00 `chore-monitor` posts one message per *newly* due task (mentions assignee).
  Responses: ✅/"done", "done Tuesday" (backdate), ⏰/"snooze 3d", ⏭/"skip" (resets timer without
  a completion). Overdue tasks are **not** re-pinged daily; they appear once in a Sunday summary.
- **Completion:** `POST /api/tasks/complete {task_id, actor_discord_id, completed_at?}` → sets
  `last_completed_at`, recomputes `next_due_date`, writes `task_completion` (who/when/lateness),
  deducts consumables.
- **Consumables:** `task_consumption(task_id, item_id, quantity)` (many items per task) instead of a
  single `linked_item_id`. Deduction in base units; floor at 0 → `critical` → next grocery cycle.
- **Pre-emptive restock:** task due within 14 days and linked stock < needed → auto-add to the current
  grocery cycle with a note ("HVAC filter due Nov 2, you have 0").
- **Authoring:** web UI, or tell the agent ("add a chore: clean dryer vent every 6 months").
- **Routes:** `GET /api/tasks/due`, `POST /api/tasks/complete`, CRUD for tasks.
- **Tables:** `task`, `task_consumption`, `task_completion`.

## v2 — Standalone freezer monitor

- Per-category age thresholds (e.g. meat 90d, bread 30d) on `item` or `category`.
- Per-batch freezer lots (`inventory_lot`) instead of per-(item, location) `frozen_at`.
- Contextual suggestions ("chicken thighs frozen 4 months — use this week?"), possibly recipe ideas.
- v1 already: `frozen_at` tracking, "froze the chicken" moves, oldest items in the Friday nudge.

## v2 — Household supply locations

- Location-aware features for bathroom/utility/garage supplies (e.g. per-location audits, par levels).
- v1 already handles supplies bought on Amazon as ordinary items.

## Candidate improvements (pending diagnostics evidence)

Not committed; listed so a diagnostics review knows they were considered.

- Feed `estimate_vs_observed` / depletion observations into the EMA.
- Reference-image few-shot prompting (confirmed crops of "our" products) for the VLM.
- LoRA fine-tuning of the local VLM from `labeled_observation` exports (`make export-dataset`).
- Calendar/RRULE chore schedules.
- Real-time guided video capture.
