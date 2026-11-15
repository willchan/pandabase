#!/usr/bin/env bats
# scripts/ops/install-agent-workspace.sh with openclaw stubbed (tests/stubs/openclaw), under
# /bin/bash (bash 3.2 on macOS, the Mac Mini's shell).

load helpers

setup() {
  setup_root
  cp "$REPO_SRC/scripts/ops/install-agent-workspace.sh" "$ROOT_DIR/scripts/ops/"
  cp -R "$REPO_SRC/agent/workspace" "$ROOT_DIR/agent/"
  WS="$BATS_TEST_TMPDIR/workspace-pandabase"
  mkdir -p "$WS"
  printf '%s\n' "$WS" >"$STUB/workspace"
  unset OPENCLAW_AGENT
}

install() { OPENCLAW_AGENT=pandabase run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-workspace.sh"; }

# Bug: `openclaw agents add` left the `pandabase` agent on OpenClaw's generic AGENTS.md, which
# tells a personal assistant to check email, reach out after 8 quiet hours and send messages
# freely, in a shared household channel.
@test "replaces OpenClaw's generic AGENTS.md and IDENTITY.md, keeping the old copies" {
  printf '# AGENTS.md - Your Workspace\n## Automations - Be Proactive\n' >"$WS/AGENTS.md"
  printf '# IDENTITY.md - Who Am I?\n' >"$WS/IDENTITY.md"
  install
  [ "$status" -eq 0 ]
  cmp -s "$ROOT_DIR/agent/workspace/AGENTS.md" "$WS/AGENTS.md"
  cmp -s "$ROOT_DIR/agent/workspace/IDENTITY.md" "$WS/IDENTITY.md"
  ! grep -q "Be Proactive" "$WS/AGENTS.md"
  grep -q "Be Proactive" "$WS"/.orig/AGENTS.md.*
  grep -q "Who Am I" "$WS"/.orig/IDENTITY.md.*
  # A second run changes nothing.
  install
  [ "$status" -eq 0 ]
  [[ "$output" == *"kept AGENTS.md (up to date)"* ]]
  [[ "$output" != *"wrote"* ]]
  [ "$(find "$WS/.orig" -type f | wc -l | tr -d ' ')" -eq 2 ]
}

@test "seeds USER.md over OpenClaw's placeholder but keeps real directives" {
  printf 'Replace the example below with a real directive and a real observation date.\n' >"$WS/USER.md"
  install
  [ "$status" -eq 0 ]
  cmp -s "$ROOT_DIR/agent/workspace/USER.md" "$WS/USER.md"
  printf '%s\n' '- Always call Sam by name.' >"$WS/USER.md"
  install
  [ "$status" -eq 0 ]
  [[ "$output" == *"kept USER.md"* ]]
  grep -qx -- '- Always call Sam by name.' "$WS/USER.md"
}

@test "writes all three files into an empty workspace" {
  install
  [ "$status" -eq 0 ]
  [ -f "$WS/AGENTS.md" ] && [ -f "$WS/IDENTITY.md" ] && [ -f "$WS/USER.md" ]
  [ ! -d "$WS/.orig" ]
}

# `main` is the gateway's general assistant: PandaBase's AGENTS.md must never land in its
# workspace, which is what an unset OPENCLAW_AGENT would otherwise name.
@test "changes nothing when the agent is main" {
  printf 'generic\n' >"$WS/AGENTS.md"
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-workspace.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipped the workspace files"* ]]
  grep -qx generic "$WS/AGENTS.md"
  ! called "openclaw config get"
}

@test "takes the agent from .env" {
  printf 'OPENCLAW_AGENT=pandabase\n' >>"$ROOT_DIR/.env"
  run /bin/bash "$ROOT_DIR/scripts/ops/install-agent-workspace.sh"
  [ "$status" -eq 0 ]
  called "openclaw config get agents.entries.pandabase.workspace"
  [ -f "$WS/AGENTS.md" ]
}

@test "DRY_RUN=1 changes nothing" {
  printf 'generic\n' >"$WS/AGENTS.md"
  DRY_RUN=1 install
  [ "$status" -eq 0 ]
  grep -qx generic "$WS/AGENTS.md"
  [ ! -f "$WS/USER.md" ]
}

@test "fails when the agent has no workspace" {
  rm "$STUB/workspace"
  install
  [ "$status" -ne 0 ]
  [[ "$output" == *"has no workspace"* ]]
}
