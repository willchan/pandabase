#!/usr/bin/env bash
# Run `pandabase-tools` with the agent env from the repo's .env (token, config path, API URL).
# The OpenClaw command automation for job replies uses this, so the token stays in .env rather
# than in OpenClaw's automation store.  Usage: scripts/ops/agent-run.sh jobs replies
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

load_agent_env
[ -x "$TOOLS_BIN" ] || die "agent tools not installed — run: make install-agent-tools"
exec "$TOOLS_BIN" "$@"
