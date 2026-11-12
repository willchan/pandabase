"""`pandabase-tools` end to end against a fake State Engine and fixture browser."""

from __future__ import annotations

import json
import shutil
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import REPO, FakeApi, FakeDriver, FakeShop
from test_cart_injector import VIEW, line, product

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
    # One PandaBase browser profile, the cart member's; the other member has none (their own
    # Chrome profiles belong to their OpenClaw agents, outside PandaBase).
    assert {m.name: m.profile for m in cfg.members} == {"will": "pandabase", "partner": None}
    assert loaded.profile(cfg.cart_member()).cdp_url == "http://127.0.0.1:9222"
    with pytest.raises(KeyError, match="no PandaBase browser profile"):
        loaded.profile(cfg.member("partner"))


def test_cron_example_schedule() -> None:
    cron = json.loads((REPO / "agent" / "cron.example.json").read_text())
    assert cron["tz"] == "America/Los_Angeles"
    jobs = {j["name"]: j["cron"] for j in cron["jobs"]}
    assert jobs == {
        "pandabase-friday-nudge": "0 18 * * 5",
        "pandabase-saturday-build": "0 10 * * 6",
        "pandabase-saturday-search": "30 10 * * 6",  # tier 2, after the build
        "pandabase-monday-open": "0 9 * * 1",
        "pandabase-receipts-will": "0 21 * * *",  # cart member: daily
        "pandabase-diagnostics": "0 23 * * 0",
        "pandabase-job-replies": "*/5 * * * *",
        "pandabase-cart-probe": "0 15 * * 5",  # Friday afternoon, before Saturday's build
        "pandabase-data-check": "20 8 * * 1",  # Monday morning, after Sunday's diagnostics
    }
    by_name = {j["name"]: j for j in cron["jobs"]}
    # No model turn for these two (live 2026-11-07: the model posted a made-up cart).
    assert by_name["pandabase-friday-nudge"]["command"] == "pandabase-tools cycle nudge"
    assert by_name["pandabase-saturday-build"]["command"] == "pandabase-tools cart build --reply"
    assert {
        by_name[n]["deliver_to"] for n in ("pandabase-friday-nudge", "pandabase-saturday-build")
    } == {"cycle_channel"}
    assert "cart pending" in by_name["pandabase-saturday-search"]["message"]
    probe = next(j for j in cron["jobs"] if j["name"] == "pandabase-cart-probe")
    assert probe["command"] == "pandabase-tools cart probe --reply"
    assert probe["deliver_to"] == "ops_channel"


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
    return FakeShop().driver  # product pages + a cart whose count follows the adds


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


def test_cart_build_raises_one_layout_alert_when_most_lines_lose_their_add_button(
    config: Path,
) -> None:
    # Both tier-1 lines' product pages have no add button (as if Amazon changed its layout): 2 of
    # the 2 lines tier 1 tried failed for a page reason → one alert for the ops channel.
    server = CycleServer()
    shop = FakeShop(unavailable=frozenset({"B0SYNTH001", "B0SYNTH002"}))
    code, out = run(config, ["cart", "build"], server.api, shop.driver)
    assert code == 0, out
    assert out["layout_alert"] == {
        "page_failures": 2,
        "attempted": 2,
        "reasons": {"no_add_form": 2},
        "asins": ["B0SYNTH001", "B0SYNTH002"],
    }
    tel = server.api.bodies("POST /api/telemetry")[0]["events"]
    alerts = [e["payload"] for e in tel if e["metric_type"] == "cart_layout_alert"]
    assert alerts == [{"cycle_id": "C1", **out["layout_alert"]}]

    # A re-run of the same build fails the same way but doesn't alert twice.
    again = FakeShop(unavailable=frozenset({"B0SYNTH001", "B0SYNTH002"}))
    code, out = run(config, ["cart", "build", "--cycle-id", "C1"], server.api, again.driver)
    assert code == 0 and out["layout_alert"] is None
    assert out["layout_alert_already_raised"] is True
    tel = server.api.bodies("POST /api/telemetry")[-1]["events"]
    assert "cart_layout_alert" not in {e["metric_type"] for e in tel}


