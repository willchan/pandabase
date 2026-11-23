"""Hourly sign-in check of the PandaBase browser (`cdp signin`, DESIGN §6).

Reads the cookie *names* of the running Chrome over CDP, without opening a tab or loading any
page, and says whether Amazon (and Costco, once its sweep is set up) is still signed in. A sweep
only finds out when it runs (once a day for Amazon, weekly for Costco), and its warning went out
at most once a week: after the Mac rebooted on 2026-11-21 the profile came back with no cookies
at all, and the Amazon sweep failed `not_signed_in` night after night with one post.

Posts (to the ops channel, via the command job's stdout):

- ⚠️ as soon as a site is signed out, then again every `signin.repeat_hours` while it stays so;
- ✅ once it is signed in again;
- ⚠️ once when Chrome restarted and its cookie jar lost at least `signin.wipe_share` of its
  cookies (the 2026-11-21 reboot, also Chrome's first launch on a new major version, kept none).

Cookie values never leave this module: only names are compared, and only counts are stored or
sent as telemetry (`signin_check`, when something changed).
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .config import SigninConfig
from .telemetry import Telemetry

SITE_LABELS = {"amazon": "Amazon", "costco": "Costco"}
BROWSER = "browser"  # the state key for "Chrome isn't answering on its CDP port"


@dataclass(frozen=True)
class Jar:
    """What one read of the running Chrome saw. `launch` changes with every Chrome start (the
    DevTools browser id in `/json/version`)."""

    launch: str
    version: str
    cookies: int
    names: dict[str, set[str]]  # cookie domain (no leading dot) → cookie names


JarSource = Callable[[str], Jar]  # cdp_url → Jar (tests pass a synthetic one)


def read_jar(cdp_url: str, *, timeout_s: float = 15) -> Jar:
    """The running Chrome's cookie names, over CDP. Opens no tab and loads no page."""
    from playwright.sync_api import sync_playwright

    with urllib.request.urlopen(f"{cdp_url.rstrip('/')}/json/version", timeout=timeout_s) as r:
        info = json.load(r)
    launch = str(info.get("webSocketDebuggerUrl", "")).rsplit("/", 1)[-1]
    version = str(info.get("Browser", "")).split("/", 1)[-1]
    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(cdp_url, timeout=timeout_s * 1000)
        if not browser.contexts:
            raise RuntimeError(f"no browser context at {cdp_url}")
        cookies = browser.contexts[0].cookies()
    names: dict[str, set[str]] = {}
    for c in cookies:
        names.setdefault(str(c.get("domain", "")).lstrip("."), set()).add(str(c.get("name", "")))
    return Jar(launch=launch, version=version, cookies=len(cookies), names=names)


def signed_in(jar: Jar, domain: str, auth_cookies: list[str]) -> bool:
    """A cookie for `domain` (or a subdomain) is named like one of `auth_cookies`; a name ending
    in `*` is a prefix (Costco's sign-in cookie carries its tenant in its name)."""
    for host, names in jar.names.items():
        if host != domain and not host.endswith("." + domain):
            continue
        for want in auth_cookies:
            if want.endswith("*"):
                if any(n.startswith(want[:-1]) for n in names):
                    return True
            elif want in names:
                return True
    return False


@dataclass
class SiteState:
    since: str | None = None  # first check that found it signed out
    alerted_at: str | None = None  # last ⚠️ posted for it


@dataclass
class CheckState:
    launch: str | None = None
    version: str | None = None
    cookies: int | None = None
    sites: dict[str, SiteState] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> CheckState:
        try:
            data = json.loads(path.read_text())
        except FileNotFoundError, ValueError:
            return cls()
        return cls(
            launch=data.get("launch"),
            version=data.get("version"),
            cookies=data.get("cookies"),
            sites={k: SiteState(**v) for k, v in dict(data.get("sites", {})).items()},
        )

    def save(self, path: Path) -> None:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "launch": self.launch,
                    "version": self.version,
                    "cookies": self.cookies,
                    "sites": {k: v.__dict__ for k, v in self.sites.items()},
                },
                indent=1,
            )
        )
        tmp.replace(path)


