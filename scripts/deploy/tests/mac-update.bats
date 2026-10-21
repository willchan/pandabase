#!/usr/bin/env bats
# scripts/deploy/mac-update.sh (`make update`, launchd every 15 min) with git, docker, uv, curl,
# sleep and pandabase-tools stubbed (tests/stubs): green-commit selection, no-op, quiet windows,
# health check → rollback, the lock, pause and DRY_RUN.

load helpers

setup() {
  setup_root
  A="$(sha 1)" B="$(sha 2)" C="$(sha 3)"
}

@test "no-op when already up to date" {
  history "$A"
  publish "$A"
  update
  [ "$status" -eq 0 ]
  [[ "$output" == *"up to date at ${A:0:7}"* ]]
  called "git fetch --quiet origin main"
  ! called "git merge"
  ! called "docker compose"
  [ ! -f "$STUB/telemetry" ]
}

@test "refuses a newer commit whose CI didn't pass (no published image)" {
  history "$A" "$B"
  update
  [ "$status" -eq 0 ]
  [[ "$output" == *"skip ${B:0:7}: no published image"* ]]
  [[ "$output" == *"no green commit newer than ${A:0:7} yet"* ]]
  [ "$(head_sha)" = "$A" ]
  called "docker manifest inspect ghcr.io/willchan/pandabase-worker:$B"
  ! called "git merge"
  ! called "docker compose pull"
}

@test "deploys the newest green commit when the newest one is red" {
  history "$A" "$B" "$C"
  publish "$B"
  update
  [ "$status" -eq 0 ]
  [ "$(head_sha)" = "$B" ]
  [ "$(tag)" = "$B" ]
}

@test "updates: fast-forward, uv sync, worker tag, compose pull + up, health check, telemetry" {
  history "$A" "$B"
  publish "$B"
  update
  [ "$status" -eq 0 ]
  [[ "$output" == *"updating ${A:0:7} → ${B:0:7}"* ]]
  [[ "$output" == *"healthy at ${B:0:7}"* ]]
  [ "$(head_sha)" = "$B" ]
  [ "$(tag)" = "$B" ]
  called "git merge --ff-only --quiet $B"
  called "uv sync --locked --quiet"
  called "docker compose pull --quiet worker"
  called "docker compose up -d --remove-orphans"
  called "tools api get /api/health/worker"
  called "tools api get /api/grocery/cycle/current"
  run jq -c '.events[0] | [.metric_type, .payload.component, .payload.sha, .payload.outcome, .payload.previous_sha]' "$STUB/telemetry"
  [ "$output" = "[\"deploy\",\"mac_mini\",\"$B\",\"success\",\"$A\"]" ]
  grep -qx "previous_sha=$A" "$ROOT_DIR/.deploy/last-deploy"
  grep -qx "outcome=success" "$ROOT_DIR/.deploy/last-deploy"
}

@test "rolls back on a failed health check, posts to Discord once, and skips that sha later" {
  history "$A" "$B"
  publish "$B"
  broken "$B"
  printf 'DEPLOY_DISCORD_WEBHOOK_URL=https://discord.test/api/webhooks/1/secret\n' >>"$ROOT_DIR/.env"
  update
  [ "$status" -eq 1 ]
  [[ "$output" == *"no worker heartbeat from ${B:0:7}"* ]]
  [ "$(head_sha)" = "$A" ]
  [ "$(tag)" = "main" ] # the tag compose ran before (unset → main), image reused, not pulled
  called "git reset --keep --quiet $A"
  [ "$(grep -c 'docker compose pull' "$STUB/calls")" -eq 1 ]
  grep -qx "$B" "$ROOT_DIR/.deploy/bad-shas"
  # Webhook URL only on stdin, never in curl's arguments.
  [ "$(grep -c '^curl' "$STUB/calls")" -eq 1 ]
  ! grep -q secret "$STUB/calls"
  grep -q 'url = "https://discord.test/api/webhooks/1/secret"' "$STUB/curl-stdin"
  run jq -r '.events[0].payload | [.outcome, .sha, .previous_sha] | join(" ")' "$STUB/telemetry"
  [ "$output" = "rolled_back $B $A" ]

  # Next tick: B is skipped, nothing changes, no second Discord post.
  update
  [ "$status" -eq 0 ]
  [[ "$output" == *"skip ${B:0:7}: rolled back before"* ]]
  [ "$(head_sha)" = "$A" ]
  [ "$(grep -c '^curl' "$STUB/calls")" -eq 1 ]

  # A newer green commit deploys normally.
  printf '%s\n' "$C" >>"$STUB/commits"
  publish "$C"
  update
  [ "$status" -eq 0 ]
  [ "$(head_sha)" = "$C" ]
}