def test_cart_build_without_page_trouble_has_no_layout_alert(config: Path) -> None:
    code, out = run(config, ["cart", "build"], CycleServer().api, _driver())
    assert code == 0 and out["layout_alert"] is None
    assert out["layout_alert_already_raised"] is False


def _probe_config(config: Path) -> None:
    data = json.loads(config.read_text())
    data["cart"]["probe_asins"] = {"amazon": "B0SYNTH501", "wholefoods": "B0SYNTH301"}
    config.write_text(json.dumps(data))


def _probe_driver(wf_page: str = "product_wholefoods.html") -> FakeDriver:
    dp = "https://www.amazon.com/dp/"
    return FakeDriver(
        {
            dp + "B0SYNTH501": (dp + "B0SYNTH501", "product_buy_box.html"),
            dp + "B0SYNTH301": (dp + "B0SYNTH301", wf_page),
        }
    )


def test_cart_probe_command(config: Path) -> None:
    _probe_config(config)
    api = FakeApi({"POST /api/telemetry": lambda b: {"accepted": len(b["events"])}})
    driver = _probe_driver()
    code, out = run(config, ["cart", "probe"], api, driver)
    assert code == 0 and out["ok"] is True
    assert driver.clicks == 0
    tel = api.bodies("POST /api/telemetry")[0]["events"]
    assert [e["metric_type"] for e in tel] == ["cart_probe", "cart_probe"]

    code, out = run(config, ["cart", "probe", "--reply"], api, _probe_driver())
    assert (code, out) == (0, "NO_REPLY")
    code, out = run(
        config, ["cart", "probe", "--reply"], api, _probe_driver("product_unavailable.html")
    )
    assert code == 0 and out.startswith("⚠️") and "Whole Foods" in out


def test_cart_probe_reply_when_the_browser_is_busy(config: Path) -> None:
    _probe_config(config)
    api = FakeApi({})
    code, _ = run(config, ["lock", "acquire", "--member", "will", "--owner", "receipts"], api)
    assert code == 0
    code, out = run(config, ["cart", "probe", "--reply"], api, _probe_driver())
    assert code == 0 and out.startswith("⚠️") and "busy" in out
    code, out = run(config, ["cart", "probe"], api, _probe_driver())
    assert code == 3 and out["error"] == "profile_locked"


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
    assert code == 3 and out == {
        "error": "profile_locked",
        "profile": "pandabase",
        "owner": "tier2",
    }
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


def _dq_api(rows: list[dict[str, Any]]) -> FakeApi:
    jsonl = "\n".join(json.dumps(r) for r in rows)
    return FakeApi(
        {
            "GET /api/diagnostics/weekly": lambda _: {
                "week": "2026-W45",
                "markdown": "",
                "extracts": [{"name": "data_quality.jsonl", "jsonl": jsonl}],
            }
        }
    )


def test_diagnostics_check_is_quiet_when_nothing_is_flagged(config: Path) -> None:
    rows = [
        {
            "check": "store_split",
            "lines": 40,
            "by_store": {"amazon": 30, "wholefoods": 10},
            "top_share": 0.75,
            "flagged": False,
        }
    ]
    assert run(config, ["diagnostics", "check"], _dq_api(rows)) == (0, "NO_REPLY")


def test_diagnostics_check_reports_each_flagged_check(config: Path) -> None:
    # Regression (2026-11): every order was tagged Whole Foods and a footer ad was imported as a
    # purchase, and nothing said so until the owner printed the pages.
    rows = [
        {
            "check": "store_split",
            "lines": 247,
            "by_store": {"wholefoods": 247},
            "top_share": 1.0,
            "flagged": True,
        },
        {
            "check": "ad_like_name",
            "item": "Amazon Business Card",
            "item_id": "i1",
            "phrase": "business card",
            "planned": True,
        },
        {
            "check": "stale_runout_planned",
            "item": "Pistachios",
            "runout_at": "2025-12-20",
            "days_ago": 315,
            "reason": "runout",
        },
    ]
    code, out = run(config, ["diagnostics", "check"], _dq_api(rows))
    assert code == 0
    assert out.startswith("⚠️ Data check for 2026-W45:")
    assert "100% of 247 receipt lines were tagged wholefoods" in out
    assert (
        "1 item(s) look like ads or account lines, 1 of them in this week's plan: "
        "Amazon Business Card." in out
    )
    assert "Pistachios (315 d)" in out


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


