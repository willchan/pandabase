# CLAUDE.md

PandaBase is a household operating system for groceries: a Next.js + Turso **State Engine** on
Vercel, a Python **worker** and an existing **OpenClaw agent** on a Mac Mini, talking through an
authenticated HTTP API.

## Start here

| Doc | Read when |
|---|---|
| [docs/PRD.md](docs/PRD.md) | You need to know *what* the product does and *why* |
| [docs/DESIGN.md](docs/DESIGN.md) | You're changing architecture, schema, API, algorithms, or agent behavior |
| [docs/PLAN.md](docs/PLAN.md) | You're executing a build milestone — follow its *Session protocol* (finished ones: `docs/PLAN-done.md`) |
| [docs/TESTING.md](docs/TESTING.md) | You're testing across components (system test, agent eval) or touching auth/security |
| [docs/ROADMAP.md](docs/ROADMAP.md) | You're tempted to build chores, video audits, or freezer features — they're deferred |

Read only the sections your task needs. DESIGN.md is very long (40k+ tokens): find yours with
`grep -n '^#' docs/DESIGN.md` and read only that range, never the whole file. The same goes
for `docs/PLAN-done.md` (finished milestones).

## Sessions

- **One task per session.** A session does one task and its PR. When that PR merges, stop: new
  work starts in a fresh session, not on top of this one's context.
- **Plan first for multi-file changes.** In plan mode, write a plan that names the files, doc
  sections and commands, so building it doesn't need to explore again.
- **Keep output short.** Show failures or `| tail -40` of long command output, not the whole log.
- **Hand off instead of growing.** Every turn resends the whole context, so a session at 300k+
  tokens costs several times a fresh one per reply. Past ~200k tokens, or when new work is asked
  after this session's PR merged, write a short handoff prompt (goal, files, doc sections, state)
  for a fresh session instead of continuing here. Multi-milestone work follows
  `docs/PLAN.md` › *Orchestrator protocol*.

## Rules

