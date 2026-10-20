#!/usr/bin/env bash
# `make update`: the manual Mac Mini update (PLAN M8). M9's launchd timer wraps this procedure
# with green-CI and quiet-window checks, a health check and rollback.
#
#   1. git pull --ff-only on the current branch (refuses local edits to tracked files)
#   2. uv sync the agent tools (skills load straight from the repo, so they update with the pull)
#   3. docker compose up -d --build (the worker; it finishes its current job before restarting)
#
# Prints the sha before and after so a manual rollback is `git checkout <before>` + `make up`.
#   DRY_RUN=1   print the commands instead of running them
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need git uv docker
cd "$ROOT"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "tracked files have local changes — commit or stash them first (git status)"
fi
before="$(git rev-parse --short HEAD)"
info "current: $before ($(git rev-parse --abbrev-ref HEAD))"

run git pull --ff-only
after="$(git rev-parse --short HEAD)"
if [ "$before" = "$after" ] && [ "$DRY_RUN" != 1 ]; then
  note "already up to date"
else
  info "updated: $before → $after"
fi

(cd agent/tools && run uv sync --locked)
run docker compose up -d --build --remove-orphans
run docker compose ps

if [ "$before" != "$after" ]; then
  info "Skills changed? Start a new OpenClaw session to pick them up (openclaw skills check)."
  info "Rollback: git checkout $before && make up"
fi