def test_jobs_replies_network_timeout_is_not_posted_as_json(config: Path) -> None:
    """Regression (live 2026-11-10, 2:36 AM): the 5-minute `jobs replies` automation couldn't
    reach the API (`[Errno 60] Operation timed out`) and OpenClaw posted the CLI's raw
    `{"error": "network error: …", "status": 0}` to #pandabase. An outage is silent until it has
    lasted `jobs.outage_alert_minutes`, then one readable ⚠️ line, then ✅ once it's back."""
    down = True
    notes: list[dict[str, Any]] = []

    def notifications(_: Any) -> Any:
        if down:
            raise httpx.ConnectTimeout("[Errno 60] Operation timed out")
        return {"notifications": notes}

    api = FakeApi(
        {
            "GET /api/jobs/notifications": notifications,
            "POST /api/jobs/J1/notified": lambda _: {
                "job": _job("J1", "completed", "paper_receipt", "555")
            },
            "POST /api/telemetry": lambda b: {"accepted": len(b["events"])},
        }
    )
    t0 = datetime(2026, 11, 10, 10, 36, tzinfo=UTC)

    def at(minutes: int) -> tuple[int, Any]:
        argv = ["--config", str(config), "jobs", "replies"]
        env = cli.Env(cli.build_parser().parse_args(argv))
        env.set_api(api.client())
        env.now = lambda: t0 + timedelta(minutes=minutes)
        return cli.run(argv, env)

    assert at(0) == (0, "NO_REPLY")
    assert at(55) == (0, "NO_REPLY")
    code, out = at(60)
    assert code == 0 and out.startswith("⚠️ PandaBase has been unreachable for 60 min")
    assert "no response (network)" in out and "{" not in out
    assert at(65) == (0, "NO_REPLY")  # one alert per outage
    down = False
    notes.append(
        {
            "job": _job("J1", "completed", "paper_receipt", "555"),
            "receipt_id": "R1",
            "review_ids": [],
            "summary": "Trader Joe's receipt: 12 lines, 10 matched.",
        }
    )
    code, out = at(70)
    assert out.split("\n") == [
        "✅ PandaBase is reachable again.",
        "🧾 Trader Joe's receipt: 12 lines, 10 matched.",
    ]
    outage = [e for b in api.bodies("POST /api/telemetry") for e in b["events"]]
    assert [(e["metric_type"], e["payload"]) for e in outage] == [
        ("api_outage", {"command": "jobs replies", "minutes": 70, "alerted": True})
    ]
    notes.clear()
    assert at(75) == (0, "NO_REPLY")
    # A short blip never posts anything, and recovery from it is silent too.
    down = True
    assert at(80) == (0, "NO_REPLY")
    down = False
    assert at(85) == (0, "NO_REPLY")


def test_jobs_replies_posts_only_acknowledged_jobs(config: Path) -> None:
    """A failed `notified` ack mid-batch posts the replies already acked; the rest stay queued
    (before: the whole run printed error JSON and the acked replies were lost)."""
    notes: list[dict[str, Any]] = [
        {
            "job": _job(j, "completed", "paper_receipt", m),
            "receipt_id": None,
            "review_ids": [],
            "summary": f"Receipt {j}.",
        }
        for j, m in (("J1", "555"), ("J2", "556"))
    ]
    api = FakeApi(
        {
            "GET /api/jobs/notifications": lambda _: {"notifications": notes},
            "POST /api/jobs/J1/notified": lambda _: {
                "job": _job("J1", "completed", "paper_receipt", "555")
            },
            "POST /api/jobs/J2/notified": lambda _: httpx.Response(
                503, json={"error": "unavailable"}
            ),
        }
    )
    code, out = run(config, ["jobs", "replies"], api)
    assert code == 0 and out.startswith("[[reply_to:555]] 🧾 Receipt J1.")
    assert "J2" not in out


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


