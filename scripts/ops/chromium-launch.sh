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
set -euo pipefail

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

exec "$bin" "$@"
