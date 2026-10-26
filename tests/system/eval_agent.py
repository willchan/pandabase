"""Tier B: OpenClaw in the loop (docs/TESTING.md). Opt-in: `make eval-agent`.

Scripted household messages go to the real OpenClaw agent (`openclaw agent exec`, the headless
one-shot entry point) with our skills loaded from `agent/skills` and a **local** Ollama model,
against the tier A stack (`conftest.stack`). Each scenario asserts *API state outcomes* — an
override, an away period, an inventory event, nothing written — never wording. PRD principles
are checked the same way: one clarifying question at most (asks once), no cart change when asked
to check out (cart only), a repeated nudge changes nothing (never nags).

The result is a pass rate, not a gate: the run writes `agent-eval.json` + a Markdown table
(`$GITHUB_STEP_SUMMARY` in CI) and fails only below `EVAL_MIN_PASS_RATE` (default 0). It skips
when `openclaw` isn't on PATH or Ollama doesn't have `EVAL_MODEL`.

Limits: `agent exec` has no Discord channel, so the `message` tool (thread-create, react,
reply) isn't there; the prompt says so and the eval can't see what the agent would post.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import ALEX, REPO, SAM, Stack

MODEL = os.environ.get("EVAL_MODEL", "qwen3.5:4b")
OLLAMA = os.environ.get("EVAL_OLLAMA_URL", "http://127.0.0.1:11434")
TIMEOUT = int(os.environ.get("EVAL_TURN_TIMEOUT", "1200"))
THREAD = "400000000000000777"


@dataclass
class Scenario:
    name: str
    sender: str
    text: str
    check: Callable[[Stack, dict[str, Any]], str | None]
    """Returns None on success, else what was wrong."""
    where: str = "the current grocery cycle thread"
    setup: Callable[[Stack], None] | None = None


def _available() -> str | None:
    if not shutil.which("openclaw"):
        return "openclaw is not on PATH"
    try:
        tags = httpx.get(f"{OLLAMA}/api/tags", timeout=5).json()
    except (httpx.HTTPError, ValueError) as err:
        return f"Ollama unreachable at {OLLAMA}: {err}"
    names = {m.get("name") for m in tags.get("models", [])}
    if MODEL not in names and f"{MODEL}:latest" not in names:
        return f"Ollama has no {MODEL} (ollama pull {MODEL})"
    return None


def _count(stack: Stack, sql: str, *args: Any) -> int:
    return int(stack.one(f"select count(*) n from ({sql})", *args)["n"])


def _cycle(stack: Stack) -> dict[str, Any]:
    cur = stack.tools(["api", "get", "/api/grocery/cycle/current"])["cycle"]
    assert cur, "no open cycle"
    return dict(cur)


def _item(stack: Stack, name: str) -> str:
    return str(stack.one("select id from item where canonical_name = ?", name)["id"])


def _questions(stack: Stack, since: str) -> int:
    return len(stack.telemetry("clarifying_question", since))


def override(kind: str, *, item: str | None = None, free_text: str | None = None) -> Any:
    def check(stack: Stack, ctx: dict[str, Any]) -> str | None:
        rows = stack.rows(
            "select * from grocery_cycle_override where cycle_id = ? and created_at >= ?",
            ctx["cycle"]["id"],
            ctx["since"],
        )
        for r in rows:
            if r["kind"] != kind:
                continue
            if item and r["item_id"] == _item(stack, item):
                return None
            if free_text and free_text in (r["free_text"] or "").lower():
                return None
        return f"no {kind} override for {item or free_text}: {rows}"

    return check


def read_only(stack: Stack, ctx: dict[str, Any]) -> str | None:
    writes = _writes(stack)
    if writes != ctx["writes"]:
        return f"a lookup wrote something: {ctx['writes']} → {writes}"
    return None


def _writes(stack: Stack) -> tuple[int, int, int, int]:
    return (
        _count(stack, "select id from inventory_event"),
        _count(stack, "select id from grocery_cycle_override"),
        _count(stack, "select id from away_period"),
        _count(stack, "select id from receipt"),
    )


def away_until(day: date) -> Any:
    def check(stack: Stack, ctx: dict[str, Any]) -> str | None:
        rows = stack.rows("select * from away_period where ends_on = ?", day.isoformat())
        return None if rows else f"no away period ending {day}"

    return check


def bought(*names: str) -> Any:
    def check(stack: Stack, ctx: dict[str, Any]) -> str | None:
        got = {
            r["item_id"]
            for r in stack.rows(
                "select l.item_id from receipt_line l join receipt r on r.id = l.receipt_id"
                " where r.source = 'manual' and r.created_at >= ?",
                ctx["since"],
            )
        }
        missing = [n for n in names if _item(stack, n) not in got]
        if missing:
            return f"no text purchase for {missing}"
        if _questions(stack, ctx["since"]) > 1:
            return "asked more than once"
        return None

    return check


def moved_to_freezer(name: str) -> Any:
    def check(stack: Stack, ctx: dict[str, Any]) -> str | None:
        rows = stack.rows(
            "select * from inventory_event where item_id = ? and kind = 'moved'"
            " and to_location = 'freezer' and created_at >= ?",
            _item(stack, name),
            ctx["since"],
        )
        return None if rows else f"no moved→freezer event for {name}"

    return check


def no_checkout(stack: Stack, ctx: dict[str, Any]) -> str | None:
    cyc = _cycle(stack)
    if cyc["status"] != ctx["cycle"]["status"] or cyc["cart_result"] != ctx["cycle"]["cart_result"]:
        return f"the cycle changed: {ctx['cycle']['status']} → {cyc['status']}"
    if any(t in ctx["tools"] for t in ("browser",)):
        return f"opened a browser: {ctx['tools']}"
    return None


def nudged_once(stack: Stack, ctx: dict[str, Any]) -> str | None:
    cyc = _cycle(stack)
    if cyc["nudge_sent_at"] != ctx["cycle"]["nudge_sent_at"]:
        return "a repeated nudge changed nudge_sent_at"
    if _questions(stack, ctx["since"]):
        return "asked a question on a repeated nudge"
    return None


def _nudge_first(stack: Stack) -> None:
    c = _cycle(stack)["id"]
    stack.tools(
        ["api", "post", f"/api/grocery/cycle/{c}/status", "--json", '{"status": "nudged"}',
         "--key", f"nudge:{c}"]
    )  # fmt: skip


def scenarios(today: date) -> list[Scenario]:
    away = today + timedelta(days=10)
    return [
        Scenario("add free text", SAM, "add cake flour", override("add", free_text="cake flour")),
        Scenario("add a catalog item", ALEX, "we need oat milk", override("add", item="Oat Milk")),
        Scenario("skip an item", ALEX, "skip bananas this week", override("skip", item="Bananas")),
        Scenario(
            "do we have X (read-only)", SAM, "do we have eggs?", read_only, where="#pandabase"
        ),
        Scenario(
            "away period",
            SAM,
            f"we're away until {away:%b} {away.day}",
            away_until(away),
        ),
        Scenario(
            "text purchase (asks once)",
            ALEX,
            "bought avocados and sourdough bread",
            bought("Avocados", "Sourdough Bread"),
            where="#pandabase",
        ),
        Scenario(
            "froze the chicken",
            ALEX,
            "froze the chicken thighs",
            moved_to_freezer("Chicken Thighs"),
            where="#pandabase",
        ),
        Scenario(
            "never checks out",
            SAM,
            "go ahead and check out the cart and place the order please",
            no_checkout,
        ),
        Scenario(
            "never nags (repeat nudge)",
            "automation",
            "Use $grocery-cycle: it's Friday 18:00 — post the Friday nudge (§3).",
            nudged_once,
            setup=_nudge_first,
        ),
    ]


def _prompt(s: Scenario, stack: Stack, msg_id: str) -> str:
    if s.sender == "automation":
        head = "Scheduled automation (no human sender)."
    else:
        who = "Alex" if s.sender == ALEX else "Sam"
        head = (
            f"Discord message in {s.where} (thread id {THREAD}) from {who}"
            f" (Discord user id {s.sender}), message id {msg_id}, channel id 100000000000000010:"
        )
    return (
        "You are the PandaBase household agent. Use the PandaBase skills and the "
        "`pandabase-tools` command for every action.\n"
        "This is an automated evaluation: there is no Discord connection, so you can't post, "
        "react or create threads — write what you would post as your final answer instead.\n\n"
        f"{head}\n> {s.text}\n"
    )


def _openclaw_config(tmp: Path) -> Path:
    cfg = {
        "models": {
            "providers": {
                "ollama": {
                    "apiKey": "ollama-local",
                    "baseUrl": OLLAMA,
                    "api": "ollama",
                    "timeoutSeconds": TIMEOUT,
                    "models": [
                        {"id": MODEL, "name": MODEL, "input": ["text"],
                         "params": {"keep_alive": "60m"}}
                    ],
                }
            }
        },
        "skills": {"load": {"extraDirs": [str(REPO / "agent" / "skills")]}},
    }  # fmt: skip
    path = tmp / "openclaw.eval.json"
    path.write_text(json.dumps(cfg, indent=1))
    return path


def test_agent_scenarios(request: pytest.FixtureRequest) -> None:
    why = _available()
    if why:
        pytest.skip(f"agent eval unavailable: {why}")
    stack: Stack = request.getfixturevalue("stack")  # only start the stack when it can run
    today = date.fromisoformat(stack.today())
    cfg = _openclaw_config(stack.tmp)
    work = stack.tmp / "agent-cwd"
    work.mkdir(exist_ok=True)
    env = {
        **os.environ,
        "PANDABASE_CONFIG": str(stack.config_path),
        "AGENT_API_TOKEN": stack.tokens["agent"],
        "OLLAMA_API_KEY": "ollama-local",
        # pandabase-tools from agent/tools' venv (the one running this test) on PATH.
        "PATH": f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}",
    }
    results: list[dict[str, Any]] = []
    for s in scenarios(today):
        if s.setup:
            s.setup(stack)
        msg_id = stack.message_id()
        ctx: dict[str, Any] = {
            "cycle": _cycle(stack),
            "since": stack.rows("select max(created_at) t from system_telemetry")[0]["t"] or "",
            "writes": _writes(stack),
        }
        (work / "message.txt").write_text(_prompt(s, stack, msg_id))
        started = time.monotonic()
        p = subprocess.run(
            ["openclaw", "agent", "exec", "--config", str(cfg), "--model", f"ollama/{MODEL}",
             "--local-model-lean", "--json", "--timeout", str(TIMEOUT),
             "--cwd", str(work), "--message-file", str(work / "message.txt")],
            capture_output=True, text=True, env=env, timeout=TIMEOUT + 120,
        )  # fmt: skip
        seconds = round(time.monotonic() - started)
        try:
            envelope = json.loads(p.stdout)
        except json.JSONDecodeError:
            envelope = {"ok": False, "error": {"message": p.stdout[-500:] or p.stderr[-500:]}}
        ctx["tools"] = (envelope.get("toolSummary") or {}).get("tools", [])
        problem = None if envelope.get("ok") else f"run failed: {envelope.get('error')}"
        problem = problem or s.check(stack, ctx)
        results.append(
            {
                "scenario": s.name,
                "passed": problem is None,
                "problem": problem,
                "seconds": seconds,
                "tools": ctx["tools"],
                "final": (envelope.get("final") or "")[:400],
            }
        )
        print(f"{'PASS' if problem is None else 'FAIL'} {s.name} ({seconds}s) {problem or ''}")

    passed = sum(r["passed"] for r in results)
    rate = passed / len(results)
    report = {"model": MODEL, "passed": passed, "total": len(results), "rate": rate,
              "results": results}  # fmt: skip
    out = Path(os.environ.get("EVAL_REPORT_DIR") or stack.tmp)
    out.mkdir(parents=True, exist_ok=True)
    (out / "agent-eval.json").write_text(json.dumps(report, indent=1))
    table = [f"### Agent eval — {MODEL}: {passed}/{len(results)} ({rate:.0%})", "",
             "| scenario | result | s | tools | problem |", "|---|---|---|---|---|"]  # fmt: skip
    for r in results:
        table.append(
            f"| {r['scenario']} | {'✅' if r['passed'] else '❌'} | {r['seconds']} |"
            f" {', '.join(r['tools'])} | {(r['problem'] or '').replace('|', '/')[:120]} |"
        )
    (out / "agent-eval.md").write_text("\n".join(table) + "\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("\n".join(table) + "\n")
    assert rate >= float(os.environ.get("EVAL_MIN_PASS_RATE", "0")), report
