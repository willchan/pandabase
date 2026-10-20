"""`pandabase-tools` end to end against a fake State Engine and fixture browser."""

from __future__ import annotations

import json
import shutil
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from conftest import REPO, FakeApi, FakeDriver
from test_cart_injector import ADD, VIEW, line, product

from pandabase_tools import cli
from pandabase_tools.config import load


@pytest.fixture
def config(tmp_path: Path) -> Path:
    for name in ("pandabase.config.example.json", "profiles.example.json"):
        shutil.copy(REPO / "agent" / name, tmp_path / name.replace(".example", ""))
    cfg = tmp_path / "pandabase.config.json"
    data = json.loads(cfg.read_text())
    data["state_dir"] = str(tmp_path / "state")
    data["diagnostics_dir"] = str(tmp_path / "diagnostics")
    cfg.write_text(json.dumps(data))
    return cfg


def run(
    config: Path, argv: list[str], api: FakeApi, driver: FakeDriver | None = None
) -> tuple[int, Any]:
    args = cli.build_parser().parse_args(["--config", str(config), *argv])
    env = cli.Env(args)
    env.set_api(api.client())
    env.today = lambda: date(2026, 10, 24)
    if driver is not None:
        env.driver_factory = lambda _url: driver
    return cli.run(["--config", str(config), *argv], env)


def test_example_configs_load(config: Path) -> None:
    loaded = load(str(config))
    cfg = loaded.config
    assert cfg.cart_member().name == "will"
    assert {cfg.discord.cycle_channel, cfg.discord.intake_channel, cfg.discord.ops_channel} == {
        "100000000000000010"
    }
    assert {m.name: loaded.profile(m).cdp_url for m in cfg.members} == {
        "will": "http://127.0.0.1:9222",
        "partner": "http://127.0.0.1:9223",
    }


def test_cron_example_schedule() -> None:
    cron = json.loads((REPO / "agent" / "cron.example.json").read_text())
    assert cron["tz"] == "America/Los_Angeles"
    jobs = {j["name"]: j["cron"] for j in cron["jobs"]}
    assert jobs == {
        "pandabase-friday-nudge": "0 18 * * 5",
        "pandabase-saturday-build": "0 10 * * 6",
        "pandabase-monday-open": "0 9 * * 1",
        "pandabase-receipts-will": "0 21 * * *",  # cart member: daily
        "pandabase-receipts-partner": "0 21 * * 0",  # other member: Sundays
        "pandabase-diagnostics": "0 23 * * 0",
        "pandabase-job-replies": "*/5 * * * *",
    }


def test_human_writes_need_an_actor(config: Path) -> None:
    api = FakeApi({})
    code, out = run(
        config, ["api", "post", "/api/inventory/events", "--json", '{"events": []}'], api
    )
    assert code == 2 and "--actor" in out["error"] and api.requests == []


def test_api_post_fills_actor_and_key(config: Path) -> None:
    api = FakeApi(
        {
            "POST /api/grocery/cycle/C1/overrides": lambda b: {
                "override": {
                    "id": "O1",
                    "cycle_id": "C1",
                    "kind": b["kind"],
                    "item_id": None,
                    "product_id": None,
                    "quantity": None,
                    "free_text": b["free_text"],
                    "actor_member_id": "M1",
                    "created_at": "2026-10-20T19:00:00Z",
                }
            }
        }
    )
    argv = [
        "api",
        "post",
        "/api/grocery/cycle/C1/overrides",
        "--json",
        '{"kind": "add", "free_text": "birthday candles"}',
        "--actor",
        "100000000000000101",
        "--key",
        "discord:555",
    ]
    code, out = run(config, argv, api)
    assert code == 0 and out["override"]["free_text"] == "birthday candles"
    req = api.requests[0]
    assert req.headers["Idempotency-Key"] == "discord:555"
    assert json.loads(req.content)["actor_discord_id"] == "100000000000000101"


def test_api_error_exit_code(config: Path) -> None:
    import httpx

    api = FakeApi({"GET /api/items/lookup": lambda _: httpx.Response(401, json={"error": "nope"})})
    code, out = run(config, ["api", "get", "/api/items/lookup", "-q", "q=milk"], api)
    assert (code, out) == (1, {"error": "nope", "status": 401})
    assert api.requests[0].url.params["q"] == "milk"


