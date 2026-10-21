#!/usr/bin/env bash
# Shared helpers for scripts/ops and scripts/smoke. Source it; don't run it.
# shellcheck disable=SC2034  # ROOT etc. are used by the scripts that source this file

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
TOOLS_BIN="${PANDABASE_TOOLS_BIN:-$ROOT/agent/tools/.venv/bin/pandabase-tools}"
DRY_RUN="${DRY_RUN:-0}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m' C_BAD=$'\033[31m' C_WARN=$'\033[33m' C_DIM=$'\033[2m' C_OFF=$'\033[0m'
else
  C_OK='' C_BAD='' C_WARN='' C_DIM='' C_OFF=''
fi

info() { printf '%s\n' "$*"; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
warn() { printf '%s⚠ %s%s\n' "$C_WARN" "$*" "$C_OFF" >&2; }
die() {
  printf '%s✗ %s%s\n' "$C_BAD" "$*" "$C_OFF" >&2
  exit 1
}

# Run a command, or only print it when DRY_RUN=1.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s[dry-run]%s' "$C_DIM" "$C_OFF"
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

need() {
  local bin
  for bin in "$@"; do
    command -v "$bin" >/dev/null 2>&1 || die "missing '$bin' — see README (Mac Mini prerequisites)"
  done
}

# Value of KEY in an env file (default .env); empty when unset. Never echo this to the terminal
# for secret keys — callers pass it straight to the program that needs it.
env_get() {
  local key="$1" file="${2:-$ENV_FILE}"
  [ -f "$file" ] || return 0
  awk -v k="$key" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$file"
}

# Set KEY=VALUE in an env file in place (appends when absent). Keeps mode 600.
env_set() {
  local key="$1" value="$2" file="${3:-$ENV_FILE}" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  awk -v k="$key" -v v="$value" '
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# Export the agent-tools variables from .env (PANDABASE_API_URL, AGENT_API_TOKEN,
# PANDABASE_CONFIG) unless the caller's environment already has them.
load_agent_env() {
  local key value
  for key in PANDABASE_API_URL AGENT_API_TOKEN PANDABASE_CONFIG HOUSEHOLD_TZ; do
    if [ -z "${!key:-}" ]; then
      value="$(env_get "$key")"
      [ -n "$value" ] && export "$key=$value"
    fi
  done
  : "${PANDABASE_CONFIG:=$ROOT/agent/pandabase.config.json}"
  export PANDABASE_CONFIG
}

tools() {
  [ -x "$TOOLS_BIN" ] || die "agent tools not installed — run: make install-agent-tools"
  "$TOOLS_BIN" "$@"
}

# The members in pandabase.config.json, one per line: name<TAB>profile<TAB>receipt_sweep<TAB>cart.
members() {
  jq -r '.members[] | [.name, .profile, (.receipt_sweep // "weekly"), (.cart_member // false)] | @tsv' \
    "$PANDABASE_CONFIG"
}
