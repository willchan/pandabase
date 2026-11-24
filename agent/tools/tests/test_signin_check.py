"""`cdp signin` (signin_check.py): synthetic cookie jars, no browser."""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from conftest import REPO, FakeApi

from pandabase_tools import cli, signin_check
from pandabase_tools.config import SigninConfig
from pandabase_tools.signin_check import Jar
from pandabase_tools.telemetry import Telemetry

T0 = datetime(2026, 11, 21, 5, 0, tzinfo=UTC)  # Fri 21:00 PST
SITES = {"amazon": ["at-main", "sess-at-main"], "costco": ["x-ms-cpim-sso:*"]}


def jar(launch: str = "L1", *, amazon: bool = True, costco: bool = True, extra: int = 40) -> Jar:
    names: dict[str, set[str]] = {"example.org": {f"c{i}" for i in range(extra)}}
    names["amazon.com"] = {"session-id", "ubid-main"} | ({"at-main", "x-main"} if amazon else set())
    names["www.costco.com"] = {"JSESSIONID"}
    if costco:
        names["signin.costco.com"] = {"x-ms-cpim-sso:tenant.onmicrosoft.com_0"}
    count = sum(len(v) for v in names.values())
    return Jar(launch=launch, version="157.0.8103.51", cookies=count, names=names)


class Checker:
    def __init__(self, tmp_path: Path) -> None:
        self.path = tmp_path / "signin-pandabase.json"
        self.tel = Telemetry()
        self.now = T0

    def __call__(self, seen: Jar | Exception) -> signin_check.CheckResult:
        def read(_url: str) -> Jar:
            if isinstance(seen, Exception):
                raise seen
            return seen

        return signin_check.check(
            profile="pandabase",
            cdp_url="http://127.0.0.1:9222",
            sites=SITES,
            cfg=SigninConfig(),
            state_path=self.path,
            tel=self.tel,
            now=self.now,
            tz="America/Los_Angeles",
            read=read,
        )


def test_signed_in_matches_names_and_prefixes_on_the_domain_only() -> None:
    j = jar(amazon=True, costco=True)
    assert signin_check.signed_in(j, "amazon.com", ["at-main"])
    assert signin_check.signed_in(j, "costco.com", ["x-ms-cpim-sso:*"])
    assert not signin_check.signed_in(j, "costco.com", ["at-main"])
    # A look-alike domain doesn't count.
    other = Jar("L", "1", 1, {"notamazon.com": {"at-main"}})
    assert not signin_check.signed_in(other, "amazon.com", ["at-main"])


def test_signed_in_profile_stays_silent(tmp_path: Path) -> None:
    check = Checker(tmp_path)
    r = check(jar())
    assert r.reply() == "NO_REPLY"
    assert r.signed_out == []
    assert check.tel.events == []  # nothing changed: no telemetry every hour


# Bug (live 2026-11-21..23): Amazon was signed out after a reboot; the 21:00 sweep failed
# `not_signed_in` night after night and the skill posted once a week. Now: at once, then daily.
def test_sign_out_posts_at_once_then_daily_then_once_back(tmp_path: Path) -> None:
    check = Checker(tmp_path)
    check(jar())
    check.now = T0 + timedelta(hours=1)
    r = check(jar(amazon=False))
    assert r.signed_out == ["amazon"]
    assert len(r.lines) == 1
    assert "Amazon is signed out in the pandabase browser" in r.lines[0]
    assert "since Fri 11/20 22:00" in r.lines[0]
    assert check.tel.metrics("signin_check")[-1]["changed"] == ["amazon_out"]
    # The hours after: quiet.
    for h in range(2, 25):
        check.now = T0 + timedelta(hours=h)
        assert check(jar(amazon=False)).reply() == "NO_REPLY"
    # A day after the first post: again, still "since" the first one.
    check.now = T0 + timedelta(hours=25)
    again = check(jar(amazon=False))
    assert len(again.lines) == 1 and "since Fri 11/20 22:00" in again.lines[0]
    check.now = T0 + timedelta(hours=26)
    back = check(jar())
    assert back.lines == ["✅ Amazon is signed in again in the pandabase browser."]
    check.now = T0 + timedelta(hours=27)
    assert check(jar()).reply() == "NO_REPLY"


