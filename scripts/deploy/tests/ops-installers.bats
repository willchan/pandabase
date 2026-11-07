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
{"discord": {"intake_channel": "123", "ops_channel": "456", "cycle_channel": "789"},
 "members": [{"name": "alex", "profile": "alex", "receipt_sweep": "weekly", "cart_member": true}]}
JSON
  printf 'PANDABASE_CONFIG=%s\n' "$ROOT_DIR/agent/pandabase.config.json" >>"$ROOT_DIR/.env"
  echo '{}' >"$STUB/openclaw.json"
  export OPENCLAW_ENV="$BATS_TEST_TMPDIR/openclaw.env"
  export PANDABASE_AGENT_ENV="$BATS_TEST_TMPDIR/config/pandabase/agent.env"
  unset OPENCLAW_AGENT PANDABASE_CONFIG PANDABASE_AGENT_API_TOKEN
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

# Bug: PandaBase's token and settings lived in OpenClaw's ~/.openclaw/.env, which the gateway
# hands to every app's tools (Bamboo read PandaBase's AGENT_API_TOKEN from it). They now go to
# PandaBase's own agent.env (dir 700, file 600); OpenClaw's file loses them, prefixed or not, and
# keeps other apps' lines and the shared OLLAMA_API_KEY.
@test "install-agent-skills writes PandaBase's own env file and clears its keys from OpenClaw's" {
  printf 'AGENT_API_TOKEN=old-unprefixed\nPANDABASE_AGENT_API_TOKEN=old\nPANDABASE_API_URL=http://old\nBAMBOO_API_URL=https://bamboo.test\n' >"$OPENCLAW_ENV"
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-skills.sh"
  [ "$status" -eq 0 ]
  grep -qx 'PANDABASE_AGENT_API_TOKEN=test-agent' "$PANDABASE_AGENT_ENV"
  grep -qx 'PANDABASE_API_URL=http://engine.test' "$PANDABASE_AGENT_ENV"
  grep -q '^PANDABASE_CONFIG=' "$PANDABASE_AGENT_ENV"
  [ -n "$(find "$PANDABASE_AGENT_ENV" -perm 600)" ] # find: same on macOS and Linux
  [ -n "$(find "$(dirname "$PANDABASE_AGENT_ENV")" -maxdepth 0 -perm 700)" ]
  ! grep -qE '^(AGENT_API_TOKEN|PANDABASE_[A-Z_]+)=' "$OPENCLAW_ENV"
  grep -qx 'BAMBOO_API_URL=https://bamboo.test' "$OPENCLAW_ENV"
  grep -qx 'OLLAMA_API_KEY=ollama-local' "$OPENCLAW_ENV"
  # A second run changes nothing.
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-skills.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"kept PANDABASE_AGENT_API_TOKEN"* ]]
  [[ "$output" != *"removed"* ]]
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

# Bug (live 2026-11-06/07): the Friday nudge and Saturday build were model jobs told only "Use
# $grocery-cycle: …"; the local model never opened the skill, posted a made-up cart, and both runs
# reported "ok". Those two are now command jobs, and every model job names its skill file.
@test "install-agent-cron runs the nudge and build as commands and names skill files" {
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-cron.sh"
  [ "$status" -eq 0 ]
  grep -F "pandabase-friday-nudge" "$STUB/calls" | grep -qF -- "cycle nudge"
  grep -F "pandabase-friday-nudge" "$STUB/calls" | grep -qF -- "--to channel:789"
  grep -F "pandabase-saturday-build" "$STUB/calls" | grep -qF -- "cart build --reply"
  grep -F "pandabase-saturday-build" "$STUB/calls" | grep -qF -- "--timeout-seconds 1500"
  ! grep -F "pandabase-saturday-build" "$STUB/calls" | grep -qF -- "--message"
  grep -F "pandabase-saturday-search" "$STUB/calls" |
    grep -qF -- "Read the skill file $ROOT_DIR/agent/skills/grocery-cycle/SKILL.md first"
  grep -F "pandabase-receipts-alex" "$STUB/calls" |
    grep -qF -- "agent/skills/digital-receipt-scraper/SKILL.md first and follow it. Sweep receipts"
  ! grep -qF -- 'Use $' "$STUB/calls"
}
