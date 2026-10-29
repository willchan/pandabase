#!/usr/bin/env bash
# Helpers for the Mac Mini updater (scripts/deploy/mac-update.sh, DESIGN §8 *Continuous
# deployment*). Pure where possible so scripts/deploy/tests can exercise them with stubs.
# Source it after scripts/ops/lib.sh; don't run it.
# shellcheck disable=SC2034  # variables are used by the scripts that source this file

GHCR_IMAGE="${PANDABASE_WORKER_IMAGE_REPO:-ghcr.io/willchan/pandabase-worker}"
STATE_DIR="${PANDABASE_DEPLOY_STATE:-$ROOT/.deploy}"
# "<ISO weekday 1–7> <HHMM>-<HHMM>" in HOUSEHOLD_TZ, ';'-separated (Fri nudge, Sat cart build).
QUIET_WINDOWS="${UPDATE_QUIET_WINDOWS:-5 1730-1900;6 0930-1200}"
# How many first-parent commits ahead of HEAD to consider when the newest isn't green yet.
MAX_CANDIDATES="${UPDATE_MAX_CANDIDATES:-20}"

# Seconds since the epoch; PANDABASE_NOW overrides it (tests).
now_epoch() {
  if [ -n "${PANDABASE_NOW:-}" ]; then printf '%s\n' "$PANDABASE_NOW"; else date +%s; fi
}

# Format an epoch with strftime FORMAT in the caller's TZ (GNU `date -d @`, BSD/macOS `date -r`).
fmt_epoch() {
  date -d "@$1" "+$2" 2>/dev/null || date -r "$1" "+$2"
}

# The quiet window containing EPOCH in household time (prints it), or status 1 when outside all.
# Local wall-clock time, so DST shifts move the windows with the household, not with UTC.
quiet_window() {
  local epoch="$1" tz="${HOUSEHOLD_TZ:-America/Los_Angeles}" dow hhmm w wdow range start end
  read -r dow hhmm <<<"$(TZ="$tz" fmt_epoch "$epoch" '%u %H%M')"
  local IFS=';'
  for w in $QUIET_WINDOWS; do
    IFS=' ' read -r wdow range <<<"$w"
    start="${range%-*}" end="${range#*-}"
    if [ "$dow" = "$wdow" ] && [ $((10#$hhmm)) -ge $((10#$start)) ] && [ $((10#$hhmm)) -lt $((10#$end)) ]; then
      printf '%s\n' "$w"
      return 0
    fi
  done
  return 1
}

# True when the worker image for SHA exists in GHCR. deploy.yml pushes `:<sha>` only after CI
# passed on main and the migration and web deploy succeeded, so this is the "green" signal. The
# image is public (no login); a private one needs `docker login ghcr.io` with a read:packages token.
image_published() {
  docker manifest inspect "$GHCR_IMAGE:$1" >/dev/null 2>&1
}

# Shas this Mac rolled back from; never retried (a newer commit replaces them).
is_bad_sha() {
  [ -f "$STATE_DIR/bad-shas" ] && grep -qx "$1" "$STATE_DIR/bad-shas"
}

# The newest first-parent commit between HEAD and origin/main that is green and not known bad,
# or nothing. Older green commits still deploy while the newest one is red or still building.
pick_target() {
  local sha
  while read -r sha; do
    [ -n "$sha" ] || continue
    if is_bad_sha "$sha"; then
      note "skip ${sha:0:7}: rolled back before" >&2
    elif image_published "$sha"; then
      printf '%s\n' "$sha"
      return 0
    else
      note "skip ${sha:0:7}: no published image (CI red or deploy still running)" >&2
    fi
  done < <(git rev-list --first-parent --max-count="$MAX_CANDIDATES" HEAD..origin/main)
  return 0
}

# Lock with mkdir (atomic; macOS has no flock). A lock whose pid is gone is stale and taken over.
acquire_lock() {
  local lock="$STATE_DIR/update.lock" pid
  mkdir -p "$STATE_DIR"
  if ! mkdir "$lock" 2>/dev/null; then
    pid="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    warn "removing stale update lock (pid ${pid:-?})"
    rm -rf "$lock"
    mkdir "$lock" || return 1
  fi
  printf '%s\n' "$$" >"$lock/pid"
  LOCK_HELD=1
}

release_lock() {
  if [ "${LOCK_HELD:-0}" = 1 ]; then
    rm -rf "$STATE_DIR/update.lock"
    LOCK_HELD=0
  fi
}

# POST one `deploy` telemetry event (DESIGN §7) with the agent token. Never fails the caller.
emit_deploy() {
  local component="$1" sha="$2" outcome="$3" previous="${4:-}" reason="${5:-}" body
  body="$(jq -cn --arg c "$component" --arg s "$sha" --arg o "$outcome" --arg p "$previous" \
    --arg r "$reason" --arg h "$(hostname -s 2>/dev/null || hostname)" \
    '{events: [{metric_type: "deploy", payload: ({component: $c, sha: $s, outcome: $o, host: $h}
      + (if $p == "" then {} else {previous_sha: $p} end)
      + (if $r == "" then {} else {reason: $r} end))}]}')"
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] telemetry: $body"
    return 0
  fi
  tools api post /api/telemetry --json "$body" >/dev/null 2>&1 ||
    warn "couldn't send deploy telemetry ($component $outcome)"
}

