#!/usr/bin/env bash
# Flag destructive statements in *new* migrations (CLAUDE.md: migrations are expand → contract).
# `main` migrates production before the new code ships, so the release still running must work on
# the new schema: DROP TABLE / DROP COLUMN / RENAME belong in a later PR, once no deployed code
# uses the old name. Such a migration passes only when it says so on purpose:
#
#   -- contract-migration: <why it's safe, e.g. "nothing reads old_col since #42">
#
# anywhere in the .sql file, or with the PR label `contract-migration` (CI sets
# CONTRACT_MIGRATION_LABEL=1). Drizzle's SQLite table rebuild (CREATE __new_x, copy, DROP x,
# RENAME __new_x TO x) is flagged too: it is safe only if every old column survives — check, then
# mark it.
#
#   check-migrations.sh [--base REF]   migrations added since REF (default: origin/main)
#   check-migrations.sh FILE...        just these files (tests)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
base="origin/main"
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      base="$2"
      shift 2
      ;;
    *)
      files+=("$1")
      shift
      ;;
  esac
done

if [ "${#files[@]}" -eq 0 ]; then
  cd "$ROOT"
  if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    echo "check-migrations: base '$base' not found — fetch it (git fetch origin main); skipping" >&2
    exit 0
  fi
  while IFS= read -r f; do files+=("$f"); done < <(
    git diff --name-only --diff-filter=A "$base...HEAD" -- 'db/migrations/*.sql'
    git ls-files --others --exclude-standard -- 'db/migrations/*.sql'
  )
fi
if [ "${#files[@]}" -eq 0 ]; then
  echo "check-migrations: no new migrations"
  exit 0
fi

bad=0
for f in "${files[@]}"; do
  if grep -qiE '^[[:space:]]*--[[:space:]]*contract-migration:[[:space:]]*[^[:space:]]' "$f"; then
    echo "check-migrations: $f is marked contract-migration — allowed"
    continue
  fi
  # Statements only: drop `-- …` comments, then look for destructive DDL (case-insensitive).
  hits="$(sed -e 's/--.*$//' "$f" | grep -niE 'drop[[:space:]]+table|drop[[:space:]]+column|rename[[:space:]]+(column|to)' || true)"
  if [ -n "$hits" ]; then
    bad=1
    if [ "${CONTRACT_MIGRATION_LABEL:-0}" = 1 ]; then
      echo "check-migrations: $f has destructive statements; allowed by the contract-migration PR label"
      continue
    fi
    printf '%s\n' "$hits" | while IFS= read -r line; do
      echo "::error file=$f,line=${line%%:*}::destructive statement in a new migration: ${line#*:}"
    done
  fi
done
if [ "$bad" = 1 ] && [ "${CONTRACT_MIGRATION_LABEL:-0}" != 1 ]; then
  cat >&2 <<'MSG'
check-migrations: new migrations drop or rename tables/columns. The release still running would
break against this schema (CLAUDE.md: expand → contract). Split it: add the new shape now, drop
the old one in a later PR once no deployed code uses it. If this is that later PR (or a Drizzle
table rebuild that keeps every column), add `-- contract-migration: <reason>` to the .sql file or
the `contract-migration` label to the PR.
MSG
  exit 1
fi
