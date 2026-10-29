#!/usr/bin/env bash
# `make install-update-timer`: the launchd timer that runs `make update` every 15 min (PLAN M9,
# ops/launchd/com.pandabase.update.plist). Idempotent: re-renders and reloads only on change.
# The GHCR image is public, so no registry login is needed (README "Continuous deployment").
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need launchctl
label="com.pandabase.update"
template="$ROOT/ops/launchd/$label.plist"
agents_dir="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
log_dir="${LOG_DIR:-$HOME/Library/Logs}"
plist="$agents_dir/$label.plist"
domain="gui/$(id -u)"

rendered="$(sed -e "s|@REPO@|$ROOT|g" -e "s|@HOME@|$HOME|g" -e "s|@LOG_DIR@|$log_dir|g" "$template")"
loaded=0
launchctl print "$domain/$label" >/dev/null 2>&1 && loaded=1
if [ -f "$plist" ] && [ "$(cat "$plist")" = "$rendered" ] && [ "$loaded" = 1 ]; then
  note "kept $label (installed, loaded)"
  exit 0
fi
run mkdir -p "$agents_dir" "$log_dir"
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] would write $plist"
else
  printf '%s\n' "$rendered" >"$plist"
  if command -v plutil >/dev/null; then plutil -lint -s "$plist"; fi
fi
if [ "$loaded" = 1 ]; then run launchctl bootout "$domain/$label" || true; fi
run launchctl bootstrap "$domain" "$plist"
info "loaded $label: make update every 15 min; log: $log_dir/pandabase-update.log"
info "Pause with 'make update-pause'; status with 'make update-status'."
