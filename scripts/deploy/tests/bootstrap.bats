#!/usr/bin/env bats
# scripts/deploy/bootstrap.sh (bootstrap.yml) and require-env.sh (deploy.yml, bootstrap.yml):
# input validation, the exact pnpm command, dry runs, and that no secret or email is printed.
# `pnpm` is a stub that logs its argv; nothing touches a database.

setup() {
  DEPLOY_SRC="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  REPO_SRC="$(cd "$DEPLOY_SRC/../.." && pwd)"
  STUB="$BATS_TEST_TMPDIR/stub"
  mkdir -p "$STUB/bin"
  cat >"$STUB/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
printf '[%s]' "$@" >>"$STUB/calls"
echo >>"$STUB/calls"
EOF
  chmod +x "$STUB/bin/pnpm"
  : >"$STUB/calls"
  export STUB PATH="$STUB/bin:$PATH"
  unset DRY_RUN GITHUB_ACTIONS MEMBER_INDEX MEMBER_DISCORD MEMBER_PROFILE MEMBER_SWEEP MEMBER_CART
  export TURSO_DATABASE_URL="libsql://pandabase-test.turso.io" TURSO_AUTH_TOKEN="tok-secret-123"
  export BOOTSTRAP_TARGET=production ALLOWED_EMAILS=" Will@Example.com, partner@example.com"
}

bootstrap() { run "$DEPLOY_SRC/bootstrap.sh"; }
member() {
  export BOOTSTRAP_ACTION=add-member MEMBER_INDEX="$1" MEMBER_NAME="$2"
}

@test "migrate runs db:migrate:prod" {
  export BOOTSTRAP_ACTION=migrate
  bootstrap
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB/calls")" = "[db:migrate:prod]" ]
}

@test "add-member picks the email from ALLOWED_EMAILS by position, normalised" {
  member 1 "Will"
  export MEMBER_DISCORD=123456789012345678 MEMBER_PROFILE=will MEMBER_SWEEP=daily MEMBER_CART=true
  bootstrap
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB/calls")" = "[db:add-member][--email][will@example.com][--name][Will][--discord][123456789012345678][--profile][will][--sweep][daily][--cart]" ]
}

@test "add-member: keep / empty / unchecked leave fields alone" {
  member 2 "Partner Name"
  export MEMBER_SWEEP=keep MEMBER_CART=false MEMBER_DISCORD="" MEMBER_PROFILE=""
  bootstrap
  [ "$status" -eq 0 ]
  [ "$(cat "$STUB/calls")" = "[db:add-member][--email][partner@example.com][--name][Partner Name]" ]
}

@test "logs mask the email and Discord id and never print the token" {
  member 1 Will
  export MEMBER_DISCORD=123456789012345678 GITHUB_ACTIONS=true
  bootstrap
  [ "$status" -eq 0 ]
  [[ "$output" == *"::add-mask::will@example.com"* ]]
  [[ "$output" == *"::add-mask::partner@example.com"* ]]
  [[ "$output" == *"::add-mask::123456789012345678"* ]]
  [[ "$output" == *"--email w***@example.com"* ]]
  [[ "$output" == *"--discord 12…78"* ]]
  # Outside the add-mask commands the raw values never appear.
  if grep -v '::add-mask::' <<<"$output" | grep -qiE 'will@example.com|partner@|123456789012345678'; then false; fi
  [[ "$output" != *"tok-secret-123"* ]]
  [[ "$output" != *"pandabase-test.turso.io"* ]]
}

@test "dry run validates and prints without running or needing secrets" {
  member 1 Will
  export DRY_RUN=1
  unset TURSO_DATABASE_URL TURSO_AUTH_TOKEN
  bootstrap
  [ "$status" -eq 0 ]
  [[ "$output" == "[dry-run] production: pnpm db:add-member --email w***@example.com --name Will" ]]
  unset ALLOWED_EMAILS
  bootstrap
  [ "$status" -eq 0 ]
  [[ "$output" == "[dry-run] production: pnpm db:add-member --email <ALLOWED_EMAILS #1> --name Will" ]]
  [ ! -s "$STUB/calls" ]
}

@test "invalid inputs are all reported, nothing runs" {
  export BOOTSTRAP_ACTION=add-member BOOTSTRAP_TARGET=staging MEMBER_INDEX=x MEMBER_NAME=" "
  export MEMBER_DISCORD=12ab MEMBER_PROFILE="bad profile;rm" MEMBER_SWEEP=hourly MEMBER_CART=yes
  bootstrap
  [ "$status" -eq 2 ]
  [[ "$output" == *"target must be production or preview"* ]]
  [[ "$output" == *"member: 1 for the first address"* ]]
  [[ "$output" == *"name: required"* ]]
  [[ "$output" == *"discord: a Discord user id is 17–20 digits"* ]]
  [[ "$output" == *"profile: letters, digits"* ]]
  [[ "$output" == *"sweep must be"* ]]
  [[ "$output" == *"cart must be true or false"* ]]
  [ ! -s "$STUB/calls" ]
}

