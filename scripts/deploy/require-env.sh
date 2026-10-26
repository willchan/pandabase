#!/usr/bin/env bash
# Preflight for workflows that need a GitHub environment's secrets (deploy.yml, bootstrap.yml):
#   require-env.sh ENVIRONMENT NAME...
# Fails with one clear error naming every NAME that is empty, instead of a cryptic error from
# the first tool that needs it. A secret that doesn't exist reaches the job as an empty string,
# so "not configured yet" and "set but empty" read the same. Prints names only, never values.
set -euo pipefail

environment="$1"
shift
missing=()
for name in "$@"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  list="$(printf '%s, ' "${missing[@]}")"
  echo "::error title=GitHub environment '$environment' not configured::missing secrets: ${list%, } — add them in Settings → Environments → $environment (docs/SETUP-PHONE.md)"
  exit 1
fi
echo "environment '$environment': $# required secrets present"
