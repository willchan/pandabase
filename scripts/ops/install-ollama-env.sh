#!/usr/bin/env bash
# `make install-ollama-env`: OLLAMA_NUM_PARALLEL=1 and OLLAMA_MAX_LOADED_MODELS=1 for the native
# Ollama app, now and at every login (a LaunchAgent; DESIGN §1.2). Idempotent. Restart Ollama
# afterwards (quit it from the menu bar and open it again) so it reads them.
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need launchctl
label="com.pandabase.ollama-env"
src="$ROOT/ops/launchd/$label.plist"
dest="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$label.plist"
domain="gui/$(id -u)"

run mkdir -p "$(dirname "$dest")"
if [ -f "$dest" ] && cmp -s "$src" "$dest" && launchctl print "$domain/$label" >/dev/null 2>&1; then
  note "kept $label (installed, loaded)"
else
  launchctl print "$domain/$label" >/dev/null 2>&1 && run launchctl bootout "$domain/$label"
  run cp "$src" "$dest"
  run launchctl bootstrap "$domain" "$dest"
  info "loaded $label"
fi
run launchctl setenv OLLAMA_NUM_PARALLEL 1
run launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
info "Now restart Ollama (menu bar → Quit Ollama, then open it again)."