@test "member index beyond ALLOWED_EMAILS, a bad address, or no ALLOWED_EMAILS fail" {
  member 3 Will
  bootstrap
  [ "$status" -eq 2 ]
  [[ "$output" == *"ALLOWED_EMAILS has only 2 address(es), not 3"* ]]
  export ALLOWED_EMAILS="will@example.com,oops"
  member 2 Partner
  bootstrap
  [ "$status" -eq 2 ]
  [[ "$output" == *"address 2 is not an email address"* ]]
  unset ALLOWED_EMAILS
  bootstrap
  [ "$status" -eq 2 ]
  [[ "$output" == *"needs secret ALLOWED_EMAILS"* ]]
  [ ! -s "$STUB/calls" ]
}

@test "unknown action is rejected" {
  export BOOTSTRAP_ACTION=seed
  bootstrap
  [ "$status" -eq 2 ]
  [[ "$output" == *"action must be migrate or add-member"* ]]
  [ ! -s "$STUB/calls" ]
}

@test "missing TURSO secrets fail instead of falling back to a local file" {
  export BOOTSTRAP_ACTION=migrate TURSO_DATABASE_URL=""
  bootstrap
  [ "$status" -eq 2 ]
  [[ "$output" == *"needs secrets TURSO_DATABASE_URL and TURSO_AUTH_TOKEN"* ]]
  export TURSO_DATABASE_URL=file:local.db
  bootstrap
  [ "$status" -eq 2 ]
  [[ "$output" == *"must start with libsql://"* ]]
  [ ! -s "$STUB/calls" ]
}

@test "require-env names every missing secret and prints no values" {
  export A=set-value B=""
  unset C
  run "$DEPLOY_SRC/require-env.sh" production A B C
  [ "$status" -eq 1 ]
  [[ "$output" == *"GitHub environment 'production' not configured::missing secrets: B, C"* ]]
  [[ "$output" != *"set-value"* ]]
  run "$DEPLOY_SRC/require-env.sh" production A
  [ "$status" -eq 0 ]
  [[ "$output" == *"1 required secrets present"* ]]
}

@test "deploy.yml checks every secret it uses before migrating" {
  local wf="$REPO_SRC/.github/workflows/deploy.yml" used checked name
  # Secrets the workflow uses; AGENT_API_TOKEN is optional (telemetry, smoke), GITHUB_TOKEN is per
  # run, WORKER_API_TOKEN and DEPLOY_DISCORD_WEBHOOK_URL are the smoke's optional extras.
  used="$(grep -oE 'secrets\.[A-Z_]+' "$wf" | sed 's/secrets\.//' | sort -u |
    grep -vxE 'AGENT_API_TOKEN|GITHUB_TOKEN|WORKER_API_TOKEN|DEPLOY_DISCORD_WEBHOOK_URL')"
  checked="$(awk '/require-env\.sh production/,/env:/' "$wf")"
  for name in $used; do
    [[ "$checked" == *" $name"* ]] || { echo "deploy.yml preflight doesn't check $name"; return 1; }
  done
  # The preflight comes before the migration in the migrate job.
  pre="$(grep -n 'require-env.sh production' "$wf" | head -1 | cut -d: -f1)"
  mig="$(grep -n 'run: pnpm db:migrate:prod' "$wf" | cut -d: -f1)"
  [ "$pre" -lt "$mig" ]
}

@test "bootstrap.yml offers the actions and targets the script accepts" {
  local wf="$REPO_SRC/.github/workflows/bootstrap.yml"
  grep -qF 'options: [migrate, add-member]' "$wf"
  grep -qF 'options: [production, preview]' "$wf"
  grep -qF 'options: [keep, daily, weekly, off]' "$wf"
  grep -qF 'options: ["1", "2", "3", "4"]' "$wf"
  # No email is ever a dispatch input (public repo): it comes from the ALLOWED_EMAILS secret.
  if grep -qE '^      email:' "$wf"; then false; fi
  grep -qF 'ALLOWED_EMAILS: ${{ secrets.ALLOWED_EMAILS }}' "$wf"
  grep -qF 'environment: ${{ inputs.target }}' "$wf"
}
