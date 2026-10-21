# Shared bats setup for scripts/deploy: a throwaway repo root with copies of the scripts, and
# stubs for git, docker, uv, curl, sleep and pandabase-tools on PATH (no network, no real repo).
# Stubs read their state from $STUB and log every call to $STUB/calls.

DEPLOY_SRC="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
REPO_SRC="$(cd "$DEPLOY_SRC/../.." && pwd)"

# Epoch for an ISO UTC time (GNU date, or BSD date on macOS).
epoch() {
  date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s
}

# A deterministic 40-character hex sha for commit number N.
sha() { printf '%s' "$1" | awk '{ s = ""; for (i = 0; i < 40; i++) s = s substr("0123456789abcdef", ($1 + i) % 16 + 1, 1); print s }'; }

setup_root() {
  ROOT_DIR="$BATS_TEST_TMPDIR/root"
  STUB="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$ROOT_DIR/scripts/ops" "$ROOT_DIR/scripts/deploy" "$ROOT_DIR/agent/tools" "$STUB/bin"
  cp "$REPO_SRC/scripts/ops/lib.sh" "$ROOT_DIR/scripts/ops/"
  cp "$DEPLOY_SRC/lib.sh" "$DEPLOY_SRC/mac-update.sh" "$ROOT_DIR/scripts/deploy/"
  cp "$BATS_TEST_DIRNAME"/stubs/* "$STUB/bin/"
  chmod +x "$STUB/bin/"*
  printf 'AGENT_API_TOKEN=test-agent\nPANDABASE_API_URL=http://engine.test\nHOUSEHOLD_TZ=America/Los_Angeles\n' \
    >"$ROOT_DIR/.env"
  export STUB PATH="$STUB/bin:$PATH" PANDABASE_TOOLS_BIN="$STUB/bin/pandabase-tools"
  export NO_COLOR=1 HEALTH_TIMEOUT=2 HEALTH_INTERVAL=1
  unset DRY_RUN HOUSEHOLD_TZ PANDABASE_API_URL AGENT_API_TOKEN DEPLOY_DISCORD_WEBHOOK_URL
  # Wednesday 2026-10-21 12:00 in Los Angeles: outside every quiet window.
  export PANDABASE_NOW="$(epoch 2026-10-21T19:00:00Z)"
  : >"$STUB/calls"
}

# origin/main's first-parent history, oldest first; HEAD starts at the first one.
history() {
  local s
  : >"$STUB/commits"
  for s in "$@"; do printf '%s\n' "$s" >>"$STUB/commits"; done
  printf '%s\n' "$1" >"$STUB/head"
}
publish() { printf '%s\n' "$@" >>"$STUB/published"; }
# The worker built from this sha never sends a heartbeat (crash loop, bad image, …).
broken() { printf '%s\n' "$@" >>"$STUB/broken"; }
head_sha() { cat "$STUB/head"; }
tag() { awk -F= '$1 == "PANDABASE_WORKER_TAG" { v = $2 } END { print v }' "$ROOT_DIR/.env"; }
called() { grep -qF -- "$1" "$STUB/calls"; }
update() { run "$ROOT_DIR/scripts/deploy/mac-update.sh" "$@"; }