@test "rolls back to the previous sha's image and checks its heartbeat" {
  history "$A" "$B" "$C"
  publish "$B" "$C"
  update # A → C, the newest green
  [ "$(head_sha)" = "$C" ]
  printf '%s\n' "$(sha 4)" >>"$STUB/commits"
  publish "$(sha 4)"
  broken "$(sha 4)"
  : >"$STUB/calls"
  update
  [ "$status" -eq 1 ]
  [ "$(head_sha)" = "$C" ]
  [ "$(tag)" = "$C" ]
  # Health was checked twice: the broken update, then the rollback (heartbeat from C).
  [ "$(grep -c 'tools api get /api/health/worker' "$STUB/calls")" -ge 2 ]
  run jq -r '.events[0].payload.outcome' <(tail -1 "$STUB/telemetry")
  [ "$output" = "rolled_back" ]
}

@test "a failed image pull rolls back without waiting for a heartbeat" {
  history "$A" "$B"
  publish "$B"
  touch "$STUB/pull-fails"
  update
  [ "$status" -eq 1 ]
  [[ "$output" == *"switching to ${B:0:7} failed"* ]]
  [ "$(head_sha)" = "$A" ]
  grep -qx "$B" "$ROOT_DIR/.deploy/bad-shas"
}

@test "reports rollback_failed when the rollback is unhealthy too" {
  history "$A" "$B"
  publish "$B"
  touch "$STUB/worker-down"
  update
  [ "$status" -eq 1 ]
  [[ "$output" == *"worker container not running"* ]]
  run jq -r '.events[0].payload.outcome' "$STUB/telemetry"
  [ "$output" = "rollback_failed" ]
  grep -qx "outcome=rollback_failed" "$ROOT_DIR/.deploy/last-deploy"
}

@test "does nothing inside a quiet window (Friday 18:00 household time)" {
  history "$A" "$B"
  publish "$B"
  PANDABASE_NOW="$(epoch 2026-10-31T01:00:00Z)" update
  [ "$status" -eq 0 ]
  [[ "$output" == *"inside quiet window (5 1730-1900, America/Los_Angeles)"* ]]
  ! called "git fetch"
  [ "$(head_sha)" = "$A" ]
}

@test "a running update's lock stops an overlapping run; a stale lock is taken over" {
  history "$A" "$B"
  publish "$B"
  mkdir -p "$ROOT_DIR/.deploy/update.lock"
  echo $$ >"$ROOT_DIR/.deploy/update.lock/pid" # this (live) bats process
  update
  [ "$status" -eq 0 ]
  [[ "$output" == *"another update is running (pid $$)"* ]]
  ! called "git fetch"
  [ -d "$ROOT_DIR/.deploy/update.lock" ]

  echo 999999 >"$ROOT_DIR/.deploy/update.lock/pid" # gone
  update
  [ "$status" -eq 0 ]
  [[ "$output" == *"removing stale update lock (pid 999999)"* ]]
  [ "$(head_sha)" = "$B" ]
  [ ! -d "$ROOT_DIR/.deploy/update.lock" ] # released on exit
}

@test "DRY_RUN=1 decides and prints, but changes nothing" {
  history "$A" "$B"
  publish "$B"
  DRY_RUN=1 update
  [ "$status" -eq 0 ]
  [[ "$output" == *"updating ${A:0:7} → ${B:0:7}"* ]]
  [[ "$output" == *"[dry-run] git merge --ff-only --quiet $B"* ]]
  [[ "$output" == *"[dry-run] .env: PANDABASE_WORKER_TAG=$B"* ]]
  [[ "$output" == *"[dry-run] docker compose pull --quiet worker"* ]]
  [[ "$output" == *"[dry-run] telemetry:"* ]]
  [ "$(head_sha)" = "$A" ]
  [ -z "$(tag)" ]
  ! called "git merge"
  ! called "docker compose"
  [ ! -f "$STUB/telemetry" ]
  [ ! -f "$ROOT_DIR/.deploy/last-deploy" ]
}

@test "pause / resume" {
  history "$A" "$B"
  publish "$B"
  update pause
  update
  [ "$status" -eq 0 ]
  [[ "$output" == *"auto-update paused"* ]]
  [ "$(head_sha)" = "$A" ]
  update resume
  update
  [ "$(head_sha)" = "$B" ]
}

@test "refuses to update a dirty checkout or a branch other than main" {
  history "$A" "$B"
  publish "$B"
  echo " M web/lib/config.ts" >"$STUB/dirty"
  update
  [ "$status" -eq 1 ]
  [[ "$output" == *"tracked files have local changes"* ]]
  rm "$STUB/dirty"
  echo feature >"$STUB/branch"
  update
  [ "$status" -eq 1 ]
  [[ "$output" == *"not main"* ]]
  [ "$(head_sha)" = "$A" ]
}

@test "manual rollback returns to the previous sha and pauses auto-update" {
  history "$A" "$B" "$C"
  publish "$B" "$C"
  update
  [ "$(head_sha)" = "$C" ]
  update rollback
  [ "$status" -eq 0 ]
  [ "$(head_sha)" = "$A" ]
  [ "$(tag)" = "main" ]
  [ -f "$ROOT_DIR/.deploy/paused" ]
  update rollback "$B"
  [ "$status" -eq 0 ]
  [ "$(head_sha)" = "$B" ]
  [ "$(tag)" = "$B" ]
  update status
  [[ "$output" == *"paused: manual rollback to ${B:0:7}"* ]]
}
