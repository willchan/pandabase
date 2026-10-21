"""The skill pack: OpenClaw frontmatter, and every command / API call a skill names is real."""

from __future__ import annotations

import argparse
import json
import re
import shlex
from pathlib import Path

import pytest
from conftest import REPO

from pandabase_tools.api import ROUTES, match_route
from pandabase_tools.cli import build_parser

SKILLS = REPO / "agent" / "skills"
NAMES = [
    "grocery-cycle",
    "discord-intake",
    "digital-receipt-scraper",
    "item-lookup",
    "telemetry-aggregator",
]


def frontmatter(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    assert m, f"{path}: no YAML frontmatter"
    fields: dict[str, str] = {}
    key = None
    for line in m.group(1).splitlines():
        top = re.match(r"^([a-z-]+):\s*(.*)$", line)
        if top:
            key = top.group(1)
            fields[key] = top.group(2)
        elif key:
            fields[key] += "\n" + line
    return fields, m.group(2)


def test_skill_set() -> None:
    assert sorted(p.name for p in SKILLS.iterdir() if p.is_dir()) == sorted(NAMES)


@pytest.mark.parametrize("name", NAMES)
def test_frontmatter(name: str) -> None:
    fields, body = frontmatter(SKILLS / name / "SKILL.md")
    assert fields["name"] == name  # OpenClaw names the skill (and slash command) from this
    assert 40 < len(fields["description"]) < 400
    meta = json.loads(re.sub(r",(\s*[}\]])", r"\1", fields["metadata"]))  # JSON5 trailing commas
    requires = meta["openclaw"]["requires"]
    assert requires["bins"] == ["pandabase-tools"]
    assert set(requires["env"]) == {"AGENT_API_TOKEN", "PANDABASE_CONFIG"}
    assert "pandabase-tools" in body


def commands(name: str) -> list[str]:
    _, body = frontmatter(SKILLS / name / "SKILL.md")
    found = re.findall(r"`(pandabase-tools [^`]+)`", body)
    for block in re.findall(r"```sh\n(.*?)```", body, re.S):
        found += [ln.strip() for ln in block.splitlines() if ln.startswith("pandabase-tools ")]
    return found


def argv_of(cmd: str) -> list[str]:
    """Placeholders (`<sender id>`) become `1` before shell-splitting."""
    return shlex.split(re.sub(r"<[^>]+>", "1", cmd))[1:]


@pytest.mark.parametrize("name", NAMES)
def test_every_command_parses(name: str) -> None:
    cmds = commands(name)
    assert cmds, name
    parser = build_parser()
    for cmd in cmds:
        argv = argv_of(cmd)
        try:
            args = parser.parse_args(argv)
        except SystemExit as err:  # pragma: no cover - message for the failing case
            raise AssertionError(f"{name}: invalid command: {cmd}") from err
        if args.group == "api":
            route, _ = match_route(args.method, args.path)
            if args.method == "POST" and route.actor == "required":
                assert args.actor, f"{name}: {cmd} needs --actor"
            if args.method == "POST":
                assert args.key, f"{name}: {cmd} needs --key"


def test_every_agent_route_is_used_by_some_skill_or_tool() -> None:
    used = {f"{a.method.upper()} {re.sub(r'/<[^>]+>', '/{id}', a.path)}" for a in _api_calls()}
    tool_routes = {
        "POST /api/grocery/price-quotes",
        "GET /api/grocery/cycle/{id}/cart",
        "POST /api/grocery/cycle/{id}/cart-result",
        "GET /api/receipts/cursor",
        "POST /api/receipts/ingest",
        "POST /api/media/upload-url",
        "POST /api/jobs",
        "GET /api/jobs/notifications",
        "POST /api/jobs/{id}/notified",
        "POST /api/telemetry",
        "GET /api/diagnostics/weekly",
        "GET /api/health/worker",  # scripts/deploy/mac-update.sh health check (`api get`)
    }
    unused = set(ROUTES) - used - tool_routes
    assert unused == {"GET /api/freezer/aging"}  # the check-in already lists the oldest items


def _api_calls() -> list[argparse.Namespace]:
    parser = build_parser()
    out = []
    for name in NAMES:
        for cmd in commands(name):
            argv = argv_of(cmd)
            if argv[0] == "api":
                args = parser.parse_args(argv)
                args.method = args.method.upper()
                args.path = re.sub(r"/1(?=/|$)", "/<id>", args.path)
                out.append(args)
    return out


@pytest.mark.parametrize("name", NAMES)
def test_rules_are_stated(name: str) -> None:
    _, body = frontmatter(SKILLS / name / "SKILL.md")
    lowered = body.lower()
    if name in ("grocery-cycle", "discord-intake"):
        assert "ask once" in lowered and "never nag" in lowered
        assert "nothing blocks on a human" in lowered
        assert "cart only" in lowered
    if name != "telemetry-aggregator":
        assert "#pandabase" in body or "channels." in body
