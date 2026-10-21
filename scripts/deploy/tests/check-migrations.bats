#!/usr/bin/env bats
# scripts/deploy/check-migrations.sh against synthetic fixture migrations (tests/fixtures).

load helpers

FIX="$BATS_TEST_DIRNAME/fixtures/migrations"
check() { run "$DEPLOY_SRC/check-migrations.sh" "$@"; }

setup() { unset CONTRACT_MIGRATION_LABEL; }

@test "expand-only migrations pass (DROP INDEX is fine)" {
  check "$FIX/0100_expand.sql" "$FIX/0105_comment_only.sql"
  [ "$status" -eq 0 ]
}

@test "DROP COLUMN in a new migration fails, with an annotation naming the line" {
  check "$FIX/0100_expand.sql" "$FIX/0101_drop_column.sql"
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error file=$FIX/0101_drop_column.sql,line=2::destructive statement"* ]]
  [[ "$output" == *"expand → contract"* ]]
}

@test "RENAME COLUMN fails" {
  check "$FIX/0102_rename.sql"
  [ "$status" -eq 1 ]
}

@test "an unmarked Drizzle table rebuild fails (DROP TABLE + RENAME TO)" {
  check "$FIX/0103_rebuild.sql"
  [ "$status" -eq 1 ]
  [ "$(grep -c '::error' <<<"$output")" -eq 2 ]
}

@test "a contract-migration marker comment allows it" {
  check "$FIX/0104_rebuild_marked.sql"
  [ "$status" -eq 0 ]
  [[ "$output" == *"marked contract-migration"* ]]
}

@test "the contract-migration PR label allows it" {
  CONTRACT_MIGRATION_LABEL=1 check "$FIX/0101_drop_column.sql"
  [ "$status" -eq 0 ]
  [[ "$output" == *"allowed by the contract-migration PR label"* ]]
}

@test "only migrations added since the base are checked" {
  repo="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$repo/db/migrations" "$repo/scripts/deploy"
  cp "$DEPLOY_SRC/check-migrations.sh" "$repo/scripts/deploy/"
  cd "$repo"
  git init -q -b main
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  cp "$FIX/0101_drop_column.sql" db/migrations/0001_old.sql # already on main: not re-checked
  git add . && git -c user.email=t@t -c user.name=t commit -q -m old
  git branch base
  cp "$FIX/0100_expand.sql" db/migrations/0002_new.sql
  git add . && git -c user.email=t@t -c user.name=t commit -q -m new
  run scripts/deploy/check-migrations.sh --base base
  [ "$status" -eq 0 ]
  cp "$FIX/0102_rename.sql" db/migrations/0003_rename.sql # new, even uncommitted
  run scripts/deploy/check-migrations.sh --base base
  [ "$status" -eq 1 ]
  [[ "$output" == *"0003_rename.sql"* ]]
}
