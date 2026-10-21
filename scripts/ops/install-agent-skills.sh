#!/usr/bin/env bash
# `make install-agent-skills`: point OpenClaw at this repo's skills and give the gateway the agent
# env. Idempotent; backs up openclaw.json before changing it (PLAN M7 Notes, DESIGN §6).
#
# 1. Adds <repo>/agent/skills to `skills.load.extraDirs` (OpenClaw rejects workspace skill
#    symlinks that resolve outside the workspace, so the repo is loaded as an extra root).
#    `openclaw config set` needs the gateway stopped: it is stopped and started again only when
#    the list actually changes.
# 2. Writes AGENT_API_TOKEN, PANDABASE_CONFIG and PANDABASE_API_URL from .env (plus a dummy
#    OLLAMA_API_KEY for local vision, if unset) into ~/.openclaw/.env: the gateway loads it, and
#    the skills gate on these variables.
# 3. Runs `openclaw skills check`.
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need openclaw jq
SKILLS_DIR="$ROOT/agent/skills"
OPENCLAW_ENV="${OPENCLAW_ENV:-$HOME/.openclaw/.env}"
[ -f "$ENV_FILE" ] || die "run 'make secrets' first"

config_file="$(openclaw config file --json 2>/dev/null | jq -r '.path // empty' || true)"
config_file="${config_file:-$HOME/.openclaw/openclaw.json}"
[ -f "$config_file" ] || die "no OpenClaw config at $config_file — set up OpenClaw first (README step 11)"

backup() {
  local file="$1" copy
  copy="$file.bak.$(date +%Y%m%d-%H%M%S)"
  run cp -p "$file" "$copy"
  info "backed up $(basename "$file") → $copy"
}

# 1. skills.load.extraDirs
current="$(openclaw config get skills.load.extraDirs --json 2>/dev/null || true)"
if ! printf '%s' "$current" | jq -e 'type == "array"' >/dev/null 2>&1; then
  current='[]' # unset (the CLI prints a failure envelope)
fi
if printf '%s' "$current" | jq -e --arg d "$SKILLS_DIR" 'index($d) != null' >/dev/null; then
  note "kept skills.load.extraDirs (already includes $SKILLS_DIR)"
else
  updated="$(printf '%s' "$current" | jq -c --arg d "$SKILLS_DIR" '. + [$d]')"
  backup "$config_file"
  was_running=0
  if openclaw gateway status >/dev/null 2>&1; then
    was_running=1
    run openclaw gateway stop
  fi
  run openclaw config set skills.load.extraDirs "$updated" --strict-json
  info "added $SKILLS_DIR to skills.load.extraDirs"
  if [ "$was_running" = 1 ]; then run openclaw gateway start; fi
fi

# 2. ~/.openclaw/.env (only the PandaBase keys; other lines are kept as they are)
run mkdir -p "$(dirname "$OPENCLAW_ENV")"
if [ ! -f "$OPENCLAW_ENV" ] && [ "$DRY_RUN" != 1 ]; then
  : >"$OPENCLAW_ENV"
fi
[ "$DRY_RUN" = 1 ] || chmod 600 "$OPENCLAW_ENV"
load_agent_env
changed=0
for key in AGENT_API_TOKEN PANDABASE_CONFIG PANDABASE_API_URL; do
  want="${!key:-}"
  [ -n "$want" ] || die "$key is empty in .env — run 'make secrets' and edit .env"
  if [ "$(env_get "$key" "$OPENCLAW_ENV")" = "$want" ]; then
    note "kept $key in $OPENCLAW_ENV"
    continue
  fi
  if [ "$changed" = 0 ] && [ -s "$OPENCLAW_ENV" ]; then backup "$OPENCLAW_ENV"; fi
  changed=1
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would set $key in $OPENCLAW_ENV"
  else
    env_set "$key" "$want" "$OPENCLAW_ENV"
    info "set $key in $OPENCLAW_ENV"
  fi
done
# OpenClaw's bundled Ollama provider wants a (dummy) key to count as configured for local vision.
if [ -z "$(env_get OLLAMA_API_KEY "$OPENCLAW_ENV")" ]; then
  if [ "$changed" = 0 ] && [ -s "$OPENCLAW_ENV" ]; then backup "$OPENCLAW_ENV"; fi
  changed=1
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would set OLLAMA_API_KEY=ollama-local in $OPENCLAW_ENV"
  else
    env_set OLLAMA_API_KEY ollama-local "$OPENCLAW_ENV"
    info "set OLLAMA_API_KEY=ollama-local in $OPENCLAW_ENV"
  fi
fi
if [ "$changed" = 1 ]; then
  warn "restart the gateway so it reads $OPENCLAW_ENV: openclaw gateway restart"
fi

# 3. Report
run openclaw skills check
info "New sessions pick the skills up; existing ones keep their snapshot (start a new session)."