- **Driving a PR?** Follow `.claude/skills/steward/SKILL.md`: check mergeability before CI on every
  wake and after each push — GitHub runs no PR CI while a PR conflicts with `main`. After opening a
  PR, turn on its Auto-fix (the app's PR monitor) so CI failures and conflicts wake you.
- **Merge when green.** Will doesn't review PRs here. Once a PR you opened (or were asked to drive)
  is mergeable, every required check on its head commit has passed, and no review thread is
  unresolved, merge it yourself (squash) without asking. Don't merge on red, pending or
  conflicting; anything that needs `sudo` or touches production still needs asking first.
- **Done means seen working.** Before finishing a UI, data, importer or prediction change, follow
  `.claude/skills/verify/SKILL.md` (seeded shots, the read-only prod copy, real page shapes).
- **The docs are living.** Any PR that changes user-visible behavior updates `docs/PRD.md`; any PR
  that changes architecture, schema, API contracts, algorithms or agent behavior updates
  `docs/DESIGN.md` (including §10 *Key decisions* when a decision changes). Deviations from a
  milestone go in that milestone's **Notes** in `docs/PLAN.md` (or `docs/PLAN-done.md` once it is finished).
- **The State Engine owns business logic and the database.** The worker and agent tools never touch
  the DB; they call the API. Domain rules live in `web/lib/domain/` as pure, tested functions.
- **Contracts are generated.** Zod in `web/lib/contracts/` → `contracts/openapi.json` → Python
  models. Never hand-edit generated files; run `pnpm contracts:gen`.
- **Tunables live in `web/lib/config.ts`.** No magic numbers in domain code.
- **Migrations are backward-compatible (expand → contract).** `main` deploys automatically and
  migrations run *before* the new code ships, so the previous release must keep working against the
  new schema. Add columns/tables freely; drop or rename only in a later PR, after no deployed code
  uses them.
- **Nothing blocks on a human.** New review flows need a default outcome and an expiry.
  Only human-confirmed data becomes `labeled_observation`s.
- **Cart only, never checkout.** No code path may navigate to or submit checkout.
- **No cloud vision/LLM calls from the worker.** Local Ollama only.
- **Diagnostics:** any new learning component or heuristic emits telemetry and gets a section (or
  rows) in the weekly diagnostics report.
- **Privacy:** never commit `/diagnostics`, `.env*`, real receipts, or real order HTML. Test fixtures
  must be synthetic or scrubbed.
- **Bug fixes start with a regression test.** Write a test that reproduces the bug and fails before
  the fix, then make it pass. Name or comment it so the bug is recognisable (what input, what was
  wrong).
- **Prompts are versioned files** in `worker/prompts/`; changing a prompt means a new version file,
  and jobs record `prompt_version`.

## Commands

> Node 24 (`.nvmrc`), pnpm 12, Python 3.14 + uv. The full list (db and import tools, prod copy,
> system tests, deploy, Mac Mini ops) is in [docs/COMMANDS.md](docs/COMMANDS.md): grep it before
> guessing a command, and keep it accurate as milestones land.

```
pnpm install                 # JS deps (web, db)
pnpm lint && pnpm typecheck && pnpm test   # ESLint + Prettier check, tsc, vitest
pnpm format                  # Prettier --write
pnpm --filter web build      # next build
(cd worker && uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest)
(cd agent/tools && uv run ruff check && uv run ruff format --check && uv run mypy . && uv run pytest)
pnpm --filter web test -- lib/domain   # domain tests + coverage (≥ 95% lines on lib/domain enforced)
pnpm db:generate             # after editing db/src/schema/*: new migration in db/migrations (commit it)
pnpm contracts:gen           # Zod → contracts/openapi.json → worker/agent Pydantic models (commit them)
pnpm --filter web dev:seeded   # next dev on a throwaway seeded db (dev sign-in as alex@example.com)
pnpm --filter web shot / /pantry   # phone screenshots, light + dark → web/.shots
make prod-copy               # prod → .scratch/prod-copy.db, READ-ONLY token, counts only (docs/TESTING.md)
make check                   # everything CI runs
make ops-check               # shellcheck, actionlint, deploy tests, migration check, PLAN-done check
```

## Working on the live Mac Mini

Lessons from live runs (November 2026). Ask before anything that changes production or loads store
pages.

- **Two accounts.** Claude sessions run as the admin user; PandaBase, OpenClaw and its tokens
  belong to the agent account. Run there with `ssh agent '<cmd>'` from `~/Code/pandabase`, and keep
  configs and tokens in that account's home, never the admin's. That ssh shell doesn't read the
  login profile, so `openclaw` isn't on its PATH: `ssh agent 'zsh -lc "openclaw …"'`, or start the
  command with `export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH";`. With several agents on
  the gateway, pass `--agent pandabase` (e.g. `openclaw sessions list`, `skills check`).
- **After a PR merges,** the 15-minute updater pulls it and re-runs the agent installers when the
  diff needs it; a failure posts to #pandabase. `make mac-rollout` there does it by hand.
- **Live data, read-only:** `scripts/ops/agent-run.sh api get /api/predictions` (also
  `/api/items/lookup`, `/api/diagnostics/weekly?week=YYYY-Www`); for anything broader,
  `make prod-copy`.
- **"ok" isn't proof.** An automation can finish "ok" without doing its work (the local model once
  posted a made-up cart). Check the run (`openclaw automations runs <id> --json`) and the output it
  should have produced.
- **The household's store carts hold their own items.** Never remove or change a line you didn't
  add, and ask before any run that loads Amazon or Whole Foods pages: repeated automated loads drew
  a `/checkpoint`.

## Diagnostics review

Asked to "review diagnostics"? Follow `.claude/skills/review-diagnostics/SKILL.md`.
