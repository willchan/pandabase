#!/usr/bin/env bats
# scripts/ops/backfill.sh with pandabase-tools stubbed (tests/stubs/pandabase-tools replays
# $STUB/sweeps, one JSON result per line).

load helpers

setup() {
  setup_root
  cp "$REPO_SRC/scripts/ops/backfill.sh" "$ROOT_DIR/scripts/ops/"
  cat >"$ROOT_DIR/agent/pandabase.config.json" <<'JSON'
{"members": [{"name": "alex", "profile": "alex", "discord_id": "1001", "receipt_sweep": "daily"}]}
JSON
  printf 'PANDABASE_CONFIG=%s\n' "$ROOT_DIR/agent/pandabase.config.json" >>"$ROOT_DIR/.env"
  unset PANDABASE_CONFIG MEMBER
}

sweep() { # sweep <complete> <ingested count> <errors JSON>
  jq -cn --argjson done "$1" --argjson n "$2" --argjson errors "$3" \
    '{pages: 5, complete: $done, ingested: [range($n) | {order_id: "o\(.)"}], duplicates: [],
      pending: [], needs_agent_extraction: [], errors: $errors}' >>"$STUB/sweeps"
}
sweeps() { grep -c "tools receipts sweep" "$STUB/calls" || true; }

@test "runs sweeps until complete, then queues merge suggestions" {
  sweep false 2 '[]'
  sweep true 1 '[]'
  run /bin/bash "$ROOT_DIR/scripts/ops/backfill.sh"
  [ "$status" -eq 0 ]
  [ "$(sweeps)" -eq 2 ]
  [[ "$output" == *"alex: backfill complete"* ]]
  called "tools api post /api/catalog/merge-suggestions/run"
}

# Regression (2026-11): on a sign-in page or Amazon's /checkpoint the sweep reports an error and
# exits 0, and the loop ran it again — up to 40 times, loading pages each time. Now one run with
# errors stops the backfill.
@test "a bot check stops the backfill after one run" {
  sweep false 0 '[{"error":"amazon_challenge","profile":"alex"}]'
  sweep true 5 '[]'
  run /bin/bash "$ROOT_DIR/scripts/ops/backfill.sh"
  [ "$status" -ne 0 ]
  [ "$(sweeps)" -eq 1 ]
  [[ "$output" == *"Amazon showed a bot check"* ]]
  ! called "merge-suggestions"
}

@test "a signed-out profile or an ingest error stops it too" {
  sweep false 0 '[{"error":"not_signed_in","profile":"alex"}]'
  run /bin/bash "$ROOT_DIR/scripts/ops/backfill.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"signed out"* ]]
  : >"$STUB/calls"
  : >"$STUB/sweeps"
  sweep false 3 '[{"order_id":"o9","error":"boom"}]'
  run /bin/bash "$ROOT_DIR/scripts/ops/backfill.sh"
  [ "$status" -ne 0 ]
  [ "$(sweeps)" -eq 1 ]
  [[ "$output" == *"order o9"* ]]
}
