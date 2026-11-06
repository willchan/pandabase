#!/usr/bin/env bash
# `make install-agent-skills`: point OpenClaw at this repo's skills and write the tools' own env
# file. Idempotent; backs up openclaw.json before changing it (PLAN M7 Notes, DESIGN §6).
#
# 1. Adds <repo>/agent/skills to `skills.load.extraDirs` (OpenClaw rejects workspace skill
#    symlinks that resolve outside the workspace, so the repo is loaded as an extra root).
#    `openclaw config set` applies this live, so the gateway keeps running (OpenClaw 2026.10+
#    refuses `gateway stop` on the operator's running service without --force anyway).
# 2. Writes PANDABASE_AGENT_API_TOKEN (.env's AGENT_API_TOKEN), PANDABASE_CONFIG and
#    PANDABASE_API_URL into PandaBase's own ~/.config/pandabase/agent.env (dir 700, file 600;
#    PANDABASE_AGENT_ENV overrides the path), which pandabase-tools reads itself. Removes them
#    (and an older unprefixed AGENT_API_TOKEN) from OpenClaw's ~/.openclaw/.env: the gateway
#    hands that file to every app's tools, so it keeps only shared keys, such as a dummy
#    OLLAMA_API_KEY for local vision (added if unset). DESIGN §10 #58.
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
  run openclaw config set skills.load.extraDirs "$updated" --strict-json
  info "added $SKILLS_DIR to skills.load.extraDirs"
fi

# 2a. PandaBase's own env file
AGENT_ENV="${PANDABASE_AGENT_ENV:-$HOME/.config/pandabase/agent.env}"
load_agent_env
if [ "$DRY_RUN" != 1 ]; then
  (umask 077 && mkdir -p "$(dirname "$AGENT_ENV")" && touch "$AGENT_ENV")
  chmod 700 "$(dirname "$AGENT_ENV")"
  chmod 600 "$AGENT_ENV"
fi
for key in PANDABASE_AGENT_API_TOKEN PANDABASE_CONFIG PANDABASE_API_URL; do
  want="${!key:-}"
  src="$key"
  [ "$key" = PANDABASE_AGENT_API_TOKEN ] && src=AGENT_API_TOKEN
  [ -n "$want" ] || die "$src is empty in .env — run 'make secrets' and edit .env"
  if [ "$(env_get "$key" "$AGENT_ENV")" = "$want" ]; then
    note "kept $key in $AGENT_ENV"
  elif [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would set $key in $AGENT_ENV"
  else
    env_set "$key" "$want" "$AGENT_ENV"
    info "set $key in $AGENT_ENV"
  fi
done

# 2b. ~/.openclaw/.env: shared keys only (other apps' lines are kept as they are)
run mkdir -p "$(dirname "$OPENCLAW_ENV")"
if [ ! -f "$OPENCLAW_ENV" ] && [ "$DRY_RUN" != 1 ]; then
  : >"$OPENCLAW_ENV"
fi
[ "$DRY_RUN" = 1 ] || chmod 600 "$OPENCLAW_ENV"
changed=0
for key in PANDABASE_AGENT_API_TOKEN PANDABASE_CONFIG PANDABASE_API_URL AGENT_API_TOKEN; do
  [ -n "$(env_get "$key" "$OPENCLAW_ENV")" ] || continue
  if [ "$changed" = 0 ]; then backup "$OPENCLAW_ENV"; fi
  changed=1
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would remove $key from $OPENCLAW_ENV"
  else
    env_unset "$key" "$OPENCLAW_ENV"
    info "removed $key from $OPENCLAW_ENV (PandaBase reads $AGENT_ENV)"
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