def test_costco_is_checked_separately(tmp_path: Path) -> None:
    check = Checker(tmp_path)
    r = check(jar(costco=False))
    assert r.signed_out == ["costco"]
    assert "Costco is signed out" in r.lines[0]


# Bug (live 2026-11-21): the reboot, also Chrome's first launch on 158, came back with an empty
# cookie jar and nothing said so.
def test_restart_that_wipes_the_jar_is_reported_once(tmp_path: Path) -> None:
    check = Checker(tmp_path)
    check(jar("L1"))
    before = jar("L1").cookies
    wiped = Jar("L2", "158.0.8127.36", 3, {"amazon.com": {"session-id", "ubid-main", "i18n-prefs"}})
    check.now = T0 + timedelta(hours=1)
    r = check(wiped)
    assert r.restarted and r.wiped
    assert r.lines[0].startswith(
        f"⚠️ Chrome in the pandabase browser restarted (Chrome 157.0.8103.51 → 158.0.8127.36) "
        f"and kept 3 of its {before} cookies"
    )
    assert any("Amazon is signed out" in x for x in r.lines)
    tel = check.tel.metrics("signin_check")[-1]
    assert tel["wiped"] is True and tel["cookies"] == 3 and tel["cookies_before"] == before
    # The next hour, same launch: no second wipe line.
    check.now = T0 + timedelta(hours=2)
    assert not check(wiped).wiped


def test_restart_that_keeps_the_jar_is_quiet_but_recorded(tmp_path: Path) -> None:
    check = Checker(tmp_path)
    check(jar("L1"))
    r = check(jar("L2"))
    assert r.restarted and not r.wiped and r.reply() == "NO_REPLY"
    assert check.tel.metrics("signin_check")[-1]["restarted"] is True


def test_browser_not_answering_posts_then_recovers(tmp_path: Path) -> None:
    check = Checker(tmp_path)
    r = check(ConnectionRefusedError("refused"))
    assert r.error == "ConnectionRefusedError"
    assert "browser on the Mac Mini isn't answering" in r.lines[0]
    check.now = T0 + timedelta(hours=1)
    assert check(ConnectionRefusedError("refused")).reply() == "NO_REPLY"
    back = check(jar())
    assert back.lines == ["✅ The pandabase browser on the Mac Mini is answering again."]


def test_state_never_holds_cookie_names(tmp_path: Path) -> None:
    check = Checker(tmp_path)
    check(jar(amazon=False))
    text = check.path.read_text()
    assert "at-main" not in text and "session-id" not in text


@pytest.fixture
def config(tmp_path: Path) -> Path:
    for name in ("pandabase.config.example.json", "profiles.example.json"):
        shutil.copy(REPO / "agent" / name, tmp_path / name.replace(".example", ""))
    cfg = tmp_path / "pandabase.config.json"
    data = json.loads(cfg.read_text())
    data["state_dir"] = str(tmp_path / "state")
    data["receipts"]["costco"] = {"orders_url": "https://www.costco.com/myaccount/"}
    cfg.write_text(json.dumps(data))
    return cfg


def test_cli_checks_the_cart_members_profile_for_both_sites(config: Path) -> None:
    argv = ["--config", str(config), "cdp", "signin", "--reply"]
    env = cli.Env(cli.build_parser().parse_args(argv))
    api = FakeApi({"POST /api/telemetry": lambda b: {"accepted": len(b["events"])}})
    env.set_api(api.client())
    env.now = lambda: T0
    seen: list[str] = []

    def read(url: str) -> Jar:
        seen.append(url)
        return jar(amazon=False, costco=False)

    env.jar_source = read
    code, out = cli.run(argv, env)
    assert code == 0
    assert seen == ["http://127.0.0.1:9222"]  # one profile, read once
    assert "Amazon is signed out" in out and "Costco is signed out" in out
    assert any(r.url.path == "/api/telemetry" for r in api.requests)
