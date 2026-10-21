#!/usr/bin/env bash
# `make backfill [MEMBER=name]`: 12-month receipt backfill (DESIGN §6, PRD §4.4). Repeats
# `pandabase-tools receipts sweep --member M --backfill` until it reports `complete` — each run
# resumes where the last stopped, and orders are deduped by id, so re-running is always safe.
# Default: every member whose receipt_sweep isn't "off". Their Chromium must be signed in.
# Afterwards it queues merge suggestions once (as the digital-receipt-scraper skill does).
#
#   MAX_RUNS=40      give up after this many sweep runs per member
#   LOCK_WAIT=60     seconds to wait when the profile is busy (exit 3), e.g. a cart build
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need jq
load_agent_env
[ -f "$PANDABASE_CONFIG" ] || die "missing $PANDABASE_CONFIG — run 'make install-agent-tools'"
MAX_RUNS="${MAX_RUNS:-40}"
LOCK_WAIT="${LOCK_WAIT:-60}"

targets=()
if [ -n "${MEMBER:-}" ]; then
  targets=("$MEMBER")
else
  while IFS=$'\t' read -r name _profile sweep _cart; do
    [ "$sweep" = off ] || targets+=("$name")
  done < <(members)
fi
[ "${#targets[@]}" -gt 0 ] || die "no members to backfill (all have receipt_sweep: off)"

backfill_member() {
  local member="$1" n=0 out code
  info "== backfill $member"
  while [ "$n" -lt "$MAX_RUNS" ]; do
    n=$((n + 1))
    if [ "$DRY_RUN" = 1 ]; then
      run "$TOOLS_BIN" receipts sweep --member "$member" --backfill
      return 0
    fi
    code=0
    out="$(tools receipts sweep --member "$member" --backfill)" || code=$?
    case "$code" in
      0) ;;
      3)
        note "run $n: profile busy ($(printf '%s' "$out" | jq -r '.owner // "?"')); waiting ${LOCK_WAIT}s"
        sleep "$LOCK_WAIT"
        continue
        ;;
      *)
        printf '%s\n' "$out" >&2
        die "backfill $member stopped (exit $code) — fix the error above and re-run; it resumes"
        ;;
    esac
    printf '%s' "$out" | jq -r --arg n "$n" \
      '"run \($n): pages \(.pages) · ingested \(.ingested | length) · duplicates \(.duplicates | length) · in flight \(.pending | length) · needs agent \(.needs_agent_extraction | length) · errors \(.errors | length)"'
    if [ "$(printf '%s' "$out" | jq -r '.needs_agent_extraction | length > 0')" = true ]; then
      printf '%s' "$out" | jq -r '.needs_agent_extraction[] | "  needs agent: order \(.order_id)"'
      warn "orders with no readable items: ask the agent \"backfill receipts for $member\" to extract them"
    fi
    if [ "$(printf '%s' "$out" | jq -r '.complete')" = true ]; then
      info "✓ $member: backfill complete"
      return 0
    fi
  done
  die "$member: not complete after $MAX_RUNS runs — re-run 'make backfill MEMBER=$member' to continue"
}

for member in "${targets[@]}"; do backfill_member "$member"; done

# Like the skill: once the backfill is in, ask the State Engine for merge suggestions (the
# backfill created one unverified item per product). Idempotent; results land in Cleanup → Merges.
actor="$(jq -r --arg m "${targets[0]}" '.members[] | select(.name == $m) | .discord_id' "$PANDABASE_CONFIG")"
key="backfill-merges:$actor:$(date +%F)"
if [ "$DRY_RUN" = 1 ]; then
  run "$TOOLS_BIN" api post /api/catalog/merge-suggestions/run --json '{}' --actor "$actor" --key "$key"
elif out="$(tools api post /api/catalog/merge-suggestions/run --json '{}' --actor "$actor" --key "$key")"; then
  if [ "$(printf '%s' "$out" | jq -r '.created // false')" = true ]; then
    info "✓ queued merge suggestions — they'll appear in Cleanup → Merges"
  else
    note "merge suggestions: $(printf '%s' "$out" | jq -r '.skipped // "nothing to suggest"')"
  fi
else
  warn "couldn't queue merge suggestions ($out); the weekly cron will queue them"
fi
