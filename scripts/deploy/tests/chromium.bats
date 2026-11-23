#!/usr/bin/env bats
# scripts/ops/install-chromium.sh (launchctl stubbed) and scripts/ops/chromium-launch.sh (a fake
# Chrome that prints its arguments), under /bin/bash as on the Mac Mini.

load helpers

setup() {
  setup_root
  mkdir -p "$ROOT_DIR/ops/launchd"
  cp "$REPO_SRC/scripts/ops/install-chromium.sh" "$REPO_SRC/scripts/ops/chromium-launch.sh" \
    "$ROOT_DIR/scripts/ops/"
  cp "$REPO_SRC/ops/launchd/com.pandabase.chromium.plist.template" "$ROOT_DIR/ops/launchd/"
  echo '{"profiles": {"pandabase": {"cdp_url": "http://127.0.0.1:9222"}}}' >"$ROOT_DIR/agent/profiles.json"
  # launchctl: `print` succeeds once something is bootstrapped; every call is logged.
  cat >"$STUB/bin/launchctl" <<'SH'
#!/usr/bin/env bash
echo "launchctl $*" >>"$STUB/calls"
case "$1" in
  print) [ -f "$STUB/loaded" ] ;;
  bootstrap) touch "$STUB/loaded" ;;
  bootout) rm -f "$STUB/loaded" ;;
esac
SH
  # A fake Chrome: `--version` like Google Chrome's, otherwise prints the arguments it got.
  cat >"$STUB/bin/chrome" <<'SH'
#!/usr/bin/env bash
if [ "$1" = --version ]; then echo "Google Chrome ${FAKE_CHROME_VERSION:-157.0.8103.51} "; exit; fi
printf '%s\n' "$@"
SH
  chmod +x "$STUB/bin/launchctl" "$STUB/bin/chrome"
  export CHROMIUM_BIN="$STUB/bin/chrome" LAUNCH_AGENTS_DIR="$BATS_TEST_TMPDIR/agents"
  export LOG_DIR="$BATS_TEST_TMPDIR/logs" HOME="$BATS_TEST_TMPDIR/home"
  unset HEADED
  PLIST="$LAUNCH_AGENTS_DIR/com.pandabase.chromium.pandabase.plist"
}

# The plist's ProgramArguments, one per line.
program_args() {
  python3 -c 'import plistlib, sys; print("\n".join(plistlib.load(open(sys.argv[1], "rb"))["ProgramArguments"]))' "$PLIST"
}

# Bug: the headed Chrome in the agent account's background session stopped painting while the
# display slept, so the first Costco sweep's click on the Warehouse tab timed out (2026-11-16).
@test "install-chromium starts Chrome headless through the launcher by default" {
  run /bin/bash "$ROOT_DIR/scripts/ops/install-chromium.sh"
  [ "$status" -eq 0 ]
  [ "$(program_args | sed -n 1p)" = "$ROOT_DIR/scripts/ops/chromium-launch.sh" ]
  [ "$(program_args | sed -n 2p)" = headless ]
  [ "$(program_args | sed -n 3p)" = "$CHROMIUM_BIN" ]
  program_args | grep -qx -- "--remote-debugging-address=127.0.0.1"
  [[ "$output" == *"HEADED=1 make install-chromium"* ]]
}

@test "HEADED=1 reinstalls with a window, and a plain run switches back" {
  run /bin/bash "$ROOT_DIR/scripts/ops/install-chromium.sh"
  [ "$status" -eq 0 ]
  : >"$STUB/calls"
  HEADED=1 run /bin/bash "$ROOT_DIR/scripts/ops/install-chromium.sh"
  [ "$status" -eq 0 ]
  [ "$(program_args | sed -n 2p)" = headed ]
  called "launchctl bootout"
  called "launchctl bootstrap"
  : >"$STUB/calls"
  run /bin/bash "$ROOT_DIR/scripts/ops/install-chromium.sh"
  [ "$(program_args | sed -n 2p)" = headless ]
  called "launchctl bootout"
  # Unchanged and loaded: left alone.
  : >"$STUB/calls"
  run /bin/bash "$ROOT_DIR/scripts/ops/install-chromium.sh"
  [[ "$output" == *"kept com.pandabase.chromium.pandabase"* ]]
  ! called "launchctl bootout"
}

# Headless Chrome 157 sends "HeadlessChrome/157.0.0.0" in its user agent and reports an 800×600
# screen; the launcher sends headed Chrome's user agent for the installed major version.
@test "chromium-launch headless sets the headed user agent for the installed version" {
  FAKE_CHROME_VERSION=158.0.8200.12 run /bin/bash "$ROOT_DIR/scripts/ops/chromium-launch.sh" \
    headless "$STUB/bin/chrome" --user-data-dir=/x --remote-debugging-port=9222
  [ "$status" -eq 0 ]
  echo "$output" | grep -qx -- "--headless"
  echo "$output" | grep -qx -- "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36"
  echo "$output" | grep -qx -- "--screen-info={1920x1080}"
  echo "$output" | grep -qx -- "--remote-debugging-port=9222"
  ! echo "$output" | grep -q HeadlessChrome
}

@test "chromium-launch headed passes the arguments through unchanged" {
  run /bin/bash "$ROOT_DIR/scripts/ops/chromium-launch.sh" headed "$STUB/bin/chrome" --no-first-run
  [ "$status" -eq 0 ]
  [ "$output" = "--no-first-run" ]
}

@test "chromium-launch refuses an unknown mode" {
  run /bin/bash "$ROOT_DIR/scripts/ops/chromium-launch.sh" invisible "$STUB/bin/chrome"
  [ "$status" -eq 2 ]
}

# Bug (live 2026-11-23): `launchctl bootout` returns before the service has stopped, so the
# bootstrap right after it failed with "Bootstrap failed: 5: Input/output error", both switching
# to HEADED=1 and back; a second run worked because nothing was loaded any more.
@test "install-chromium waits for the old service to stop before bootstrapping" {
  run /bin/bash "$ROOT_DIR/scripts/ops/install-chromium.sh"
  [ "$status" -eq 0 ]
  # launchd that tears down asynchronously: after bootout, `print` still finds the service for
  # two more calls, and bootstrap fails (exit 5) while it is still there.
  cat >"$STUB/bin/launchctl" <<'SH'
#!/usr/bin/env bash
echo "launchctl $*" >>"$STUB/calls"
case "$1" in
  print)
    if [ -f "$STUB/stopping" ]; then
      n=$(cat "$STUB/stopping"); [ "$n" -le 0 ] && { rm -f "$STUB/stopping" "$STUB/loaded"; exit 1; }
      echo $((n - 1)) >"$STUB/stopping"; exit 0
    fi
    [ -f "$STUB/loaded" ] ;;
  bootout) echo 2 >"$STUB/stopping" ;;
  bootstrap)
    if [ -f "$STUB/stopping" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    touch "$STUB/loaded" ;;
esac
SH
  chmod +x "$STUB/bin/launchctl"
  : >"$STUB/calls"
  LAUNCHD_WAIT_STEPS=5 HEADED=1 run /bin/bash "$ROOT_DIR/scripts/ops/install-chromium.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"loaded com.pandabase.chromium.pandabase (port 9222, headed"* ]]
  [ "$(grep -c 'launchctl bootstrap' "$STUB/calls")" -eq 1 ]
}
