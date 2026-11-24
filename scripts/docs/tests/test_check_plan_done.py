"""check_plan_done.py on small synthetic PLAN.md files."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_plan_done as cpd


def plan(status: str, sections: str) -> str:
    return f"""# Plan

## Session protocol

1. Do the thing.

## Status

| Milestone | Status | PR |
|---|---|---|
{status}

Finished milestones are in PLAN-done.md.

---

{sections}
"""


def run(tmp_path: Path, text: str) -> int:
    f = tmp_path / "PLAN.md"
    f.write_text(text, encoding="utf-8")
    return cpd.main(["check_plan_done.py", str(f)])


def test_finished_and_still_present_fails(tmp_path: Path) -> None:
    text = plan(
        "| M1 Skeleton | done | #2 |\n| M2 Schema | merged (#3) | #3 |",
        "## M1 — Skeleton\n\nNotes.\n\n## M2 — Schema\n",
    )
    assert cpd.stale_sections(text) == ["M1", "M2"]
    assert run(tmp_path, text) == 1


def test_finished_and_moved_passes(tmp_path: Path) -> None:
    text = plan("| M1 Skeleton | done | #2 |\n| M2 Schema | in review | #3 |", "## M2 — Schema\n")
    assert cpd.stale_sections(text) == []
    assert run(tmp_path, text) == 0


def test_in_progress_mentioning_done_passes(tmp_path: Path) -> None:
    text = plan(
        "| M10 Costco | in progress (M10.1-M10.3 done; M10.4 not started) | #66 |",
        "## M10 — Costco as a second store\n",
    )
    assert cpd.finished_ids(text) == []
    assert run(tmp_path, text) == 0


def test_ids_are_exact_and_outside_status_ignored() -> None:
    # M1 is done, but only "## M11 —" and "## After M1 —" exist: neither is M1's section.
    text = plan(
        "| M1 Skeleton | done | #2 |\n| M11 Receipts | not started | |",
        "## M11 — Receipts\n\n## After M1 — Extras\n\n| M11 Fake | done | |\n",
    )
    assert cpd.finished_ids(text) == ["M1"]
    assert cpd.stale_sections(text) == []


def test_current_plan_passes() -> None:
    assert cpd.main(["check_plan_done.py"]) == 0
