#!/usr/bin/env python3
"""Fail when a finished milestone's section is still in docs/PLAN.md (PLAN *Session protocol*).

    check_plan_done.py [PLAN.md]

Reads the `## Status` table and collects the milestone ids (first token of the first cell, like
M9 or M11) whose status cell starts with "done" or "merged". "in progress (M10.1 done; …)" is not
finished. Exits 1, naming each one, if a `## <id> —` heading for any of them is still in the file:
the PR that finishes a milestone moves its section to docs/PLAN-done.md. Rows with no section are
ignored. Standard library only (make ops-check).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DEFAULT_PLAN = Path(__file__).resolve().parents[2] / "docs" / "PLAN.md"
FINISHED = ("done", "merged")


def finished_ids(text: str) -> list[str]:
    """Milestone ids whose status cell in the `## Status` table starts with done/merged."""
    ids: list[str] = []
    in_status = False
    for line in text.splitlines():
        if line.startswith("## "):
            in_status = line.strip() == "## Status"
            continue
        if not in_status or not line.lstrip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2 or not cells[0] or set(cells[0]) <= set("-: "):
            continue
        status = cells[1].lower()
        if status.startswith(FINISHED):
            ids.append(cells[0].split()[0])
    return ids


def stale_sections(text: str) -> list[str]:
    """Finished milestone ids that still have a `## <id> —` section."""
    return [
        mid
        for mid in finished_ids(text)
        if re.search(rf"^## {re.escape(mid)} —", text, flags=re.MULTILINE)
    ]


def main(argv: list[str]) -> int:
    plan = Path(argv[1]) if len(argv) > 1 else DEFAULT_PLAN
    stale = stale_sections(plan.read_text(encoding="utf-8"))
    for mid in stale:
        print(
            f"{plan}: {mid} is done but its '## {mid} —' section is still here; "
            "move it (Notes included) to the end of docs/PLAN-done.md",
            file=sys.stderr,
        )
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
