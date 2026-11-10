#!/usr/bin/env bash
# `make install-agent-cron`: register PandaBase's OpenClaw automations (agent/cron.example.json).
# Idempotent: lists the existing automations and edits the ones with a matching name, adds the
# rest. Needs a running gateway and operator.admin (OpenClaw's own requirement).
#
# Receipt sweeps come from the members in pandabase.config.json (`receipt_sweep`: daily → every
# day 21:00, weekly → Sunday 21:00, off → none) rather than the example's fixed names.
#
#   OPENCLAW_AGENT=pandabase   run the jobs as that agent (README "Photo privacy", option A).
#                              Default `main`: once a second app (Bamboo) has its own agent,
#                              OpenClaw refuses to *add* a job without --agent (live, 2026-11-07).
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need openclaw jq
load_agent_env
[ -f "$PANDABASE_CONFIG" ] || die "missing $PANDABASE_CONFIG — run 'make install-agent-tools'"
CRON_FILE="$ROOT/agent/cron.example.json"
TOOLS_LIST="exec,read,write,message"  # no browser: tier 2 is `pandabase-tools cart search/add` (DESIGN §10 #52)
tz="$(jq -r '.tz' "$CRON_FILE")"
# A command job announces to its `deliver_to` channel (a key of the config's `discord`).
channel_id() { jq -r --arg k "$1" '.discord[$k] // empty' "$PANDABASE_CONFIG"; }
agent_args=(--agent "${OPENCLAW_AGENT:-main}")

if [ "$DRY_RUN" = 1 ]; then
  existing='[]'
else
  existing="$(openclaw automations list --all --json)" || die "can't list automations — is the gateway running?"
fi

job_id() {
  printf '%s' "$existing" |
    jq -r --arg n "$1" '(if type == "array" then . else (.jobs // .automations // []) end)
      | map(select(.name == $n)) | first | .id // empty'
}

# A model job's message names its skill file outright: given only "Use $grocery-cycle: …", the
# local model never opened the skill and improvised (live, 2026-11-06/07).
skill_message() {
  printf 'Read the skill file %s first and follow it. %s' \
    "$ROOT/agent/skills/$1/SKILL.md" "$2"
}

# upsert NAME CRON [agent MESSAGE | command COMMAND CHANNEL_ID [TIMEOUT_SECONDS]]
upsert() {
  local name="$1" cron="$2" kind="$3" payload="$4" id
  local args=(--cron "$cron" --tz "$tz")
  if [ "$kind" = command ]; then
    args+=(--command "$payload" --announce --channel discord --to "channel:$5" "${agent_args[@]}")
    if [ -n "${6:-}" ] && [ "$6" != - ]; then
      args+=(--timeout-seconds "$6" --no-output-timeout-seconds "$6")
    fi
  else
    args+=(--session isolated --message "$payload" --tools "$TOOLS_LIST" --no-deliver "${agent_args[@]}")
  fi
  id="$(job_id "$name")"
  if [ -n "$id" ]; then
    run openclaw automations edit "$id" "${args[@]}" >/dev/null
    info "updated $name ($cron)"
  else
    run openclaw automations add --name "$name" "${args[@]}" >/dev/null
    info "added $name ($cron)"
  fi
}

# Fixed jobs from the example, i.e. everything but the per-member receipt sweeps. ("-" marks an
# empty field: `read` merges adjacent tabs.)
while IFS=$'\t' read -r name cron skill command message deliver_to timeout; do
  if [ "$command" != - ]; then
    # Command payloads (job replies, the Friday nudge, the Saturday build, the weekly cart probe):
    # no model turn; agent-run.sh loads the token from .env.
    to="$(channel_id "$deliver_to")"
    [ -n "$to" ] || die "$name: no discord.$deliver_to in $PANDABASE_CONFIG"
    upsert "$name" "$cron" command "$(printf '%q' "$ROOT/scripts/ops/agent-run.sh") ${command#pandabase-tools }" "$to" "$timeout"
  else
    upsert "$name" "$cron" agent "$(skill_message "$skill" "$message")"
  fi
done < <(jq -r '.jobs[] | select(.skill != "digital-receipt-scraper")
  | [.name, .cron, .skill, (.command // "-"), (.message // "-"), (.deliver_to // "intake_channel"),
     (.timeout_seconds // "-" | tostring)] | @tsv' "$CRON_FILE")

# Receipt sweeps, one per member.
while IFS=$'\t' read -r member _profile sweep _cart; do
  case "$sweep" in
    daily) cron="0 21 * * *" ;;
    weekly) cron="0 21 * * 0" ;;
    *)
      if [ -n "$(job_id "pandabase-receipts-$member")" ]; then
        warn "pandabase-receipts-$member exists but $member's receipt_sweep is off — remove it with: openclaw automations remove <id>"
      fi
      continue
      ;;
  esac
  upsert "pandabase-receipts-$member" "$cron" agent \
    "$(skill_message digital-receipt-scraper "Sweep receipts for member $member.")"
done < <(members)

note "Check them with: openclaw automations list"
