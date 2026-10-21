---
name: steward
description: How to drive a PandaBase pull request to green and mergeable — merge-conflict first, then CI, then review. Read before acting on any CI, review or merge-state event for a PR you opened or were asked to drive in this repo.
---

# Stewarding a PandaBase PR

Several Claude sessions often have PRs open at once (parallel milestones, follow-up fixes), and
they edit shared files: `docs/PLAN.md`, `docs/DESIGN.md`, `CLAUDE.md`, generated contracts and
migrations. So **merge conflicts are the most common reason a PR stalls here.**

## Why waiting doesn't work

GitHub runs `pull_request` workflows on a test merge commit. When the PR conflicts with `main`,
that commit can't be built, **so PR CI never starts and no CI event arrives.** You may not be woken
about the conflict either. CI also runs on pushes to `claude/**` branches (checks on your head
commit), but those runs don't tell you whether the PR merges cleanly. Only checking does.

## On every wake, and a few minutes after each of your pushes

1. **Mergeability first.** Read the PR's mergeable state (it may say `unknown` for a moment; re-read).
   If it conflicts — or `main` has moved and touches files you changed — do the merge below *now*,
   before looking at CI or reviews. Never end a wake waiting on CI while the PR conflicts.
2. Then CI on the latest head commit, then review threads (the harness rules apply).

## Resolving conflicts

- `git fetch origin main && git merge origin/main` into your branch. **No rebase, no force-push.**
- **Regenerate, don't hand-merge** generated files:
  - contracts: `pnpm contracts:gen` (never edit `contracts/openapi.json` or `*/contracts.py`)
  - migrations: if both sides added a migration, keep `main`'s, delete yours, re-run
    `pnpm db:generate` from your schema, and re-check `pnpm drizzle-kit check`
  - lockfiles: take `main`'s, then `pnpm install` / `uv lock` to re-add your changes
- **Docs:**
  - `docs/PLAN.md` status table: keep every row from both sides; only your milestone's row is yours
    to change.
  - `docs/DESIGN.md` §10 *Key decisions*: `main`'s numbers win; renumber yours after them and fix any
    references (`§10 #N`) in your own text.
  - `CLAUDE.md` Commands: keep both sides' lines.
- Validate before pushing: `make check` (or at least everything your change touches), then push.
- If both sides changed the same *logic* and either choice loses behavior, stop and ask.

## Before you push anything

Run the fast checks the change touches (`pnpm lint && pnpm typecheck && pnpm test`, the Python
checks, `make contracts-check`, `make db-check`, `make ops-check`), or `make check` for anything
broad. One green push beats three speculative ones.