def _cycle(status: str) -> dict[str, Any]:
    return {
        "id": "C1",
        "week_label": "2026-W43",
        "status": status,
        "discord_thread_id": "T1",
        "opened_at": "2026-10-19T16:00:00Z",
        "nudge_sent_at": None,
        "built_at": None,
        "closed_at": None,
        "close_reason": None,
        "cart_result": None,
    }


class CycleServer:
    def __init__(self) -> None:
        self.status = "open"
        self.results: list[dict[str, Any]] = []
        self.api = FakeApi(
            {
                "GET /api/grocery/cycle/current": lambda _: {"cycle": _cycle(self.status)},
                "POST /api/grocery/cycle/C1/status": self.set_status,
                "GET /api/predictions": lambda _: {
                    "cycle_id": "C1",
                    "generated_at": "2026-10-24T17:00:00Z",
                    "lines": [],
                    "skipped_item_ids": [],
                    "needs_price_check_item_ids": [],
                },
                "GET /api/grocery/cycle/C1/cart": lambda _: {
                    "cycle_id": "C1",
                    "lines": [
                        line("oats", product("P1", "B0SYNTH001"), 2),
                        line("towels", product("P2", "B0SYNTH002")),
                        line("candles", None, free_text="birthday candles", item_id=None),
                    ],
                },
                "POST /api/grocery/cycle/C1/cart-result": self.cart_result,
                "POST /api/telemetry": lambda b: {"accepted": len(b["events"])},
            }
        )

    def set_status(self, body: Any) -> Any:
        self.status = body["status"]
        return {"changed": True, "cycle": _cycle(self.status)}

    def cart_result(self, body: Any) -> Any:
        self.results.append(body)
        self.status = "ready"
        return {"cycle": _cycle("ready")}


def _driver() -> FakeDriver:
    return FakeDriver(
        lambda url: (url, "cart_add_confirm.html") if url.startswith(ADD) else None,
        lambda _: (VIEW, "cart_added.html"),
    )


def test_cart_build_then_finish(config: Path) -> None:
    server = CycleServer()
    driver = _driver()
    code, out = run(config, ["cart", "build"], server.api, driver)
    assert code == 0, out
    assert out["status"] == "needs_agent" and out["result_posted"] is False
    assert [x["name"] for x in out["added"]] == ["oats", "towels"]
    assert [(x["index"], x["reason"]) for x in out["needs_agent"]] == [(2, "no_product")]
    assert server.status == "building" and server.results == []
    driver.assert_never_checkout()
    tel = server.api.bodies("POST /api/telemetry")[0]["events"]
    assert {e["metric_type"] for e in tel} == {"cart_tier1_line"}

    # Re-running resumes: nothing is added to the cart twice.
    again = _driver()
    code, out = run(config, ["cart", "build", "--cycle-id", "C1"], server.api, again)
    assert code == 0 and again.opened == []
    assert {x["reason"] for x in out["added"]} == {"resumed"}

    code, out = run(
        config, ["cart", "finish", "--cycle-id", "C1", "--outcomes", '{"2": "tier2"}'], server.api
    )
    assert code == 0 and out == {
        "cycle_id": "C1",
        "status": "ready",
        "counts": {"tier1": 2, "tier2": 1},
    }
    body = server.results[0]
    assert [x["outcome"] for x in body["lines"]] == ["tier1", "tier1", "tier2"]
    assert body["vendors"] == ["amazon"]


def test_cart_build_is_skipped_when_away(config: Path) -> None:
    server = CycleServer()
    server.set_status = lambda body: {"changed": True, "cycle": _cycle("skipped")}  # type: ignore[method-assign]
    server.api.handlers["POST /api/grocery/cycle/C1/status"] = server.set_status
    code, out = run(config, ["cart", "build"], server.api, _driver())
    assert code == 0 and out["status"] == "skipped"


def test_cart_build_refuses_a_locked_profile(config: Path) -> None:
    server = CycleServer()
    code, out = run(config, ["lock", "acquire", "--member", "will", "--owner", "tier2"], server.api)
    assert code == 0 and out["token"]
    code, out = run(config, ["cart", "build"], server.api, _driver())
    assert code == 3 and out == {"error": "profile_locked", "profile": "will", "owner": "tier2"}
    code, _ = run(config, ["lock", "release", "--member", "will", "--token", "x"], server.api)


def test_cart_url_command_refuses_nothing_safe(config: Path) -> None:
    code, out = run(config, ["cart", "url", "B0SYNTH001:2", "B0SYNTHWF1"], FakeApi({}))
    assert code == 0
    assert out["url"].endswith("ASIN.1=B0SYNTH001&Quantity.1=2&ASIN.2=B0SYNTHWF1&Quantity.2=1")