@dataclass
class CheckResult:
    profile: str
    lines: list[str] = field(default_factory=list)
    signed_out: list[str] = field(default_factory=list)
    restarted: bool = False
    wiped: bool = False
    error: str | None = None
    jar: Jar | None = None

    def reply(self) -> str:
        return "\n".join(self.lines) if self.lines else "NO_REPLY"

    def as_json(self) -> dict[str, Any]:
        return {
            "profile": self.profile,
            "signed_out": self.signed_out,
            "restarted": self.restarted,
            "wiped": self.wiped,
            "error": self.error,
            "chrome_version": self.jar.version if self.jar else None,
            "cookies": self.jar.cookies if self.jar else None,
            "reply": self.reply(),
        }


def _when(iso: str, tz: str) -> str:
    t = datetime.fromisoformat(iso).astimezone(ZoneInfo(tz))
    return f"{t:%a} {t.month}/{t.day} {t:%H:%M}"


def check(
    *,
    profile: str,
    cdp_url: str,
    sites: dict[str, list[str]],
    cfg: SigninConfig,
    state_path: Path,
    tel: Telemetry,
    now: datetime,
    tz: str,
    read: JarSource = read_jar,
) -> CheckResult:
    """One check of `profile`'s Chrome. `sites`: site key ("amazon", "costco") → its auth cookie
    names. Updates `state_path`; the lines to post are in `result.lines`."""
    state = CheckState.load(state_path)
    result = CheckResult(profile)
    repeat = timedelta(hours=cfg.repeat_hours)
    changed: list[str] = []
    before = state.cookies or 0

    def down(key: str, line: str) -> None:
        s = state.sites.setdefault(key, SiteState())
        if s.since is None:
            s.since = now.isoformat()
            changed.append(f"{key}_out")
        if s.alerted_at is None or now - datetime.fromisoformat(s.alerted_at) >= repeat:
            s.alerted_at = now.isoformat()
            result.lines.append(line.format(since=_when(s.since, tz)))

    def up(key: str, line: str) -> None:
        s = state.sites.pop(key, None)
        if s is not None and s.since is not None:
            changed.append(f"{key}_back")
            if s.alerted_at is not None:
                result.lines.append(line)

    try:
        jar = read(cdp_url)
    except Exception as err:
        result.error = type(err).__name__
        down(
            BROWSER,
            f"⚠️ The {profile} browser on the Mac Mini isn't answering (since {{since}}) — "
            "receipt sweeps and cart builds can't run. `make install-chromium` there restarts it.",
        )
    else:
        result.jar = jar
        up(BROWSER, f"✅ The {profile} browser on the Mac Mini is answering again.")
        result.restarted = state.launch is not None and jar.launch != state.launch
        result.wiped = (
            result.restarted
            and before >= cfg.wipe_min_cookies
            and jar.cookies <= before * (1 - cfg.wipe_share)
        )
        if result.wiped:
            versions = (
                f"{state.version} → {jar.version}" if state.version != jar.version else jar.version
            )
            result.lines.append(
                f"⚠️ Chrome in the {profile} browser restarted (Chrome {versions}) and kept "
                f"{jar.cookies} of its {before} cookies: sign-ins are lost. The launch lines in "
                "its log (com.pandabase.chromium.*.log) show what it had before it started."
            )
        for key, auth in sites.items():
            label = SITE_LABELS.get(key, key)
            if signed_in(jar, f"{key}.com", auth):
                up(key, f"✅ {label} is signed in again in the {profile} browser.")
            else:
                result.signed_out.append(key)
                down(
                    key,
                    f"⚠️ {label} is signed out in the {profile} browser on the Mac Mini (since "
                    "{since}) — please sign in there (`HEADED=1 make install-chromium`, then "
                    "Screen Sharing; docs/SETUP-MAC.md). Its receipts wait until then.",
                )
        state.launch, state.version, state.cookies = jar.launch, jar.version, jar.cookies
    if result.restarted or changed or result.lines:
        tel.emit(
            "signin_check",
            profile=profile,
            restarted=result.restarted,
            wiped=result.wiped,
            chrome_version=result.jar.version if result.jar else None,
            cookies=result.jar.cookies if result.jar else None,
            cookies_before=before if result.restarted else None,
            changed=changed,
            signed_out=result.signed_out,
            error=result.error,
            alerted=bool(result.lines),
        )
    state.save(state_path)
    return result


def sites_for(cfg: SigninConfig, *, costco: bool) -> dict[str, list[str]]:
    """The sites a profile's check covers: Amazon on every PandaBase profile; Costco on the one
    the Costco sweep uses (the cart member's) once `receipts.costco.orders_url` is set."""
    out = {"amazon": cfg.amazon_cookies}
    if costco:
        out["costco"] = cfg.costco_cookies
    return out