def test_cart_search_and_add_commands(config: Path) -> None:
    """Tier 2 through the guarded tools: search (no clicks), then add one ASIN by id."""
    from pandabase_tools.cart_tier2 import search_url

    api = FakeApi({"POST /api/telemetry": lambda b: {"accepted": len(b["events"])}})
    url = search_url("cake flour", "wholefoods")
    driver = FakeDriver({url: (url, "search_results.html")})
    argv = ["cart", "search", "--query", "cake flour", "--store", "wholefoods", "--limit", "2"]
    code, out = run(config, argv, api, driver)
    assert code == 0, out
    assert [c["asin"] for c in out["candidates"]] == ["B0SYNTH201", "B0SYNTH202"]
    assert driver.clicks == 0

    views = iter(["cart_view.html", "cart_view_after.html"])
    add_driver = FakeDriver(
        lambda u: (
            (u, "product_add_form.html")
            if u == "https://www.amazon.com/dp/B0SYNTH202"
            else ((u, next(views)) if u == VIEW else None)
        )
    )
    argv = ["cart", "add", "--member", "will", "--asin", "B0SYNTH202", "--qty", "1"]
    code, out = run(config, argv, api, add_driver)
    assert code == 0 and out["outcome"] == "added", out
    add_driver.assert_never_checkout()
    metrics = [e["metric_type"] for b in api.bodies("POST /api/telemetry") for e in b["events"]]
    assert metrics == ["cart_tier2_search", "cart_tier2_line"]


def test_cart_add_takes_the_profile_lock(config: Path) -> None:
    code, _ = run(
        config, ["lock", "acquire", "--member", "will", "--owner", "receipts"], FakeApi({})
    )
    assert code == 0
    code, out = run(config, ["cart", "add", "--asin", "B0SYNTH202"], FakeApi({}), FakeDriver({}))
    assert code == 3 and out["owner"] == "receipts"


def test_cart_add_rejects_a_bad_asin(config: Path) -> None:
    code, out = run(config, ["cart", "add", "--asin", "../checkout"], FakeApi({}), FakeDriver({}))
    assert code == 1 and "ASIN" in out["error"]


# --- Scheduled steps that run without a model (cycle_replies) ----------------------------------
# Live 2026-11-06/07: told "Use $grocery-cycle: run the Saturday cart build", the local model never
# opened the skill or ran a pandabase-tools command; it posted a cart made up from old memory notes
# and both automations reported "ok". The build and the nudge are now command automations.


def test_cart_build_reply_is_the_discord_summary(config: Path) -> None:
    server = CycleServer()
    code, out = run(config, ["cart", "build", "--reply"], server.api, _driver())
    assert code == 0 and isinstance(out, str), out
    assert out.startswith("🛒 **Cart built** in <#T1>")
    assert "✅ **Added (2):** oats ×2, towels" in out  # noqa: RUF001
    assert "🔎 **Still to find (1):** candles — I'll search for these at 10:30." in out
    assert "[Amazon](<https://www.amazon.com/gp/cart/view.html>)" in out
    assert "Whole Foods" not in out
    # The tier-2 job reads what's left without touching the browser or re-running the build.
    code, pending = run(config, ["cart", "pending"], server.api)
    assert code == 0 and pending["status"] == "needs_agent"
    assert [(x["index"], x["name"]) for x in pending["needs_agent"]] == [(2, "candles")]
    # Saturday again (a retry): already handled lines aren't re-added; once ready, it's silent.
    run(config, ["cart", "finish", "--cycle-id", "C1", "--outcomes", '{"2": "failed"}'], server.api)
    code, out = run(config, ["cart", "build", "--reply"], server.api, _driver())
    assert (code, out) == (0, "NO_REPLY")
    code, pending = run(config, ["cart", "pending"], server.api)
    assert pending["status"] == "nothing_pending"


def test_cart_build_reply_without_a_cycle_or_when_away(config: Path) -> None:
    api = FakeApi({"GET /api/grocery/cycle/current": lambda _: {"cycle": None}})
    code, out = run(config, ["cart", "build", "--reply"], api, _driver())
    assert (code, out) == (0, "⚠️ No grocery list was open this week, so no cart was built.")
    server = CycleServer()
    server.api.handlers["POST /api/grocery/cycle/C1/status"] = lambda _: {
        "changed": True,
        "cycle": _cycle("skipped"),
    }
    code, out = run(config, ["cart", "build", "--reply"], server.api, _driver())
    assert (code, out) == (0, "⏸️ Away on build day — no cart this week.")


