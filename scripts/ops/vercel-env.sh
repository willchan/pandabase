#!/usr/bin/env bash
# `make vercel-env`: add the generated secrets to the linked Vercel project without printing
# them. Variables that already exist in an environment are left alone (to rotate one, remove it
# with `vercel env rm NAME <env>` and re-run). Needs `vercel login` + `vercel link` in web/.
#
#   VERCEL_ENVS=production   environments to fill (default and only allowed value: production).
#   Preview has its own secrets (docs/SETUP-CLOUD.md part 6a): this Mac's values are production's,
#   and previews run unreviewed PR code, so they're never pushed there.
set -euo pipefail
# shellcheck source=scripts/ops/lib.sh
. "$(dirname "$0")/lib.sh"

need vercel
VERCEL_FILE="${VERCEL_FILE:-$ROOT/.env.vercel}"
if [ ! -f "$ENV_FILE" ] || [ ! -f "$VERCEL_FILE" ]; then die "run 'make secrets' first"; fi
[ -d "$ROOT/web/.vercel" ] || die "web/ isn't linked to a Vercel project — run: (cd web && vercel link)"

for target in ${VERCEL_ENVS:-production}; do
  [ "$target" = production ] ||
    die "refusing to push this Mac's (production) secrets to Vercel '$target': previews get their own (docs/SETUP-CLOUD.md part 6a)"
done
for target in ${VERCEL_ENVS:-production}; do
  existing="$(vercel --cwd "$ROOT/web" env ls "$target" 2>/dev/null || true)"
  for key in AGENT_API_TOKEN WORKER_API_TOKEN AUTH_SECRET CRON_SECRET; do
    if [ "$key" = AUTH_SECRET ] || [ "$key" = CRON_SECRET ]; then
      value="$(env_get "$key" "$VERCEL_FILE")"
    else
      value="$(env_get "$key")"
    fi
    [ -n "$value" ] || die "$key is empty — run 'make secrets'"
    if printf '%s\n' "$existing" | awk '{print $1}' | grep -qx "$key"; then
      note "kept $key ($target: exists)"
    elif [ "$DRY_RUN" = 1 ]; then
      info "[dry-run] would add $key to $target"
    else
      printf '%s' "$value" | vercel --cwd "$ROOT/web" env add "$key" "$target" >/dev/null
      info "added $key to $target"
    fi
  done
done
