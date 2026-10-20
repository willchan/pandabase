#!/usr/bin/env bash
# `make smoke`: live checks of the Mac Mini setup against production (PLAN M5–M8). Each check
# prints ✓ / ✗ / – (skipped) with a reason; the run exits 1 if any check failed. Safe to re-run:
# nothing here changes household data unless you opt in, and the cart check removes what it adds.
#
#   SMOKE_ONLY="api ollama"   run only these checks (names below)
#   SMOKE_CART=1 SMOKE_AMAZON_ASIN=… SMOKE_WF_ASIN=…
#                             add one Amazon + one Whole Foods item to the cart member's cart
#                             with the real tier-1 code, then delete them again
#   SMOKE_E2E=1               upload a blank synthetic photo as a Trash Cam job and wait for the
#                             worker to finish it (leaves one Trash Cam review in Cleanup —
#                             dismiss it, or it expires on its own)
#
# Checks: env api worker ollama ollama-host vlm replies cdp cart e2e worker-stop
set -uo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/../ops/lib.sh"

load_agent_env
HOST_OLLAMA_URL="${HOST_OLLAMA_URL:-$(env_get HOST_OLLAMA_URL)}"
HOST_OLLAMA_URL="${HOST_OLLAMA_URL:-http://127.0.0.1:11434}"
VLM_MODEL="$(env_get OLLAMA_VLM_MODEL)"
VLM_MODEL="${VLM_MODEL:-qwen3.5:9b}"
TEXT_MODEL="$(env_get OLLAMA_TEXT_MODEL)"
TEXT_MODEL="${TEXT_MODEL:-qwen3.5:4b}"
TOOLS_PY="$ROOT/agent/tools/.venv/bin/python"
passed=0 failed=0 skipped=0

pass() {
  printf '%s✓ %s%s — %s\n' "$C_OK" "$1" "$C_OFF" "$2"
  passed=$((passed + 1))
}
fail() {
  printf '%s✗ %s%s — %s\n' "$C_BAD" "$1" "$C_OFF" "$2"
  failed=$((failed + 1))
}
skip() {
  printf '%s– %s — skipped: %s%s\n' "$C_DIM" "$1" "$2" "$C_OFF"
  skipped=$((skipped + 1))
}
wanted() { [ -z "${SMOKE_ONLY:-}" ] || [[ " $SMOKE_ONLY " == *" $1 "* ]]; }

# One line from a failed command's output: its JSON `error`, else the last line naming an error.
brief() {
  local line
  line="$(printf '%s' "$1" | jq -r 'if type == "object" then (.error | if type == "string" then . else tojson end) // empty else empty end' 2>/dev/null)"
  [ -n "$line" ] || line="$(printf '%s\n' "$1" | grep -E '[A-Za-z]*(Error|error)' | tail -1)"
  [ -n "$line" ] || line="$(printf '%s\n' "$1" | tail -1)"
  printf '%s' "$line" | cut -c1-240
}

# --- checks -------------------------------------------------------------------------------------

check_env() {
  local missing=() key
  [ -f "$ENV_FILE" ] || {
    fail env "no .env — run 'make secrets'"
    return
  }
  for key in AGENT_API_TOKEN WORKER_API_TOKEN PANDABASE_API_URL PANDABASE_CONFIG; do
    [ -n "$(env_get "$key")" ] || missing+=("$key")
  done
  [ -f "$PANDABASE_CONFIG" ] || missing+=("$PANDABASE_CONFIG (file)")
  [ -f "$(dirname "$PANDABASE_CONFIG")/profiles.json" ] || missing+=("agent/profiles.json (file)")
  [ -x "$TOOLS_BIN" ] || missing+=("agent tools (make install-agent-tools)")
  if [ "${#missing[@]}" -eq 0 ]; then
    pass env ".env, agent config and tools present"
  else
    fail env "missing: ${missing[*]}"
  fi
}

check_api() {
  local out
  if out="$(tools api get /api/grocery/cycle/current 2>&1)"; then
    pass api "agent token round trip to $PANDABASE_API_URL (cycle: $(printf '%s' "$out" | jq -r '.cycle.status // "none"'))"
  else
    fail api "GET /api/grocery/cycle/current: $(brief "$out")"
  fi
}

