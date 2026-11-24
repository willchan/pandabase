#!/usr/bin/env bash
# A member's Chrome, as its LaunchAgent starts it (install-chromium.sh renders the plist).
# Usage: chromium-launch.sh headless|headed <chrome binary> <chrome args...>
#
# Headless by default: the agent account's login session is in the background with the display
# asleep, where a headed window never paints, so Playwright clicks time out waiting for the page
# to be "stable" (the first Costco sweep, 2026-11-16). `HEADED=1 make install-chromium` gives a
# window for signing in over Screen Sharing.
#
# Headless Chrome 157 still says "HeadlessChrome" in its user agent and reports an 800×600
# screen; its client hints (Sec-CH-UA) are already the normal brands. So the user agent is set
# to the one headed Chrome sends, with the major version read at each launch (Chrome updates
# itself, and a stale version would no longer match Sec-CH-UA), and the screen gets a desktop size.
#
# Before it starts Chrome, it logs one line to stderr (the Chrome log): the time, the installed
# version, how many cookies the profile's jar holds, whether the login keychain (where Chrome's
# cookie key lives) answers, and when the Mac booted. After the 2026-11-21 reboot, also
# Chrome's first launch on a new major version, the profile came back with no cookies at all;
# this line shows whether they were gone before Chrome started or Chrome dropped them.
set -euo pipefail

# launch_line <chrome> <args...>: the line above, or nothing without --user-data-dir. Never fails.
launch_line() {
  local bin="$1" dir="" arg cookies keychain boot version
  shift
  for arg in "$@"; do
    case "$arg" in --user-data-dir=*) dir="${arg#--user-data-dir=}" ;; esac
  done
  [ -n "$dir" ] || return 0
  version="$("$bin" --version 2>/dev/null | sed -nE 's/.* ([0-9][0-9.]+) *$/\1/p' || true)"
  cookies="none"
  if [ -f "$dir/Default/Cookies" ]; then
    # immutable=1: read the file as it is, no locks, no journal (Chrome isn't running yet).
    cookies="$(sqlite3 "file:$dir/Default/Cookies?immutable=1" 'select count(*) from cookies' 2>/dev/null || echo "?")"
  fi
  # `security show-keychain-info` succeeds on an unlocked login keychain; its error otherwise
  # (e.g. "User interaction is not allowed.") goes in the line as it is, spaces as underscores.
  keychain="?"
  if command -v security >/dev/null 2>&1; then
    if keychain="$(security show-keychain-info "$HOME/Library/Keychains/login.keychain-db" 2>&1)"; then
      keychain="ok"
    else
      keychain="$(printf '%s' "$keychain" | sed -n '$p' | sed -E 's/^.*: //; s/[[:space:]]+/_/g' | cut -c1-60)"
    fi
  fi
  boot="$(sysctl -n kern.boottime 2>/dev/null | sed -nE 's/.*} (.*)$/\1/p' || true)"
  echo "chromium-launch: $(date '+%Y-%m-%d %H:%M:%S %Z') chrome=${version:-?} cookies=$cookies keychain=$keychain booted=${boot:-?}" >&2
}

mode="${1:?usage: chromium-launch.sh headless|headed <chrome> <args...>}"
bin="${2:?usage: chromium-launch.sh headless|headed <chrome> <args...>}"
shift 2

case "$mode" in
  headed) ;;
  headless)
    # "Google Chrome 157.0.8103.51" → 157
    version="$("$bin" --version 2>/dev/null || true)"
    major="$(printf '%s\n' "$version" | sed -nE 's/.* ([0-9]+)\.[0-9.]+ *$/\1/p')"
    set -- --headless --window-size=1440,900 "--screen-info={1920x1080}" "$@"
    if [ -n "$major" ]; then
      set -- "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36" "$@"
    else
      echo "chromium-launch: no version from '$bin --version'; user agent left as Chrome sets it" >&2
    fi
    ;;
  *)
    echo "chromium-launch: mode must be headless or headed, got '$mode'" >&2
    exit 2
    ;;
esac

launch_line "$bin" "$@" || true
exec "$bin" "$@"