def test_cart_build_reply_when_the_browser_is_busy(config: Path) -> None:
    server = CycleServer()
    run(config, ["lock", "acquire", "--member", "will", "--owner", "receipts"], server.api)
    code, out = run(config, ["cart", "build", "--reply"], server.api, _driver())
    assert code == 0 and out.startswith("⚠️ The cart wasn't built: the cart browser was busy")


def _checkin() -> dict[str, Any]:
    item = {"base_unit": "count", "on_hand": 0, "runout_at": None, "audit_hint": None}
    return {
        "cycle_id": "C1",
        "likely_needed": [
            item | {"item_id": "I1", "name": "milk", "reason": "runout", "status": "low"},
            item | {"item_id": "I2", "name": "eggs", "reason": "runout", "status": "out"},
        ],
        "please_check": [
            item
            | {
                "item_id": "I3",
                "name": "rice",
                "reason": "audit_hint",
                "status": "unknown",
                "audit_hint": "still some left?",
            }
        ],
        "freezer": [
            {
                "item_id": "I4",
                "name": "peas",
                "base_unit": "g",
                "quantity": 500,
                "frozen_at": "2026-09-01T12:00:00Z",
            }
        ],
        "pending_review_count": 3,
    }


def test_cycle_nudge_records_the_nudge_and_prints_the_check_in(config: Path) -> None:
    server = CycleServer()
    server.api.handlers["GET /api/grocery/checkin"] = lambda _: _checkin()
    # The API keeps the cycle open and stamps nudge_sent_at (web/lib/services/cycles.ts).
    nudged = _cycle("open") | {"nudge_sent_at": "2026-10-24T01:00:00Z"}
    server.api.handlers["POST /api/grocery/cycle/C1/status"] = lambda _: {
        "changed": True,
        "cycle": nudged,
    }
    code, out = run(config, ["cycle", "nudge"], server.api)
    assert code == 0 and isinstance(out, str), out
    assert server.api.bodies("POST /api/grocery/cycle/C1/status") == [{"status": "nudged"}]
    assert out.splitlines() == [
        "🛒 **Friday check-in** — I'll fill the cart tomorrow at 10am.",
        "**Likely needed:** milk, eggs (out)",
        "**Please check:** ❓ rice — still some left?",
        "**Freezer:** peas (Sep 1)",
        "3 review items waiting → https://pandabase.example.vercel.app/cleanup",
        'Reply in <#T1> with changes or counts ("6 eggs"), or a photo. No reply needed — I\'ll go '
        "with the plan.",
    ]


def test_cycle_nudge_is_silent_when_already_nudged_and_says_so_without_a_cycle(
    config: Path,
) -> None:
    nudged = _cycle("open") | {"nudge_sent_at": "2026-10-23T01:00:00Z"}
    api = FakeApi({"GET /api/grocery/cycle/current": lambda _: {"cycle": nudged}})
    assert run(config, ["cycle", "nudge"], api) == (0, "NO_REPLY")
    assert api.bodies("POST /api/grocery/cycle/C1/status") == []
    api = FakeApi({"GET /api/grocery/cycle/current": lambda _: {"cycle": None}})
    code, out = run(config, ["cycle", "nudge"], api)
    assert code == 0 and out.startswith("⚠️ No grocery list is open this week")


def test_two_members_cannot_share_a_profile(config: Path) -> None:
    # Giving a second member the one `pandabase` profile would sweep the cart member's Amazon
    # orders as theirs too; the config refuses it.
    data = json.loads(config.read_text())
    data["members"][1]["profile"] = "pandabase"
    config.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="share profile 'pandabase'"):
        load(str(config))


def test_member_without_profile_has_no_browser(config: Path) -> None:
    code, out = run(config, ["cdp", "check", "--member", "partner"], FakeApi({}))
    assert code == 1 and "no PandaBase browser profile" in out["error"]
    code, out = run(config, ["config", "show"], FakeApi({}))
    assert code == 0
    assert {m["name"]: m["cdp_url"] for m in out["members"]} == {
        "will": "http://127.0.0.1:9222",
        "partner": None,
    }