check_worker() {
  if docker compose -f "$ROOT/docker-compose.yml" ps --status running --services 2>/dev/null | grep -qx worker; then
    pass worker "container running ($(docker compose -f "$ROOT/docker-compose.yml" ps --format '{{.Image}}' worker 2>/dev/null))"
  else
    fail worker "not running — make up; then make logs"
  fi
}

check_ollama() {
  local tags missing=() m
  if ! tags="$(curl -fsS --max-time 5 "$HOST_OLLAMA_URL/api/tags" 2>&1)"; then
    fail ollama "$HOST_OLLAMA_URL unreachable — is Ollama running? ($tags)"
    return
  fi
  for m in "$VLM_MODEL" "$TEXT_MODEL"; do
    printf '%s' "$tags" | jq -e --arg m "$m" '[.models[] | .name, .model] | index($m) != null' >/dev/null ||
      missing+=("$m")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    pass ollama "$VLM_MODEL and $TEXT_MODEL pulled"
  else
    fail ollama "not pulled: ${missing[*]} — ollama pull ${missing[*]}"
  fi
}

check_ollama_host() {
  command -v launchctl >/dev/null || {
    skip ollama-host "not macOS"
    return
  }
  local par loaded
  par="$(launchctl getenv OLLAMA_NUM_PARALLEL)"
  loaded="$(launchctl getenv OLLAMA_MAX_LOADED_MODELS)"
  if [ "$par" = 1 ] && [ "$loaded" = 1 ]; then
    pass ollama-host "OLLAMA_NUM_PARALLEL=1, OLLAMA_MAX_LOADED_MODELS=1"
  else
    fail ollama-host "OLLAMA_NUM_PARALLEL='$par' OLLAMA_MAX_LOADED_MODELS='$loaded' (want 1 and 1; README step 8)"
  fi
}

check_vlm() {
  local out
  out="$(docker compose -f "$ROOT/docker-compose.yml" run --rm --no-deps -T \
    -v "$ROOT/scripts/smoke:/smoke:ro" worker python /smoke/vlm_check.py 2>&1 | tail -1)"
  if printf '%s' "$out" | jq -e '.ok == true' >/dev/null 2>&1; then
    pass vlm "$(printf '%s' "$out" | jq -r '"\(.model) read \(.lines) lines in \(.seconds)s (\(.prompt_version))"')"
  else
    fail vlm "${out:-no output} (a cold model load can exceed the limit: re-run once warm)"
  fi
}

check_replies() {
  local pending out
  if ! pending="$(tools api get /api/jobs/notifications 2>/dev/null | jq '.notifications | length')"; then
    fail replies "GET /api/jobs/notifications failed"
    return
  fi
  if [ "$pending" != 0 ]; then
    skip replies "$pending job replies pending — not consuming them (the automation posts them)"
    return
  fi
  out="$(tools jobs replies 2>&1)"
  if [ "$out" = NO_REPLY ]; then pass replies "jobs replies → NO_REPLY"; else fail replies "$out"; fi
}

check_cdp() {
  local name profile port out listen
  while IFS=$'\t' read -r name profile _sweep _cart; do
    port="$(jq -r --arg p "$profile" '.profiles[$p].cdp_url // ""' "$(dirname "$PANDABASE_CONFIG")/profiles.json")"
    port="${port##*:}"
    port="${port%/}"
    if command -v lsof >/dev/null; then
      listen="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {print $9}' | sort -u | tr '\n' ' ')"
      if [ -n "$listen" ] && printf '%s' "$listen" | grep -qvE '^((127\.0\.0\.1|\[::1\]):[0-9]+ ?)+$'; then
        fail "cdp-$name" "port $port listens beyond loopback ($listen) — check the LaunchAgent flags"
        continue
      fi
    fi
    if out="$(tools cdp check --member "$name" 2>&1)"; then
      pass "cdp-$name" "attached on port $port ($(printf '%s' "$out" | jq -r '.url'))"
    else
      fail "cdp-$name" "$(brief "$out") — is its Chromium running and signed in? (make install-chromium)"
    fi
  done < <(members)
}

