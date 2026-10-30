#!/usr/bin/env bats
# scripts/deploy/preview-target.sh (preview-e2e.yml): skip without secrets, same-repo branch heads
# only, URL and bucket validation, and that no secret value is printed. `curl` is a stub answering
# the GitHub branches API from $STUB/branch.

setup() {
  DEPLOY_SRC="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  STUB="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$STUB/bin"
  cat >"$STUB/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$STUB/calls"
cat >>"$STUB/curl-stdin"
if [ -f "$STUB/branch" ]; then cat "$STUB/branch"; else echo '{"message":"Branch not found"}'; exit 22; fi
EOF
  chmod +x "$STUB/bin/curl"
  : >"$STUB/calls"
  export STUB PATH="$STUB/bin:$PATH" GITHUB_OUTPUT="$BATS_TEST_TMPDIR/out"
  : >"$GITHUB_OUTPUT"
  for n in TURSO_DATABASE_URL TURSO_AUTH_TOKEN AGENT_API_TOKEN WORKER_API_TOKEN CRON_SECRET \
    AUTH_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY VERCEL_AUTOMATION_BYPASS_SECRET; do
    export "$n=secret-$n"
  done
  export R2_BUCKET=pandabase-media-preview GITHUB_REPOSITORY=willchan/pandabase GITHUB_TOKEN=gh-tok
  export GITHUB_API_URL=https://api.github.test
  export EVENT=deployment_status DEPLOY_URL=https://pandabase-abc123-team.vercel.app
  export DEPLOY_REF=claude/preview-e2e DEPLOY_SHA=1111111111111111111111111111111111111111
  echo '{"commit": {"sha": "1111111111111111111111111111111111111111"}}' >"$STUB/branch"
}

target() { run "$DEPLOY_SRC/preview-target.sh"; }

@test "a same-repo branch's current head runs against its deployment URL" {
  target
  [ "$status" -eq 0 ]
  grep -qx 'run=true' "$GITHUB_OUTPUT"
  grep -qx 'url=https://pandabase-abc123-team.vercel.app' "$GITHUB_OUTPUT"
  grep -q 'api.github.test/repos/willchan/pandabase/branches/claude%2Fpreview-e2e' "$STUB/calls"
  ! grep -q gh-tok "$STUB/calls"
  grep -q 'Bearer gh-tok' "$STUB/curl-stdin"
}

@test "skips with a notice while the preview environment lacks secrets, naming them only" {
  unset AUTH_SECRET VERCEL_AUTOMATION_BYPASS_SECRET
  target
  [ "$status" -eq 0 ]
  grep -qx 'run=false' "$GITHUB_OUTPUT"
  [[ "$output" == *"::notice"*"AUTH_SECRET, VERCEL_AUTOMATION_BYPASS_SECRET"* ]]
  [[ "$output" != *secret-* ]]
  [ ! -s "$STUB/calls" ]
}

@test "skips a fork's deployment (no such branch here)" {
  rm "$STUB/branch"
  target
  [ "$status" -eq 0 ]
  grep -qx 'run=false' "$GITHUB_OUTPUT"
  [[ "$output" == *"fork PRs aren't tested"* ]]
}

@test "skips a superseded push and a sha-only deployment" {
  echo '{"commit": {"sha": "2222222222222222222222222222222222222222"}}' >"$STUB/branch"
  target
  [ "$status" -eq 0 ] && grep -qx 'run=false' "$GITHUB_OUTPUT"
  [[ "$output" == *"moved on"* ]]
  : >"$GITHUB_OUTPUT"
  export DEPLOY_REF=1111111111111111111111111111111111111111
  target
  [ "$status" -eq 0 ] && grep -qx 'run=false' "$GITHUB_OUTPUT"
}

@test "workflow_dispatch takes the typed URL without a branch check" {
  export EVENT=workflow_dispatch URL_INPUT=https://pandabase-git-x-team.vercel.app/
  target
  [ "$status" -eq 0 ]
  grep -qx 'url=https://pandabase-git-x-team.vercel.app' "$GITHUB_OUTPUT"
  [ ! -s "$STUB/calls" ]
}

@test "refuses anything that isn't a vercel.app deployment URL" {
  export EVENT=workflow_dispatch
  for bad in https://pandabase.example.com http://x.vercel.app https://x.vercel.app/path \
    https://x.vercel.app.evil.test "https://a b.vercel.app" ""; do
    URL_INPUT="$bad" run "$DEPLOY_SRC/preview-target.sh"
    [ "$status" -eq 1 ]
    ! grep -q 'run=true' "$GITHUB_OUTPUT"
  done
}

@test "refuses a bucket that isn't the preview one" {
  export R2_BUCKET=pandabase-media
  target
  [ "$status" -eq 1 ]
  [[ "$output" == *"isn't a preview bucket"* ]]
}
