#!/usr/bin/env bash
# `make secrets`: create .env (Mac Mini) and .env.vercel (Vercel-only secrets) and fill in any
# empty generated secret. Existing values are never changed or printed. Safe to re-run.
#
#   .env         AGENT_API_TOKEN, WORKER_API_TOKEN (+ the non-secret Mac settings to edit)
#   .env.vercel  AUTH_SECRET, CRON_SECRET (pushed to Vercel with `make vercel-env`)
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need openssl awk

VERCEL_FILE="${VERCEL_FILE:-$ROOT/.env.vercel}"

ensure_file() {
  local file="$1" template="$2"
  if [ -f "$file" ]; then
    note "kept $(basename "$file") (exists)"
  else
    run cp "$template" "$file"
    info "created $(basename "$file") from $(basename "$template")"
  fi
  run chmod 600 "$file"
}

# Fill KEY with a fresh random value if it's empty; report the name only.
generate() {
  local file="$1" key="$2" kind="$3" value
  if [ -n "$(env_get "$key" "$file")" ]; then
    note "kept $key (already set)"
    return
  fi
  case "$kind" in
    hex) value="$(openssl rand -hex 32)" ;;
    base64) value="$(openssl rand -base64 33)" ;;
  esac
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would generate $key in $(basename "$file")"
  else
    env_set "$key" "$value" "$file"
    info "generated $key in $(basename "$file")"
  fi
}

ensure_file "$ENV_FILE" "$ROOT/ops/mac.env.example"
if [ ! -f "$VERCEL_FILE" ] && [ "$DRY_RUN" != 1 ]; then
  printf '# Vercel-only secrets (gitignored). Push with: make vercel-env\nAUTH_SECRET=\nCRON_SECRET=\n' \
    >"$VERCEL_FILE"
  info "created $(basename "$VERCEL_FILE")"
fi
[ "$DRY_RUN" = 1 ] || chmod 600 "$VERCEL_FILE"

generate "$ENV_FILE" AGENT_API_TOKEN hex
generate "$ENV_FILE" WORKER_API_TOKEN hex
generate "$VERCEL_FILE" AUTH_SECRET base64
generate "$VERCEL_FILE" CRON_SECRET hex

if [ -z "$(env_get PANDABASE_CONFIG)" ] && [ "$DRY_RUN" != 1 ]; then
  env_set PANDABASE_CONFIG "$ROOT/agent/pandabase.config.json"
  info "set PANDABASE_CONFIG=$ROOT/agent/pandabase.config.json"
fi

info ""
info "Next: edit PANDABASE_API_URL in .env, then copy the shared secrets to Vercel:"
info "  make vercel-env        # or paste them in the Vercel dashboard (README step 6)"