check_cart() {
  if [ "${SMOKE_CART:-0}" != 1 ]; then
    skip cart "set SMOKE_CART=1 SMOKE_AMAZON_ASIN=… SMOKE_WF_ASIN=… (adds then deletes 2 items)"
    return
  fi
  local args=() out
  [ -n "${SMOKE_AMAZON_ASIN:-}" ] && args+=("amazon=$SMOKE_AMAZON_ASIN")
  [ -n "${SMOKE_WF_ASIN:-}" ] && args+=("wholefoods=$SMOKE_WF_ASIN")
  [ "${#args[@]}" -gt 0 ] || {
    fail cart "set SMOKE_AMAZON_ASIN and/or SMOKE_WF_ASIN"
    return
  }
  out="$("$TOOLS_PY" "$ROOT/scripts/smoke/cart_check.py" "${args[@]}" 2>&1 | tail -1)"
  if printf '%s' "$out" | jq -e '.ok == true' >/dev/null 2>&1; then
    pass cart "$(printf '%s' "$out" | jq -r '[.results[] | "\(.vendor) \(.asin): \(.outcome)\(if .reason then " (\(.reason))" else "" end), removed"] | join("; ")')"
  else
    fail cart "$out"
  fi
  printf '%s' "$out" | jq -r '.wholefoods // empty' 2>/dev/null | while read -r hint; do note "  $hint"; done
}

check_e2e() {
  if [ "${SMOKE_E2E:-0}" != 1 ]; then
    skip e2e "set SMOKE_E2E=1 (one synthetic Trash Cam job through R2 → worker → Ollama)"
    return
  fi
  local tmp actor channel msg submit job_id deadline status note
  tmp="$(mktemp -d)"
  # A blank 64×64 PNG, written with the standard library.
  "$TOOLS_PY" - "$tmp/smoke.png" <<'PY'
import struct, sys, zlib
w = h = 64
raw = b"".join(b"\x00" + b"\xd0\xd0\xd0" * w for _ in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
PY
  actor="$(jq -r '[.members[] | select(.cart_member)][0].discord_id // .members[0].discord_id' "$PANDABASE_CONFIG")"
  channel="$(jq -r '.discord.intake_channel' "$PANDABASE_CONFIG")"
  msg="9$(date +%s)000" # synthetic message id: unique per run, so the job isn't deduped
  if ! submit="$(tools photo submit --file "$tmp/smoke.png" --actor "$actor" --job-type trash_cam \
    --channel-id "$channel" --message-id "$msg" 2>&1)"; then
    fail e2e "photo submit: $(brief "$submit")"
    rm -rf "$tmp"
    return
  fi
  rm -rf "$tmp"
  job_id="$(printf '%s' "$submit" | jq -r '.job_id')"
  deadline=$((SECONDS + ${SMOKE_E2E_SECONDS:-240}))
  status=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    note="$(tools api get /api/jobs/notifications 2>/dev/null |
      jq -c --arg id "$job_id" '.notifications[] | select(.job.id == $id)')"
    if [ -n "$note" ]; then
      status="$(printf '%s' "$note" | jq -r '.job.status')"
      # Mark it replied so the Discord automation doesn't answer the synthetic message.
      tools api post "/api/jobs/$job_id/notified" --key "notified:$job_id" >/dev/null 2>&1
      break
    fi
    sleep 3
  done
  case "$status" in
    completed) pass e2e "job $job_id completed: $(printf '%s' "$note" | jq -r '.summary')" ;;
    failed) fail e2e "job $job_id failed: $(printf '%s' "$note" | jq -r '.job.error // .summary')" ;;
    *) fail e2e "job $job_id not finished after ${SMOKE_E2E_SECONDS:-240}s — make logs" ;;
  esac
}

check_worker_stop() {
  local start took
  start=$SECONDS
  if docker compose -f "$ROOT/docker-compose.yml" stop worker >/dev/null 2>&1; then
    took=$((SECONDS - start))
    docker compose -f "$ROOT/docker-compose.yml" start worker >/dev/null 2>&1
    pass worker-stop "stopped cleanly in ${took}s and restarted"
  else
    docker compose -f "$ROOT/docker-compose.yml" start worker >/dev/null 2>&1
    fail worker-stop "docker compose stop worker failed — make logs"
  fi
}

# --- run ----------------------------------------------------------------------------------------

need jq curl docker
info "PandaBase smoke — $(date '+%Y-%m-%d %H:%M %Z')"
wanted env && check_env
wanted api && check_api
wanted worker && check_worker
wanted ollama && check_ollama
wanted ollama-host && check_ollama_host
wanted vlm && check_vlm
wanted replies && check_replies
wanted cdp && check_cdp
wanted cart && check_cart
wanted e2e && check_e2e
wanted worker-stop && check_worker_stop

info ""
info "passed $passed · failed $failed · skipped $skipped"
[ "$failed" -eq 0 ]