# Post MESSAGE to #pandabase through DEPLOY_DISCORD_WEBHOOK_URL (.env). The URL is a secret: it
# goes to curl on stdin (-K -), never on the command line.
discord_post() {
  local message="$1" url
  url="${DEPLOY_DISCORD_WEBHOOK_URL:-$(env_get DEPLOY_DISCORD_WEBHOOK_URL)}"
  if [ -z "$url" ]; then
    warn "DEPLOY_DISCORD_WEBHOOK_URL unset — not posted to Discord: $message"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] discord: $message"
    return 0
  fi
  printf 'url = "%s"\n' "$url" |
    curl -fsS --max-time 15 -K - -H 'Content-Type: application/json' \
      --data-binary "$(jq -cn --arg m "$message" '{content: $m, allowed_mentions: {parse: []}}')" \
      >/dev/null 2>&1 || warn "Discord webhook post failed: $message"
}

# Health check after `up -d`: the worker container is running, it sent a heartbeat from SHA at
# or after SINCE (ISO UTC; skipped when SHA is empty, e.g. a local or `main` tag), and the agent
# token round-trips through the API. Retries every HEALTH_INTERVAL s for HEALTH_TIMEOUT s.
# Prints the last failure reason on stdout.
health_check() {
  local sha="$1" since="$2" timeout="${HEALTH_TIMEOUT:-120}" interval="${HEALTH_INTERVAL:-10}"
  local tries reason out at beat_sha
  [ "$interval" -ge 1 ] || interval=1
  tries=$((timeout / interval + 1))
  while :; do
    reason=""
    if ! docker compose ps --status running --services 2>/dev/null | grep -qx worker; then
      reason="worker container not running"
    elif [ -n "$sha" ]; then
      if ! out="$(tools api get /api/health/worker 2>&1)"; then
        reason="GET /api/health/worker failed: $(printf '%s' "$out" | tail -1 | cut -c1-200)"
      else
        beat_sha="$(printf '%s' "$out" | jq -r '.heartbeat.sha // ""')"
        at="$(printf '%s' "$out" | jq -r '.heartbeat.at // ""')"
        if [ "$beat_sha" != "$sha" ] || [[ "$at" < "$since" ]]; then
          reason="no worker heartbeat from ${sha:0:7} within ${timeout}s (last: ${beat_sha:0:7} at ${at:-never})"
        fi
      fi
    fi
    if [ -z "$reason" ] && ! out="$(tools api get /api/grocery/cycle/current 2>&1)"; then
      reason="agent-token API round trip failed: $(printf '%s' "$out" | tail -1 | cut -c1-200)"
    fi
    if [ -z "$reason" ]; then
      return 0
    fi
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      printf '%s\n' "$reason"
      return 1
    fi
    sleep "$interval"
  done
}
