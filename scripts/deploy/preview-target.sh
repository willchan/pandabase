#!/usr/bin/env bash
# Decide whether preview-e2e.yml runs, against which URL, and which commit it reports on
# (docs/TESTING.md tier A′). Writes to $GITHUB_OUTPUT:
#   run=true|false   url=<preview>   sha=<commit tested>   report=true when `sha` is a same-repo
#   branch head that should get the "Preview E2E" commit status (even when skipping).
# Prints names, never values.
#
#   EVENT          github.event_name: repository_dispatch | workflow_dispatch
#   URL_INPUT      workflow_dispatch: the preview URL typed in
#   DISPATCH_SHA   workflow_dispatch: github.sha (the branch it was run on)
#   DEPLOY_ENV     repository_dispatch: client_payload.environment (only `preview` runs)
#   DEPLOY_URL     repository_dispatch: client_payload.url
#   DEPLOY_REF     repository_dispatch: client_payload.git.ref (the PR branch)
#   DEPLOY_SHA     repository_dispatch: client_payload.git.sha
#   GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_TOKEN   for the same-repo branch check
#   + every secret in REQUIRED (empty = not configured yet)
#
# Skips (run=false, exit 0, a notice) for production deployments, a deployment that isn't the
# current head of a branch of this repository (a fork, a tag, a superseded push), or a `preview`
# environment that lacks a secret. Fails (exit 1) on a URL that isn't a vercel.app deployment or
# a bucket that isn't the preview one: those are mistakes, not "not set up yet".
set -euo pipefail

REQUIRED=(TURSO_DATABASE_URL TURSO_AUTH_TOKEN AGENT_API_TOKEN WORKER_API_TOKEN CRON_SECRET
  AUTH_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
  VERCEL_AUTOMATION_BYPASS_SECRET)
out="${GITHUB_OUTPUT:-/dev/stdout}"

skip() {
  echo "::notice title=Preview E2E skipped::$1"
  echo "run=false" >>"$out"
  exit 0
}

if [ "$EVENT" = workflow_dispatch ]; then
  url="${URL_INPUT:-}"
  sha="${DISPATCH_SHA:-}"
else
  [ "${DEPLOY_ENV:-}" = preview ] || skip "not a preview deployment (${DEPLOY_ENV:-no environment})"
  url="${DEPLOY_URL:-}"
  sha="${DEPLOY_SHA:-}"
  ref="${DEPLOY_REF:-}"
  ref="${ref#refs/heads/}"
  # Vercel's Git integration deploys a PR's branch; a bare sha or empty ref is something else.
  if [ -z "$ref" ] || [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
    skip "deployment ref isn't a branch of this repository"
  fi
  # Same-repo branches only, and only their current head: a fork's PR (Vercel deploys it once a
  # member authorizes it) has no such branch here, and a superseded push would test stale code.
  api="${GITHUB_API_URL:-https://api.github.com}/repos/$GITHUB_REPOSITORY/branches/$(jq -rn --arg r "$ref" '$r|@uri')"
  head="$(printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" |
    curl -fsS --max-time 20 -K - -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null |
    jq -r '.commit.sha // empty' 2>/dev/null || true)"
  if [ -z "$head" ]; then
    skip "deployment ref isn't a branch of this repository (fork PRs aren't tested)"
  fi
  if [ "$head" != "$sha" ]; then
    skip "branch has moved on since this deployment; the newer push's preview is tested instead"
  fi
fi
# From here on the commit is ours to report on, whether the run goes ahead or not.
echo "sha=$sha" >>"$out"
echo "report=true" >>"$out"

url="${url%/}"
case "$url" in http://* | https://*) ;; ?*) url="https://$url" ;; esac # Vercel may send a bare host
if ! [[ "$url" =~ ^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.vercel\.app$ ]]; then
  echo "::error::not a Vercel preview URL (https://<deployment>.vercel.app, no path): '$url'"
  exit 1
fi

missing=()
for name in "${REQUIRED[@]}"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  list="$(printf '%s, ' "${missing[@]}")"
  skip "GitHub environment 'preview' has no ${list%, } yet (docs/SETUP-CLOUD.md, Migrating an existing setup)"
fi

case "${R2_BUCKET}" in
  *preview*) ;;
  *)
    echo "::error::R2_BUCKET in 'preview' isn't a preview bucket (its name must contain 'preview'); refusing to upload test photos to it"
    exit 1
    ;;
esac

echo "run=true" >>"$out"
echo "url=$url" >>"$out"
echo "preview: $url"
