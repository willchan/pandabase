#!/usr/bin/env bash
# `make install-agent-cron`: register PandaBase's OpenClaw automations (agent/cron.example.json).
# Idempotent: lists the existing automations and edits the ones with a matching name, adds the
# rest. Needs a running gateway and operator.admin (OpenClaw's own requirement).
#
# Receipt sweeps come from the members in pandabase.config.json (`receipt_sweep`: daily → every
# day 21:00, weekly → Sunday 21:00, off → none) rather than the example's fixed names.
#
#   OPENCLAW_AGENT=pandabase   run the jobs as that agent (README "Photo privacy", option A)
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need openclaw jq
load_agent_env
[ -f "$PANDABASE_CONFIG" ] || die "missing $PANDABASE_CONFIG — run 'make install-agent-tools'"
CRON_FILE="$ROOT/agent/cron.example.json"
TOOLS_LIST="exec,read,write,message,browser"
tz="$(jq -r '.tz' "$CRON_FILE")"
intake="$(jq -r '.discord.intake_channel' "$PANDABASE_CONFIG")"
agent_args=()
[ -n "${OPENCLAW_AGENT:-}" ] && agent_args=(--agent "$OPENCLAW_AGENT")

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

# upsert NAME CRON [agent-turn MESSAGE | command COMMAND]
upsert() {
  local name="$1" cron="$2" kind="$3" payload="$4" id
  local args=(--cron "$cron" --tz "$tz")
  if [ "$kind" = command ]; then
    args+=(--command "$payload" --announce --channel discord --to "channel:$intake")
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
while IFS=$'\t' read -r name cron command message; do
  if [ "$command" != - ]; then
    # Job replies: a command payload (no model turn); agent-run.sh loads the token from .env.
    upsert "$name" "$cron" command "$(printf '%q' "$ROOT/scripts/ops/agent-run.sh") ${command#pandabase-tools }"
  else
    upsert "$name" "$cron" agent "$message"
  fi
done < <(jq -r '.jobs[] | select(.skill != "digital-receipt-scraper")
  | [.name, .cron, (.command // "-"), (.message // "-")] | @tsv' "$CRON_FILE")

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
    "Use \$digital-receipt-scraper: sweep receipts for member $member."
done < <(members)

note "Check them with: openclaw automations list"
