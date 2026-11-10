#!/usr/bin/env bash
# `make mac-rollout`: the steps a merged PR needs on the Mac Mini, in one idempotent command (run as
# the agent account in ~/Code/pandabase). The 15-minute updater already pulls green `main` and
# syncs the tools venv; nothing re-runs the skill and automation installers, so a PR that changes
# agent/cron.example.json, a skill's settings or the gateway env was only half live until someone
# ran them by hand (and the hand-run cron step needed OPENCLAW_AGENT=main, 2026-11-07).
#
#   1. scripts/deploy/mac-update.sh   newest green main now (a no-op when already on it)
#   2. install-agent-tools, install-agent-skills, install-agent-cron
#   3. openclaw gateway restart       only when install-agent-skills changed the gateway env
#   4. list the pandabase-* automations (schedule, on/off, agent, last run) to check the result
#
#   DRY_RUN=1   print what would run; changes nothing
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need openclaw jq
cd "$ROOT"

info "1/4 update to the newest green main"
"$ROOT/scripts/deploy/mac-update.sh"
info "now at $(git rev-parse --short HEAD)"

info "2/4 installers"
"$ROOT/scripts/ops/install-agent-tools.sh"
skills_out="$("$ROOT/scripts/ops/install-agent-skills.sh" 2>&1)" || {
  printf '%s\n' "$skills_out"
  die "install-agent-skills failed"
}
printf '%s\n' "$skills_out"
"$ROOT/scripts/ops/install-agent-cron.sh"

info "3/4 gateway"
case "$skills_out" in
  *"restart the gateway"*) run openclaw gateway restart && info "gateway restarted" ;;
  *) note "gateway env unchanged: no restart" ;;
esac

info "4/4 automations"
if [ "$DRY_RUN" = 1 ]; then
  note "[dry-run] would list the pandabase-* automations"
else
  openclaw automations list --all --json |
    jq -r '(if type == "array" then . else (.jobs // .automations // []) end)
      | map(select(.name | startswith("pandabase-")))
      | .[] | [.name, (.schedule.expr // "-"), (if .enabled then "on" else "off" end),
        (.effectiveAgentId // "-"), (.lastRunStatus // "never")] | @tsv' |
    column -t -s $'\t'
fi
