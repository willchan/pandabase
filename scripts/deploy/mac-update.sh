#!/usr/bin/env bash
# `make update`: pull-based Mac Mini deploy (PLAN M9, DESIGN §8 *Continuous deployment*). The
# launchd timer (ops/launchd/com.pandabase.update.plist) runs it every 15 min; running it by hand
# is the same thing.
#
#   1. lock (runs never overlap), honour `make update-pause`, skip inside the quiet windows
#   2. git fetch; target = newest first-parent commit on origin/main that is green — its worker
#      image ghcr.io/…/pandabase-worker:<sha> exists, which deploy.yml pushes only after CI passed
#      and the migration and web deploy succeeded — and that this Mac hasn't rolled back from
#   3. record the current sha and image tag → git merge --ff-only <target> → uv sync (tools;
#      skills load from the repo, so they update with the checkout) → PANDABASE_WORKER_TAG=<target>
#      in .env → docker compose pull && up -d
#   4. health check: worker running + a heartbeat from <target> + agent-token API round trip
#   5. failure → roll back to the recorded sha and tag, remember <target> as bad, post once to
#      #pandabase; `deploy` telemetry either way
#
#   mac-update.sh                  update (default)
#   mac-update.sh rollback [SHA]   roll back by hand to SHA (default: the sha before the last
#                                  update) and pause auto-update
#   mac-update.sh pause|resume|status
#
#   DRY_RUN=1   decide and print what would run; changes nothing (git fetch still runs)
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/../ops/lib.sh"
# shellcheck source=scripts/deploy/lib.sh
. "$(dirname "$0")/lib.sh"

cd "$ROOT"
cmd="${1:-update}"
HOUSEHOLD_TZ="${HOUSEHOLD_TZ:-$(env_get HOUSEHOLD_TZ)}"
HOUSEHOLD_TZ="${HOUSEHOLD_TZ:-America/Los_Angeles}"
export HOUSEHOLD_TZ
load_agent_env

stamp() { TZ="$HOUSEHOLD_TZ" fmt_epoch "$(now_epoch)" '%Y-%m-%d %H:%M:%S %Z'; }
log() { info "[$(stamp)] $*"; }

current_tag() {
  local tag
  tag="$(env_get PANDABASE_WORKER_TAG)"
  printf '%s\n' "${tag:-main}"
}

# Check out SHA, sync the tools, point compose at the worker image TAG and restart the worker.
# forward: fast-forward and pull the new image; back: reset to an older sha and reuse the image
# already on this Mac (pulling a moving tag like `main` would fetch the new image again).
switch_to() {
  local direction="$1" sha="$2" tag="$3"
  if [ "$direction" = forward ]; then
    run git merge --ff-only --quiet "$sha" || return 1
  else
    run git reset --keep --quiet "$sha" || return 1
  fi
  (cd agent/tools && run uv sync --locked --quiet) || return 1
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] .env: PANDABASE_WORKER_TAG=$tag"
  else
    env_set PANDABASE_WORKER_TAG "$tag" || return 1
  fi
  if [ "$direction" = forward ]; then
    run docker compose pull --quiet worker || return 1
  fi
  run docker compose up -d --remove-orphans || return 1
}

# The ISO-UTC lower bound for a fresh heartbeat: a minute before now (Docker Desktop's VM clock
# can lag the host slightly).
since_iso() {
  TZ=UTC fmt_epoch "$(($(now_epoch) - 60))" '%Y-%m-%dT%H:%M:%S.000Z'
}

# A tag that is a full sha identifies the build, so the heartbeat can be matched to it.
sha_of_tag() {
  if [[ "$1" =~ ^[0-9a-f]{40}$ ]]; then printf '%s\n' "$1"; fi
}

rollback_to() {
  local prev_sha="$1" prev_tag="$2" reason
  log "rolling back to ${prev_sha:0:7} (image tag ${prev_tag})"
  switch_to back "$prev_sha" "$prev_tag" || {
    warn "rollback to ${prev_sha:0:7} failed while switching"
    return 1
  }
  [ "$DRY_RUN" = 1 ] && return 0
  reason="$(health_check "$(sha_of_tag "$prev_tag")" "$(since_iso)")" || {
    warn "rollback health check failed too: $reason"
    return 1
  }
}

