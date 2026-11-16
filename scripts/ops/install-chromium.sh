#!/usr/bin/env bash
# `make install-chromium`: one LaunchAgent per profile in agent/profiles.json, starting that
# member's Chromium at login with its own user-data dir and a loopback-only DevTools port
# (PLAN M7 Notes). Idempotent: an unchanged, loaded agent is left alone; a changed one is
# reloaded. macOS only (launchd). The browser is Google Chrome by default (CHROMIUM_BIN in .env);
# each window is named "PandaBase · <profile>" so you can tell the members' windows apart.
# Chrome runs headless (scripts/ops/chromium-launch.sh says why); HEADED=1 reinstalls every
# profile with a window, for signing in over Screen Sharing; run it again without HEADED after.
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need jq
PROFILES="$ROOT/agent/profiles.json"
TEMPLATE="$ROOT/ops/launchd/com.pandabase.chromium.plist.template"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/PandaBase}"
CHROMIUM_BIN="${CHROMIUM_BIN:-$(env_get CHROMIUM_BIN)}"
CHROMIUM_BIN="${CHROMIUM_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -f "$PROFILES" ] || die "missing agent/profiles.json — run 'make install-agent-tools'"
[ "$DRY_RUN" = 1 ] || [ -x "$CHROMIUM_BIN" ] || die "no browser at $CHROMIUM_BIN (install Google Chrome or set CHROMIUM_BIN in .env)"
domain="gui/$(id -u)"
LAUNCHER="$ROOT/scripts/ops/chromium-launch.sh"
MODE=headless
[ "${HEADED:-0}" = 1 ] && MODE=headed

run mkdir -p "$AGENTS_DIR" "$LOG_DIR"
wanted=" "
while IFS=$'\t' read -r profile cdp_url data_dir; do
  port="${cdp_url##*:}"
  port="${port%/}"
  case "$cdp_url" in
    http://127.0.0.1:* | http://localhost:*) ;;
    *) die "profile $profile: cdp_url must be loopback (http://127.0.0.1:<port>), got $cdp_url" ;;
  esac
  data_dir="${data_dir:-~/Library/Application Support/PandaBase/chromium-$profile}"
  data_dir="${data_dir/#\~/$HOME}"
  label="com.pandabase.chromium.$profile"
  wanted+="$label "
  plist="$AGENTS_DIR/$label.plist"
  rendered="$(sed -e "s|@LABEL@|$label|g" -e "s|@CHROMIUM_BIN@|$CHROMIUM_BIN|g" \
    -e "s|@LAUNCHER@|$LAUNCHER|g" -e "s|@MODE@|$MODE|g" \
    -e "s|@USER_DATA_DIR@|$data_dir|g" -e "s|@PORT@|$port|g" -e "s|@LOG_DIR@|$LOG_DIR|g" -e "s|@PROFILE@|$profile|g" \
    "$TEMPLATE")"
  loaded=0
  launchctl print "$domain/$label" >/dev/null 2>&1 && loaded=1
  if [ -f "$plist" ] && [ "$(cat "$plist")" = "$rendered" ] && [ "$loaded" = 1 ]; then
    note "kept $label (port $port, $MODE, loaded)"
    continue
  fi
  run mkdir -p "$data_dir"
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would write $plist (port $port)"
  else
    printf '%s\n' "$rendered" >"$plist"
    if command -v plutil >/dev/null; then plutil -lint -s "$plist"; fi
  fi
  if [ "$loaded" = 1 ]; then run launchctl bootout "$domain/$label" || true; fi
  run launchctl bootstrap "$domain" "$plist"
  info "loaded $label (port $port, $MODE, $data_dir)"
done < <(jq -r '.profiles | to_entries[] | [.key, .value.cdp_url, (.value.user_data_dir // "")] | @tsv' "$PROFILES")

# A LaunchAgent for a profile no longer in profiles.json (e.g. after a rename) keeps its Chrome
# running on the same DevTools port. Say so; don't stop a signed-in browser unasked.
for plist in "$AGENTS_DIR"/com.pandabase.chromium.*.plist; do
  [ -e "$plist" ] || continue
  label="$(basename "$plist" .plist)"
  case "$wanted" in *" $label "*) continue ;; esac
  warn "$label isn't in agent/profiles.json; if you renamed that profile, stop and remove it:" \
    "launchctl bootout $domain/$label && rm '$plist'"
done

if [ "$MODE" = headed ]; then
  info "Headed: sign in by hand in each window over Screen Sharing (README step 10), then run" \
    "'make install-chromium' again to go back to headless. The tools never sign in."
else
  info "Headless (no window). To sign in: 'HEADED=1 make install-chromium', sign in over Screen" \
    "Sharing, then 'make install-chromium' (README step 10). The tools never sign in."
fi
