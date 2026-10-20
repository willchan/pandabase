#!/usr/bin/env bash
# `make install-agent-tools`: install the agent tools' venv, put `pandabase-tools` on PATH,
# and create the agent config files from the examples (only if missing). Safe to re-run.
#
#   BIN_DIR=~/.local/bin   where the `pandabase-tools` link goes (must be on the OpenClaw
#                          gateway's PATH: `openclaw skills check` reports a missing bin)
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need uv jq
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

(cd "$ROOT/agent/tools" && run uv sync --locked)

run mkdir -p "$BIN_DIR"
if [ "$(readlink "$BIN_DIR/pandabase-tools" 2>/dev/null || true)" = "$TOOLS_BIN" ]; then
  note "kept $BIN_DIR/pandabase-tools → $TOOLS_BIN"
else
  run ln -sfn "$TOOLS_BIN" "$BIN_DIR/pandabase-tools"
  info "linked $BIN_DIR/pandabase-tools → $TOOLS_BIN"
fi

config="$ROOT/agent/pandabase.config.json"
profiles="$ROOT/agent/profiles.json"
if [ -f "$config" ]; then
  note "kept agent/pandabase.config.json (exists)"
else
  # Diagnostics go to the repo's gitignored diagnostics/ (macOS has no writable /diagnostics).
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would create agent/pandabase.config.json"
  else
    jq --arg d "$ROOT/diagnostics" '.diagnostics_dir = $d' \
      "$ROOT/agent/pandabase.config.example.json" >"$config"
    info "created agent/pandabase.config.json — edit URLs, Discord ids and members (README step 9)"
  fi
fi
if [ -f "$profiles" ]; then
  note "kept agent/profiles.json (exists)"
else
  run cp "$ROOT/agent/profiles.example.json" "$profiles"
  info "created agent/profiles.json — one entry per member profile (README step 10)"
fi
run mkdir -p "$ROOT/diagnostics"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on this shell's PATH; add it (and to the OpenClaw gateway's PATH)" ;;
esac
