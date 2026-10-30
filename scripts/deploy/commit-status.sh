#!/usr/bin/env bash
# Set the "Preview E2E" commit status on SHA (preview-e2e.yml). repository_dispatch runs belong to
# the default branch, so this status is how a run shows up on the PR's head commit.
#   commit-status.sh SHA STATE DESCRIPTION      STATE: pending | success | failure | error
# Needs GITHUB_TOKEN (statuses: write), GITHUB_REPOSITORY; RUN_URL links the status to the run.
# Never fails the job: a missing status is visible, a red job for it would be noise.
set -uo pipefail

sha="$1" state="$2" description="${3:0:140}"
context="${STATUS_CONTEXT:-Preview E2E}"
body="$(jq -cn --arg s "$state" --arg d "$description" --arg c "$context" --arg u "${RUN_URL:-}" \
  '{state: $s, description: $d, context: $c} + (if $u == "" then {} else {target_url: $u} end)')"
printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" |
  curl -fsS --max-time 20 -K - -H 'Accept: application/vnd.github+json' \
    --data-binary "$body" \
    "${GITHUB_API_URL:-https://api.github.com}/repos/$GITHUB_REPOSITORY/statuses/$sha" >/dev/null ||
  echo "::warning::couldn't set the '$context' status ($state) on ${sha:0:7}"
exit 0
