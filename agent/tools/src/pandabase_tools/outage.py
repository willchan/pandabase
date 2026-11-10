"""Quiet API outages for polling command automations (DESIGN §6).

A command payload's stdout is posted to Discord as-is, so a frequent poller (`jobs replies`, every
5 minutes) that can't reach the State Engine must not print the CLI's raw `{"error": …}` JSON
(live 2026-11-10: a 2:36 AM `[Errno 60] Operation timed out` was posted to #pandabase). Instead
it stays silent (`NO_REPLY`) and retries on the next run. Only when the API has been failing
for `alert_after_minutes` does it post one readable ⚠️ line, then one ✅ line when it recovers.
The first failure time and whether we alerted live in a small JSON file in the state dir.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from .api import ApiError


def describe(err: ApiError) -> str:
    if err.status == 0:
        return "no response (network)"
    return f"HTTP {err.status}"


@dataclass
class OutageTracker:
    path: Path
    alert_after_minutes: int

    def _read(self) -> dict[str, object] | None:
        try:
            data = json.loads(self.path.read_text())
        except FileNotFoundError, ValueError:
            return None
        return data if isinstance(data, dict) else None

    def failed(self, err: ApiError, now: datetime, what: str) -> tuple[str | None, int]:
        """Record a failure. Returns (the one alert to post or None, minutes since it started)."""
        state = self._read()
        since = now
        alerted = False
        if state is not None:
            try:
                since = datetime.fromisoformat(str(state["since"]))
                alerted = bool(state.get("alerted"))
            except KeyError, ValueError:
                since, alerted = now, False
        minutes = max(0, int((now - since).total_seconds() // 60))
        alert = None
        if not alerted and now - since >= timedelta(minutes=self.alert_after_minutes):
            alert = (
                f"⚠️ PandaBase has been unreachable for {minutes} min ({describe(err)}), "
                f"so {what} are on hold. They'll post once it's back."
            )
            alerted = True
        self.path.write_text(json.dumps({"since": since.isoformat(), "alerted": alerted}))
        return alert, minutes

    def recovered(self, now: datetime) -> tuple[str | None, int | None]:
        """Clear a recorded outage. Returns (a ✅ line if an alert went out, its length in min)."""
        state = self._read()
        if state is None:
            return None, None
        self.path.unlink(missing_ok=True)
        try:
            minutes = max(
                0, int((now - datetime.fromisoformat(str(state["since"]))).total_seconds() // 60)
            )
        except KeyError, ValueError:
            minutes = 0
        line = "✅ PandaBase is reachable again." if state.get("alerted") else None
        return line, minutes
