#!/usr/bin/env bash
# `deploy {component, sha, outcome}` telemetry from deploy.yml (DESIGN §7, weekly *Deploys*).
#   emit-deploy.sh COMPONENT SHA OUTCOME [REASON]   OUTCOME: a job status (success / failure /
#   cancelled); REASON (optional) lands in the report's *Detail* column, e.g. the failed checks.
# Needs PANDABASE_API_URL and AGENT_API_TOKEN; skips with a notice when they aren't configured.
# Never fails the job: telemetry is not worth a red deploy. The token goes to curl on stdin.
set -uo pipefail

component="$1" sha="$2" outcome="$3" reason="${4:-}"
if [ -z "${PANDABASE_API_URL:-}" ] || [ -z "${AGENT_API_TOKEN:-}" ]; then
  echo "::notice::deploy telemetry skipped (PANDABASE_API_URL / AGENT_API_TOKEN not configured)"
  exit 0
fi
body="$(jq -cn --arg c "$component" --arg s "$sha" --arg o "$outcome" --arg why "$reason" \
  --arg r "${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" \
  '{events: [{metric_type: "deploy", payload: ({component: $c, sha: $s, outcome: $o, run_url: $r}
    + (if $why == "" then {} else {reason: $why} end))}]}')"
printf 'header = "Authorization: Bearer %s"\n' "$AGENT_API_TOKEN" |
  curl -fsS --max-time 20 --retry 2 -K - -H 'Content-Type: application/json' \
    --data-binary "$body" "${PANDABASE_API_URL%/}/api/telemetry" >/dev/null ||
  echo "::warning::couldn't send deploy telemetry ($component $outcome)"
exit 0
