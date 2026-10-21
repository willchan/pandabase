#!/usr/bin/env bats
# Quiet windows (Fri 17:30–19:00, Sat 09:30–12:00 household time): no Mac Mini updates around the
# Friday nudge and the Saturday cart build — evaluated in HOUSEHOLD_TZ, across DST changes.

load helpers

setup() {
  unset UPDATE_QUIET_WINDOWS
  export HOUSEHOLD_TZ=America/Los_Angeles
  # Not scripts/ops/lib.sh: its `run` (DRY_RUN) would shadow bats' `run`.
  ROOT="$REPO_SRC"
  # shellcheck source=/dev/null
  . "$DEPLOY_SRC/lib.sh"
}

quiet() { quiet_window "$(epoch "$1")"; }

@test "Friday 17:30–19:00 local is quiet (PDT, UTC-7); the end is exclusive" {
  run quiet 2026-10-31T00:29:00Z # Fri 17:29 PDT
  [ "$status" -eq 1 ]
  run quiet 2026-10-31T00:30:00Z # Fri 17:30
  [ "$status" -eq 0 ]
  [ "$output" = "5 1730-1900" ]
  run quiet 2026-10-31T01:59:00Z # Fri 18:59
  [ "$status" -eq 0 ]
  run quiet 2026-10-31T02:00:00Z # Fri 19:00
  [ "$status" -eq 1 ]
}

@test "the household's Friday evening is already Saturday in UTC" {
  # Sat 01:00 UTC = Fri 18:00 PDT → quiet, though UTC says Saturday 01:00 (outside Sat's window).
  run quiet 2026-10-31T01:00:00Z
  [ "$status" -eq 0 ]
  [ "$output" = "5 1730-1900" ]
}

@test "Saturday 09:30–12:00 local is quiet" {
  run quiet 2026-10-31T16:29:00Z # Sat 09:29 PDT
  [ "$status" -eq 1 ]
  run quiet 2026-10-31T16:30:00Z # Sat 09:30
  [ "$status" -eq 0 ]
  [ "$output" = "6 0930-1200" ]
  run quiet 2026-10-31T18:59:00Z # Sat 11:59
  [ "$status" -eq 0 ]
  run quiet 2026-10-31T19:00:00Z # Sat 12:00
  [ "$status" -eq 1 ]
}

@test "after DST ends (Nov 1) the windows follow local time, one UTC hour later" {
  # Fri 2026-11-06 17:45 PST = Sat 01:45 UTC; the same UTC clock time as a quiet PDT Friday
  # (00:45 UTC) is now 16:45 local, outside.
  run quiet 2026-11-07T01:45:00Z
  [ "$status" -eq 0 ]
  run quiet 2026-11-07T00:45:00Z
  [ "$status" -eq 1 ]
  # Sat 2026-11-07 09:30 PST = 17:30 UTC.
  run quiet 2026-11-07T17:29:00Z
  [ "$status" -eq 1 ]
  run quiet 2026-11-07T17:30:00Z
  [ "$status" -eq 0 ]
}

@test "after DST starts (Mar 14, 2027) the windows move back to UTC-7" {
  # Fri 2027-03-12 17:30 PST = Sat 01:30 UTC; Fri 2027-03-19 17:30 PDT = Sat 00:30 UTC.
  run quiet 2027-03-13T01:30:00Z
  [ "$status" -eq 0 ]
  run quiet 2027-03-20T00:30:00Z
  [ "$status" -eq 0 ]
  run quiet 2027-03-20T02:15:00Z # Fri 19:15 PDT
  [ "$status" -eq 1 ]
}

@test "other days and times are not quiet" {
  run quiet 2026-10-21T19:00:00Z # Wed 12:00
  [ "$status" -eq 1 ]
  run quiet 2026-11-01T17:00:00Z # Sun 09:00 PST
  [ "$status" -eq 1 ]
  run quiet 2026-10-30T17:00:00Z # Fri 10:00 — only the evening is quiet
  [ "$status" -eq 1 ]
}

@test "HOUSEHOLD_TZ decides: the same instant is quiet in New York, not in Los Angeles" {
  # 2026-10-30T22:00Z = Fri 18:00 EDT = Fri 15:00 PDT.
  HOUSEHOLD_TZ=America/New_York run quiet 2026-10-30T22:00:00Z
  [ "$status" -eq 0 ]
  HOUSEHOLD_TZ=America/Los_Angeles run quiet 2026-10-30T22:00:00Z
  [ "$status" -eq 1 ]
}

@test "UPDATE_QUIET_WINDOWS overrides the windows" {
  QUIET_WINDOWS="3 1100-1300" run quiet 2026-10-21T19:00:00Z # Wed 12:00
  [ "$status" -eq 0 ]
  [ "$output" = "3 1100-1300" ]
}