def test_diagnostics_write(config: Path, tmp_path: Path) -> None:
    md = "# Weekly 2026-W42\n\n## 1. Summary\n\n1. A.\n2. B.\n3. C.\n4. D.\n\n## 2. Velocity\n"
    api = FakeApi(
        {
            "GET /api/diagnostics/weekly": lambda _: {
                "week": "2026-W42",
                "markdown": md,
                "extracts": [
                    {"name": "velocity.jsonl", "jsonl": '{"a":1}'},
                    {"name": "ux.jsonl", "jsonl": ""},
                ],
            }
        }
    )
    code, out = run(config, ["diagnostics", "write"], api)
    assert code == 0 and out["summary"] == ["A.", "B.", "C."]
    root = tmp_path / "diagnostics"
    assert (root / "2026-W42.md").read_text() == md
    assert (root / "2026-W42" / "velocity.jsonl").read_text() == '{"a":1}\n'
    assert (root / "2026-W42" / "ux.jsonl").read_text() == ""


def test_diagnostics_rejects_path_traversal(config: Path) -> None:
    api = FakeApi(
        {
            "GET /api/diagnostics/weekly": lambda _: {
                "week": "2026-W42",
                "markdown": "",
                "extracts": [{"name": "../x", "jsonl": ""}],
            }
        }
    )
    code, out = run(config, ["diagnostics", "write"], api)
    assert code == 1 and "extract name" in out["error"]


def _job(
    jid: str, status: str, job_type: str, msg: str | None, error: str | None = None
) -> dict[str, Any]:
    return {
        "id": jid,
        "job_type": job_type,
        "status": status,
        "attempts": 1,
        "media_r2_key": "m",
        "cycle_id": None,
        "error": error,
        "discord_channel_id": "100000000000000010",
        "discord_message_id": msg,
        "notified_at": None,
        "created_at": "2026-10-20T19:00:00Z",
        "completed_at": "2026-10-20T19:05:00Z",
    }


def test_jobs_replies(config: Path) -> None:
    notes: list[dict[str, Any]] = [
        {
            "job": _job("J1", "completed", "paper_receipt", "555"),
            "receipt_id": "R1",
            "review_ids": ["V1"],
            "summary": "Trader Joe's receipt: 12 lines, 10 matched.",
        },
    ]
    api = FakeApi(
        {
            "GET /api/jobs/notifications": lambda _: {"notifications": notes},
            "POST /api/jobs/J1/notified": lambda _: {
                "job": _job("J1", "completed", "paper_receipt", "555")
            },
            "POST /api/jobs/J2/notified": lambda _: {
                "job": _job("J2", "failed", "trash_cam", "556")
            },
        }
    )
    code, out = run(config, ["jobs", "replies"], api)
    assert code == 0
    assert out == (
        "[[reply_to:555]] 🧾 Trader Joe's receipt: 12 lines, 10 matched. → 1 to review: "
        "https://pandabase.example.vercel.app/cleanup"
    )
    assert api.requests[-1].headers["Idempotency-Key"] == "notified:J1"
    notes.append(
        {
            "job": _job("J2", "failed", "trash_cam", "556", "model timeout"),
            "receipt_id": None,
            "review_ids": [],
            "summary": "failed",
        }
    )
    code, out = run(config, ["jobs", "replies"], api)
    lines = out.split("\n")
    assert (
        len(lines) == 2
        and "discord.com/channels/100000000000000001/100000000000000010/555" in lines[0]
    )
    assert lines[1].startswith("⚠️ Couldn't read that photo: model timeout.")
    notes.clear()
    assert run(config, ["jobs", "replies"], api)[1] == "NO_REPLY"


def test_telemetry_emit_is_flushed(config: Path) -> None:
    api = FakeApi({"POST /api/telemetry": lambda b: {"accepted": len(b["events"])}})
    code, _ = run(
        config,
        ["telemetry", "emit", "clarifying_question", "--payload", '{"question": "Oat or whole?"}'],
        api,
    )
    assert code == 0
    events = api.bodies("POST /api/telemetry")[0]["events"]
    assert events[0]["metric_type"] == "clarifying_question"
    assert events[0]["payload"] == {"question": "Oat or whole?"}


def test_main_prints_json(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["cart", "url", "B0SYNTH001"]) == 0
    assert json.loads(capsys.readouterr().out)["url"].startswith(
        "https://www.amazon.com/gp/aws/cart/add.html?"
    )
