#!/usr/bin/env bats
# scripts/ops/install-agent-skills.sh and install-agent-cron.sh with openclaw stubbed
# (tests/stubs/openclaw). Each script runs under /bin/bash: on macOS that is bash 3.2, the shell
# the Mac Mini actually uses.

load helpers

setup() {
  setup_root
  cp "$REPO_SRC/scripts/ops/install-agent-skills.sh" "$REPO_SRC/scripts/ops/install-agent-cron.sh" \
    "$ROOT_DIR/scripts/ops/"
  mkdir -p "$ROOT_DIR/agent/skills"
  cp "$REPO_SRC/agent/cron.example.json" "$ROOT_DIR/agent/"
  cat >"$ROOT_DIR/agent/pandabase.config.json" <<'JSON'
{"discord": {"intake_channel": "123", "ops_channel": "456"},
 "members": [{"name": "alex", "profile": "alex", "receipt_sweep": "weekly", "cart_member": true}]}
JSON
  printf 'PANDABASE_CONFIG=%s\n' "$ROOT_DIR/agent/pandabase.config.json" >>"$ROOT_DIR/.env"
  echo '{}' >"$STUB/openclaw.json"
  export OPENCLAW_ENV="$BATS_TEST_TMPDIR/openclaw.env"
  unset OPENCLAW_AGENT PANDABASE_CONFIG
}

# Bug: the script ran `openclaw gateway stop` before `config set`; OpenClaw 2026.10 refuses that
# for the operator's running service without --force, so the install failed half-way. The setting
# applies live, so the gateway must be left alone.
@test "install-agent-skills adds the skills dir without stopping the gateway" {
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-skills.sh"
  [ "$status" -eq 0 ]
  ! called "openclaw gateway stop"
  ! called "openclaw gateway start"
  called "openclaw config set skills.load.extraDirs"
  grep -qF "$ROOT_DIR/agent/skills" "$STUB/extraDirs"
  # A second run keeps the list as it is.
  : >"$STUB/calls"
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-skills.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"kept skills.load.extraDirs"* ]]
  ! called "openclaw config set"
}

# Bug: the token went into OpenClaw's shared env file as AGENT_API_TOKEN, a name another app's
# tools (Bamboo) also read, so they picked up PandaBase's token. It must be written prefixed, and
# an unprefixed copy from an older install removed; other apps' lines stay.
@test "install-agent-skills writes the token prefixed and drops the unprefixed one" {
  printf 'AGENT_API_TOKEN=old-unprefixed\nBAMBOO_API_URL=https://bamboo.test\n' >"$OPENCLAW_ENV"
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-skills.sh"
  [ "$status" -eq 0 ]
  grep -qx 'PANDABASE_AGENT_API_TOKEN=test-agent' "$OPENCLAW_ENV"
  ! grep -q '^AGENT_API_TOKEN=' "$OPENCLAW_ENV"
  grep -qx 'BAMBOO_API_URL=https://bamboo.test' "$OPENCLAW_ENV"
  [ -n "$(find "$OPENCLAW_ENV" -perm 600)" ] # mode 600 (find: same on macOS and Linux)
}

# Bug: with OPENCLAW_AGENT unset, `"${agent_args[@]}"` expanded an empty array, which bash 3.2
# (macOS /bin/bash) under `set -u` reports as "agent_args[@]: unbound variable".
@test "install-agent-cron runs with OPENCLAW_AGENT unset" {
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-cron.sh"
  [ "$status" -eq 0 ]
  [[ "$output" != *"unbound variable"* ]]
  called "openclaw automations add --name pandabase-receipts-alex"
  ! grep -F -- "--agent" "$STUB/calls"
}

@test "install-agent-cron passes --agent when OPENCLAW_AGENT is set" {
  OPENCLAW_AGENT=pandabase run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-cron.sh"
  [ "$status" -eq 0 ]
  grep -F "pandabase-receipts-alex" "$STUB/calls" | grep -qF -- "--agent pandabase"
}

@test "install-agent-cron announces each command job to its deliver_to channel" {
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-cron.sh"
  [ "$status" -eq 0 ]
  grep -F "pandabase-job-replies" "$STUB/calls" | grep -qF -- "--to channel:123"
  grep -F "pandabase-cart-probe" "$STUB/calls" | grep -qF -- "--to channel:456"
  grep -F "pandabase-cart-probe" "$STUB/calls" | grep -qF -- "cart probe --reply"
}
