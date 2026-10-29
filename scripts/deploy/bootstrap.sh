#!/usr/bin/env bash
# First-run database steps without a terminal (.github/workflows/bootstrap.yml, run from the
# GitHub app; docs/SETUP-PHONE.md). Both actions are idempotent, so re-running is safe.
#
#   BOOTSTRAP_ACTION   migrate | add-member
#   BOOTSTRAP_TARGET   production | preview (the GitHub environment whose TURSO_* it got)
#   MEMBER_INDEX, MEMBER_NAME                           add-member: required; the member's email
#                      is the MEMBER_INDEX-th (1-based) address in ALLOWED_EMAILS, a secret, so
#                      no email is ever typed into a run's inputs (the repo is public)
#   MEMBER_DISCORD, MEMBER_PROFILE                      optional (empty = leave as is)
#   MEMBER_SWEEP       keep | daily | weekly | off      (keep = leave as is)
#   MEMBER_CART        true | false                     (true = make this the cart account)
#   DRY_RUN=1          validate and print the command; touch nothing
#
# Needs TURSO_DATABASE_URL (libsql://…) and TURSO_AUTH_TOKEN (+ ALLOWED_EMAILS for add-member).
# Logs show the email and Discord id masked; on GitHub Actions every allowed email and the Discord
# id are also registered as masks, so the tools' own output hides them.
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
action="${BOOTSTRAP_ACTION:-}"
target="${BOOTSTRAP_TARGET:-}"
index="${MEMBER_INDEX:-}"
name="${MEMBER_NAME:-}"
name="${name#"${name%%[![:space:]]*}"}"
name="${name%"${name##*[![:space:]]}"}"
discord="$(printf '%s' "${MEMBER_DISCORD:-}" | tr -d '[:space:]')"
profile="$(printf '%s' "${MEMBER_PROFILE:-}" | tr -d '[:space:]')"
sweep="${MEMBER_SWEEP:-keep}"
cart="${MEMBER_CART:-false}"

errors=()
err() { errors+=("$1"); }

case "$action" in migrate | add-member) ;; *) err "action must be migrate or add-member (got '$action')" ;; esac
case "$target" in production | preview) ;; *) err "target must be production or preview (got '$target')" ;; esac

# Mask every allowed email before anything can print one (the secret is masked only as a whole).
emails=()
if [ -n "${ALLOWED_EMAILS:-}" ]; then
  IFS=',' read -r -a emails <<<"$(printf '%s' "$ALLOWED_EMAILS" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    for e in "${emails[@]}"; do [ -z "$e" ] || echo "::add-mask::$e"; done
  fi
fi

email=""
if [ "$action" = add-member ]; then
  if ! [[ "$index" =~ ^[1-9]$ ]]; then
    err "member: 1 for the first address in ALLOWED_EMAILS, 2 for the second, …"
  elif [ "${#emails[@]}" -gt 0 ]; then
    if [ "$index" -gt "${#emails[@]}" ]; then
      err "member: ALLOWED_EMAILS has only ${#emails[@]} address(es), not $index"
    else
      email="${emails[$((index - 1))]}"
      [[ "$email" =~ ^[^@]+@[^@]+\.[^@]+$ ]] || err "ALLOWED_EMAILS: address $index is not an email address"
    fi
  elif [ "$DRY_RUN" != 1 ]; then
    err "the '$target' environment needs secret ALLOWED_EMAILS (the same value as on Vercel)"
  fi
  [ -n "$name" ] || err "name: required"
  [ "${#name}" -le 60 ] || err "name: at most 60 characters"
  [[ "$name" != *[[:cntrl:]]* ]] || err "name: no control characters"
  [ -z "$discord" ] || [[ "$discord" =~ ^[0-9]{17,20}$ ]] ||
    err "discord: a Discord user id is 17–20 digits (Copy User ID, docs/SETUP-PHONE.md)"
  [ -z "$profile" ] || [[ "$profile" =~ ^[A-Za-z0-9_-]{1,32}$ ]] ||
    err "profile: letters, digits, - and _ only (at most 32)"
  case "$sweep" in keep | daily | weekly | off) ;; *) err "sweep must be keep, daily, weekly or off" ;; esac
  case "$cart" in true | false) ;; *) err "cart must be true or false" ;; esac
fi

if [ "$DRY_RUN" != 1 ]; then
  if [ -z "${TURSO_DATABASE_URL:-}" ] || [ -z "${TURSO_AUTH_TOKEN:-}" ]; then
    err "the '$target' environment needs secrets TURSO_DATABASE_URL and TURSO_AUTH_TOKEN"
  fi
  # db/src/env.ts falls back to a local file without a URL; never "succeed" against that.
  case "${TURSO_DATABASE_URL:-}" in libsql://* | https://* | "") ;; *) err "TURSO_DATABASE_URL must start with libsql://" ;; esac
fi

if [ "${#errors[@]}" -gt 0 ]; then
  for e in "${errors[@]}"; do echo "::error title=bootstrap input::$e"; done
  exit 2
fi

# a***@example.com, 12…89
mask_email() { printf '%s***@%s' "${1:0:1}" "${1#*@}"; }
mask_id() { [ -z "$1" ] || printf '%s…%s' "${1:0:2}" "${1: -2}"; }

if [ "${GITHUB_ACTIONS:-}" = true ] && [ -n "$discord" ]; then
  echo "::add-mask::$discord"
fi

if [ "$action" = migrate ]; then
  cmd=(pnpm db:migrate:prod)
  shown="pnpm db:migrate:prod"
else
  cmd=(pnpm db:add-member --email "$email" --name "$name")
  if [ -n "$email" ]; then shown_email="$(mask_email "$email")"; else shown_email="<ALLOWED_EMAILS #$index>"; fi
  shown="pnpm db:add-member --email $shown_email --name $(printf '%q' "$name")"
  if [ -n "$discord" ]; then
    cmd+=(--discord "$discord")
    shown+=" --discord $(mask_id "$discord")"
  fi
  if [ -n "$profile" ]; then
    cmd+=(--profile "$profile")
    shown+=" --profile $profile"
  fi
  if [ "$sweep" != keep ]; then
    cmd+=(--sweep "$sweep")
    shown+=" --sweep $sweep"
  fi
  if [ "$cart" = true ]; then
    cmd+=(--cart)
    shown+=" --cart"
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] $target: $shown"
  exit 0
fi
echo "$target: $shown"
"${cmd[@]}"
