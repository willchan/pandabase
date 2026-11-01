#!/usr/bin/env bats
# scripts/deploy/emit-deploy.sh (deploy.yml): the telemetry body, the optional reason, the token on
# stdin only, and that it never fails the job. `curl` is the shared stub (records argv + stdin).

setup() {
  DEPLOY_SRC="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  STUB="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$STUB/bin"
  cp "$BATS_TEST_DIRNAME/stubs/curl" "$STUB/bin/"
  chmod +x "$STUB/bin/curl"
  : >"$STUB/calls"
  export STUB PATH="$STUB/bin:$PATH" PANDABASE_API_URL=https://prod.example AGENT_API_TOKEN=tok-secret
  export GITHUB_SERVER_URL=https://github.com GITHUB_REPOSITORY=o/r GITHUB_RUN_ID=7
}

body() { sed -n 's/.*--data-binary \(.*\) https:.*/\1/p' "$STUB/calls"; }

@test "posts deploy {component, sha, outcome, run_url}; the token only on stdin" {
  run "$DEPLOY_SRC/emit-deploy.sh" web abc123 success
  [ "$status" -eq 0 ]
  [[ "$(body)" == *'"component":"web","sha":"abc123","outcome":"success","run_url":"https://github.com/o/r/actions/runs/7"}'* ]]
  [[ "$(body)" != *reason* ]]
  ! grep -q tok-secret "$STUB/calls"
  grep -q 'Bearer tok-secret' "$STUB/curl-stdin"
}

@test "a reason (web-smoke's failed checks) is added to the payload" {
  run "$DEPLOY_SRC/emit-deploy.sh" web-smoke abc123 failure "agent token, cron without its secret"
  [ "$status" -eq 0 ]
  [[ "$(body)" == *'"component":"web-smoke"'*'"reason":"agent token, cron without its secret"'* ]]
}

@test "skips with a notice when the API isn't configured" {
  unset AGENT_API_TOKEN
  run "$DEPLOY_SRC/emit-deploy.sh" web-smoke abc123 success
  [ "$status" -eq 0 ]
  [[ "$output" == *"deploy telemetry skipped"* ]]
  [ ! -s "$STUB/calls" ]
}
