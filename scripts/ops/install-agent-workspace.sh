#!/usr/bin/env bash
# `make install-agent-workspace`: write the `pandabase` agent's workspace files from
# agent/workspace/ (DESIGN §6, §10 #73). Idempotent; DRY_RUN=1 prints what would change.
#
#   AGENTS.md, IDENTITY.md   owned by this repo: replaced when they differ, the old copy kept in
#                            <workspace>/.orig/<file>.<timestamp>
#   USER.md                  a starting point: written only when the workspace has none or still
#                            has OpenClaw's placeholder; the agent's and Will's edits are kept
#
# `openclaw agents add` writes OpenClaw's generic templates, which tell a personal assistant to
# check email, reach out after 8 quiet hours and send messages freely: wrong for a household
# channel, and ~10k characters of every turn's prompt. The files load on the agent's next turn;
# no gateway restart.
#
# Only for a dedicated agent: with OPENCLAW_AGENT unset (or `main`) it changes nothing, since
# `main` is the gateway's general assistant and its workspace isn't PandaBase's.
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need openclaw jq
SRC="$ROOT/agent/workspace"
agent="$(openclaw_agent)"

if [ "$agent" = main ]; then
  note "skipped the workspace files: OPENCLAW_AGENT is main (set it to PandaBase's own agent)"
  exit 0
fi

workspace="$(openclaw config get "agents.entries.$agent.workspace" --json 2>/dev/null |
  jq -r 'if type == "string" then . else empty end' 2>/dev/null || true)"
[ -n "$workspace" ] || die "agent '$agent' has no workspace in the OpenClaw config — create it first (docs/SETUP-MAC.md §5 step 4)"
workspace="${workspace/#\~/$HOME}"
[ -d "$workspace" ] || die "workspace $workspace doesn't exist"

stamp="$(date +%Y%m%d-%H%M%S)"

keep_old() {
  local file="$1"
  run mkdir -p "$workspace/.orig"
  run cp -p "$workspace/$file" "$workspace/.orig/$file.$stamp"
}

install_file() {
  local file="$1"
  run cp "$SRC/$file" "$workspace/$file"
  info "wrote $file in $workspace"
}

# Repo-owned files.
for file in AGENTS.md IDENTITY.md; do
  if [ -f "$workspace/$file" ] && cmp -s "$SRC/$file" "$workspace/$file"; then
    note "kept $file (up to date)"
    continue
  fi
  [ -f "$workspace/$file" ] && keep_old "$file"
  install_file "$file"
done

# USER.md: seed it, never overwrite real directives. OpenClaw's template says to replace its
# example before saving; while that line is there, nothing real has been written.
if [ ! -f "$workspace/USER.md" ]; then
  install_file USER.md
elif grep -qF 'Replace the example below with a real directive' "$workspace/USER.md"; then
  keep_old USER.md
  install_file USER.md
else
  note "kept USER.md (it has directives; agent/workspace/USER.md is only a starting point)"
fi