do_update() {
  if ! acquire_lock; then
    log "another update is running (pid $(cat "$STATE_DIR/update.lock/pid" 2>/dev/null || echo ?)); exiting"
    return 0
  fi
  trap release_lock EXIT

  if [ -f "$STATE_DIR/paused" ]; then
    log "auto-update paused ($(cat "$STATE_DIR/paused")); 'make update-resume' to resume"
    return 0
  fi
  local window
  if window="$(quiet_window "$(now_epoch)")"; then
    log "inside quiet window ($window, $HOUSEHOLD_TZ); not updating"
    return 0
  fi
  need git uv docker jq
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    die "tracked files have local changes — commit or stash them first (git status)"
  fi
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = main ] || die "checkout is on '$branch', not main — auto-update only follows main"

  git fetch --quiet origin main
  local prev_sha prev_tag target
  prev_sha="$(git rev-parse HEAD)"
  prev_tag="$(current_tag)"
  target="$(pick_target)"
  if [ -z "$target" ]; then
    if [ "$(git rev-parse origin/main)" = "$prev_sha" ]; then
      log "up to date at ${prev_sha:0:7}"
    else
      log "no green commit newer than ${prev_sha:0:7} yet"
    fi
    return 0
  fi

  log "updating ${prev_sha:0:7} → ${target:0:7} (image tag ${prev_tag} → ${target:0:7})"
  if [ "$DRY_RUN" != 1 ]; then
    printf 'previous_sha=%s\nprevious_tag=%s\ntarget=%s\nstarted=%s\n' \
      "$prev_sha" "$prev_tag" "$target" "$(stamp)" >"$STATE_DIR/last-deploy"
  fi
  local since reason
  since="$(since_iso)"
  local switched=1
  switch_to forward "$target" "$target" || switched=0
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] health check: worker running, heartbeat from ${target:0:7}, API round trip"
    emit_deploy mac_mini "$target" success "$prev_sha"
    return 0
  fi

  if [ "$switched" = 0 ]; then
    reason="switching to ${target:0:7} failed (git, uv sync or docker compose; see the log above)"
  elif reason="$(health_check "$target" "$since")"; then
    log "healthy at ${target:0:7}"
    printf 'outcome=success\n' >>"$STATE_DIR/last-deploy"
    emit_deploy mac_mini "$target" success "$prev_sha"
    return 0
  fi

  warn "update to ${target:0:7} failed: $reason"
  printf '%s\n' "$target" >>"$STATE_DIR/bad-shas"
  local outcome=rolled_back
  rollback_to "$prev_sha" "$prev_tag" || outcome=rollback_failed
  printf 'outcome=%s\nreason=%s\n' "$outcome" "$reason" >>"$STATE_DIR/last-deploy"
  if [ "$outcome" = rolled_back ]; then
    discord_post "⚠️ PandaBase Mac Mini update to \`${target:0:7}\` failed ($reason). Rolled back to \`${prev_sha:0:7}\`; that commit is skipped until a newer one lands."
  else
    discord_post "❌ PandaBase Mac Mini update to \`${target:0:7}\` failed ($reason) and the rollback to \`${prev_sha:0:7}\` failed its health check too — the worker may be down. Check \`make logs\` on the Mac Mini."
  fi
  emit_deploy mac_mini "$target" "$outcome" "$prev_sha" "$reason"
  return 1
}

do_rollback() {
  local to="${1:-}" tag
  acquire_lock || die "an update is running; try again in a minute"
  trap release_lock EXIT
  if [ -z "$to" ]; then
    [ -f "$STATE_DIR/last-deploy" ] || die "no previous update recorded — pass a sha: make rollback TO=<sha>"
    to="$(sed -n 's/^previous_sha=//p' "$STATE_DIR/last-deploy")"
    tag="$(sed -n 's/^previous_tag=//p' "$STATE_DIR/last-deploy")"
  fi
  to="$(git rev-parse --verify "$to^{commit}")"
  tag="${tag:-$to}"
  [ -n "$(git status --porcelain --untracked-files=no)" ] && die "tracked files have local changes"
  if [ "$DRY_RUN" != 1 ]; then
    printf 'manual rollback to %s at %s\n' "${to:0:7}" "$(stamp)" >"$STATE_DIR/paused"
  fi
  log "auto-update paused; rolling back to ${to:0:7} (image tag ${tag:0:12})"
  local from
  from="$(git rev-parse HEAD)"
  if rollback_to "$to" "$tag"; then
    emit_deploy mac_mini "$to" manual_rollback "$from"
    log "rolled back; 'make update-resume' re-enables auto-update"
  else
    emit_deploy mac_mini "$to" rollback_failed "$from" "manual rollback health check failed"
    return 1
  fi
}

case "$cmd" in
  update) do_update ;;
  rollback) do_rollback "${2:-}" ;;
  pause)
    mkdir -p "$STATE_DIR"
    printf 'paused by hand at %s\n' "$(stamp)" >"$STATE_DIR/paused"
    log "auto-update paused"
    ;;
  resume)
    rm -f "$STATE_DIR/paused"
    log "auto-update resumed"
    ;;
  status)
    info "checkout: $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)); worker tag: $(current_tag)"
    if [ -f "$STATE_DIR/paused" ]; then info "paused: $(cat "$STATE_DIR/paused")"; else info "auto-update: on"; fi
    if window="$(quiet_window "$(now_epoch)")"; then info "now inside quiet window: $window"; fi
    [ -f "$STATE_DIR/last-deploy" ] && { info "last update:"; sed 's/^/  /' "$STATE_DIR/last-deploy"; }
    [ -f "$STATE_DIR/bad-shas" ] && { info "rolled back from (skipped):"; sed 's/^/  /' "$STATE_DIR/bad-shas"; }
    true
    ;;
  *) die "usage: $0 [update|rollback [SHA]|pause|resume|status]" ;;
esac
