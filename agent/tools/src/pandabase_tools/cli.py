"""`pandabase-tools`: the deterministic commands the OpenClaw skills run (JSON on stdout).

Exit codes: 0 ok · 1 error (`{"error": …}` on stdout) · 2 usage · 3 profile locked ·
4 refused an unsafe (checkout/payment/sign-in/non-Amazon) URL.

Every POST sends an `Idempotency-Key` (`--key` to choose it: the skills pass `discord:<message
id>` so a re-delivered Discord message can't apply twice). Writes a human asked for carry
`--actor <discord id>`. Browser commands take the profile's lock and attach over CDP to the
member's running Chromium; they never launch one, sign in or touch checkout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager
from dataclasses import asdict
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Literal, cast
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ValidationError

from . import api as api_mod
from . import cart_injector, contracts, guard, photos, receipt_parser
from . import config as config_mod
from .browser import CdpDriver, Driver
from .lock import ProfileLock, ProfileLocked
from .telemetry import Telemetry

EXTRACT_NAME = re.compile(r"^[a-z0-9_]+(?:\.jsonl)?$")
WEEK = re.compile(r"^\d{4}-W\d{2}$")


def household_date(tz: str) -> date:
    return datetime.now(ZoneInfo(tz)).date()


class CliError(Exception):
    def __init__(self, payload: dict[str, Any], code: int = 1) -> None:
        super().__init__(payload.get("error"))
        self.payload = payload
        self.code = code


class Env:
    """Lazily built dependencies; tests replace the factories."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self._loaded: config_mod.Loaded | None = None
        self._api: api_mod.ApiClient | None = None
        self.tel = Telemetry()
        self.driver_factory: Callable[[str], AbstractContextManager[Driver]] = lambda cdp_url: (
            CdpDriver(cdp_url)
        )
        self.today: Callable[[], date] | None = None

    @property
    def loaded(self) -> config_mod.Loaded:
        if self._loaded is None:
            self._loaded = config_mod.load(self.args.config)
        return self._loaded

    @property
    def cfg(self) -> config_mod.ToolsConfig:
        return self.loaded.config

    @property
    def api(self) -> api_mod.ApiClient:
        if self._api is None:
            self._api = api_mod.ApiClient(
                self.cfg.api_base_url, os.environ.get(config_mod.TOKEN_ENV, "")
            )
        return self._api

    def set_api(self, client: api_mod.ApiClient) -> None:
        self._api = client

    def lock(self) -> ProfileLock:
        return ProfileLock(self.loaded.state_dir())

    def household_today(self) -> date:
        return self.today() if self.today else household_date(self.cfg.household_tz)


# Helpers ---------------------------------------------------------------------------------------


def _json_arg(value: str | None, file: str | None) -> Any:
    if value is not None and file is not None:
        raise CliError({"error": "pass --json or --input, not both"}, 2)
    if file is not None:
        return json.loads(Path(file).read_text())
    if value is not None:
        return json.loads(value)
    return None


def _model_json(model: BaseModel) -> Any:
    return model.model_dump(mode="json")


# Commands --------------------------------------------------------------------------------------


def cmd_api(env: Env) -> Any:
    a = env.args
    route, _ = api_mod.match_route(a.method, a.path)
    query = dict(kv.split("=", 1) for kv in (a.query or []))
    body = _json_arg(a.json, a.input)
    if route.body is not None:
        body = dict(body or {})
        if a.actor:
            body["actor_discord_id"] = a.actor
        if route.actor == "required" and not body.get("actor_discord_id"):
            raise CliError(
                {"error": f"{a.path} attributes to a human: pass --actor <discord id>"}, 2
            )
    elif body is not None:
        raise CliError({"error": f"{a.method} {a.path} takes no body"}, 2)
    res = env.api.call(a.method, a.path, body=body, query=query, idempotency_key=a.key)
    return _model_json(res)


def _member(env: Env, name: str | None) -> config_mod.Member:
    """The named member, or the cart member when no name is given."""
    try:
        return env.cfg.member(name) if name else env.cfg.cart_member()
    except KeyError as err:
        raise CliError({"error": str(err).strip("'\"")}) from err


def cmd_cart_build(env: Env) -> Any:
    a = env.args
    member = _member(env, a.member)
    cycle_id = a.cycle_id
    if not cycle_id:
        cur = env.api.call("GET", "/api/grocery/cycle/current")
        cycle = getattr(cur, "cycle", None)
        if cycle is None:
            return {"status": "no_cycle"}
        cycle_id = cycle.id
    state = cart_injector.BuildState(env.loaded.state_dir(), cycle_id)
    profile = env.loaded.profile(member)
    with env.lock().held(member.profile, "cart build"):
        return cart_injector.build(
            env.api,
            lambda: env.driver_factory(profile.cdp_url),
            env.cfg.cart,
            cycle_id,
            state,
            env.tel,
        )


def cmd_cart_finish(env: Env) -> Any:
    a = env.args
    raw = _json_arg(a.outcomes, None) or {}
    tier2: dict[int, Literal["tier2", "failed"]] = {}
    for k, v in raw.items():
        if v not in ("tier2", "failed"):
            raise CliError({"error": f"outcome for line {k} must be tier2 or failed"}, 2)
        tier2[int(k)] = v
    state = cart_injector.BuildState(env.loaded.state_dir(), a.cycle_id)
    try:
        return cart_injector.finish(env.api, a.cycle_id, state, tier2, a.order_id or None)
    except ValueError as err:
        raise CliError({"error": str(err)}) from err


def cmd_cart_url(env: Env) -> Any:
    items = []
    for spec in env.args.asin:
        asin, _, qty = spec.partition(":")
        items.append((asin, int(qty or "1")))
    return {"url": cart_injector.add_url(items)}


def cmd_receipts_sweep(env: Env) -> Any:
    a = env.args
    member = _member(env, a.member)
    profile = env.loaded.profile(member)
    tz = env.cfg.household_tz
    today = env.household_today()
    owner = f"receipts {'backfill' if a.backfill else 'sweep'}"
    with env.lock().held(member.profile, owner), env.driver_factory(profile.cdp_url) as driver:
        sweeper = receipt_parser.Sweeper(
            env.api,
            driver,
            env.cfg.receipts,
            member,
            tz,
            env.loaded.state_dir(),
            env.tel,
            today=today,
        )
        result = sweeper.run("backfill" if a.backfill else "sweep", max_orders=a.max_orders)
    return asdict(result)


def cmd_receipts_ingest(env: Env) -> Any:
    """A receipt the agent extracted from `needs_agent_extraction` text: ingest + mark done."""
    a = env.args
    member = _member(env, a.member)
    body = _json_arg(a.json, a.input) or {}
    body.setdefault("source", "digital")
    body.setdefault("account", member.discord_id)
    body["actor_discord_id"] = member.discord_id
    req = contracts.ReceiptIngestRequest.model_validate(body)
    oid = req.external_order_id
    key = f"receipt:{member.discord_id}:{oid}" if oid else None
    res = env.api.ingest_receipt(req, key=key)
    if oid:
        sweeper_state = env.loaded.state_dir() / f"receipts-{member.name}.json"
        state = receipt_parser.SweepState.load(sweeper_state)
        state.done[oid] = datetime.now(UTC).isoformat()
        state.save(sweeper_state)
    return _model_json(res)


def cmd_photo_submit(env: Env) -> Any:
    a = env.args
    basis: photos.Basis | Literal["human"]
    if a.job_type:
        job_type, basis = a.job_type, "human"
    else:
        cls = photos.classify(a.caption, a.description)
        job_type, basis = cls.job_type, cls.basis
    if not a.file and not a.media_key:
        raise CliError({"error": "pass --file (new photo) or --media-key (re-file)"}, 2)
    return photos.submit(
        env.api,
        env.tel,
        file=Path(a.file or ""),
        actor=a.actor,
        channel_id=a.channel_id,
        message_id=a.message_id,
        job_type=job_type,
        basis=basis,
        cycle_id=a.cycle_id,
        media_r2_key=a.media_key,
    )


def cmd_photo_classify(env: Env) -> Any:
    cls = photos.classify(env.args.caption, env.args.description)
    return {"job_type": cls.job_type, "basis": cls.basis}


def summary_lines(markdown: str, limit: int = 3) -> list[str]:
    lines = markdown.splitlines()
    try:
        start = next(i for i, x in enumerate(lines) if re.match(r"^##\s+1\.\s+Summary", x))
    except StopIteration:
        return []
    out: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("## "):
            break
        m = re.match(r"^\s*(?:\d+\.|[-*])\s+(.*)", line)
        if m:
            out.append(m.group(1).strip())
    return out[:limit]


def cmd_diagnostics_write(env: Env) -> Any:
    a = env.args
    if a.week and not WEEK.match(a.week):
        raise CliError({"error": "--week must look like 2026-W42"}, 2)
    res = env.api.diagnostics(a.week)
    if not WEEK.match(res.week):
        raise CliError({"error": f"unexpected week label {res.week!r}"})
    root = Path(a.dir or env.cfg.diagnostics_dir).expanduser()
    week_dir = root / res.week
    week_dir.mkdir(parents=True, exist_ok=True)
    report = root / f"{res.week}.md"
    report.write_text(res.markdown)
    files = [str(report)]
    for ex in res.extracts:
        if not EXTRACT_NAME.match(ex.name):
            raise CliError({"error": f"unexpected extract name {ex.name!r}"})
        name = ex.name if ex.name.endswith(".jsonl") else ex.name + ".jsonl"
        path = week_dir / name
        path.write_text(ex.jsonl if ex.jsonl.endswith("\n") or not ex.jsonl else ex.jsonl + "\n")
        files.append(str(path))
    return {"week": res.week, "files": files, "summary": summary_lines(res.markdown)}


def reply_line(n: contracts.JobNotification, web_url: str | None) -> str:
    job = n.job
    if job.status == "failed":
        why = (job.error or n.summary).strip().rstrip(".")
        where = f" ({web_url.rstrip('/')}/cleanup)" if web_url else ""
        return f"⚠️ Couldn't read that photo: {why}. It's under Cleanup → failed jobs{where}."
    icon = "🧾" if job.job_type == "paper_receipt" else "🗑️"
    review = ""
    if n.review_ids and web_url:
        review = f" → {len(n.review_ids)} to review: {web_url.rstrip('/')}/cleanup"
    return f"{icon} {n.summary.strip()}{review}"


def cmd_jobs_replies(env: Env) -> str:
    """Plain text for an OpenClaw command automation: the replies to post, or `NO_REPLY`."""
    res = env.api.call("GET", "/api/jobs/notifications")
    assert isinstance(res, contracts.JobNotificationsResponse)
    notes = res.notifications[: env.args.limit]
    if not notes:
        return "NO_REPLY"
    guild = env.cfg.discord.guild_id
    lines: list[str] = []
    for n in notes:
        text = reply_line(n, env.cfg.web_url)
        job = n.job
        if len(notes) > 1 and job.discord_channel_id and job.discord_message_id:
            link = f"https://discord.com/channels/{guild}/{job.discord_channel_id}/{job.discord_message_id}"
            text = f"{text} ({link})"
        lines.append(text)
        env.api.call(
            "POST", f"/api/jobs/{job.id}/notified", body={}, idempotency_key=f"notified:{job.id}"
        )
    only = notes[0].job
    if len(notes) == 1 and only.discord_message_id:
        return f"[[reply_to:{only.discord_message_id}]] {lines[0]}"
    return "\n".join(lines)


def cmd_telemetry_emit(env: Env) -> Any:
    payload = _json_arg(env.args.payload, None) or {}
    if not isinstance(payload, dict):
        raise CliError({"error": "--payload must be a JSON object"}, 2)
    env.tel.emit(env.args.metric, **payload)
    return {"queued": 1}


def cmd_lock(env: Env) -> Any:
    a = env.args
    member = _member(env, a.member)
    lock = env.lock()
    if a.lock_cmd == "acquire":
        lease = lock.acquire(member.profile, a.owner, a.ttl, hold_pid=False)
        return {"profile": lease.profile, "token": lease.token, "expires_at": lease.expires_at}
    if a.lock_cmd == "release":
        return {"released": lock.release(member.profile, a.token)}
    return {"profile": member.profile, "lease": lock.status(member.profile)}


def cmd_cdp_check(env: Env) -> Any:
    """Attach to a member's Chromium and open the cart page (read-only; smoke check)."""
    member = _member(env, env.args.member)
    profile = env.loaded.profile(member)
    with (
        env.lock().held(member.profile, "cdp check"),
        env.driver_factory(profile.cdp_url) as driver,
    ):
        snap = driver.open("https://www.amazon.com/gp/cart/view.html")
    return {"member": member.name, "profile": member.profile, "url": snap.url, "attached": True}


def cmd_config_show(env: Env) -> Any:
    cfg = env.cfg
    return {
        "config_path": env.loaded.config_path,
        "api_base_url": cfg.api_base_url,
        "household_tz": cfg.household_tz,
        "today": env.household_today().isoformat(),
        "channels": cfg.discord.model_dump(),
        "members": [
            m.model_dump() | {"cdp_url": env.loaded.profile(m).cdp_url} for m in cfg.members
        ],
        "token_set": bool(os.environ.get(config_mod.TOKEN_ENV)),
    }


# Parser ----------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pandabase-tools", description=__doc__.split("\n")[0])
    p.add_argument("--config", help=f"pandabase.config.json (default ${config_mod.CONFIG_ENV})")
    sub = p.add_subparsers(dest="group", required=True)

    api_p = sub.add_parser("api", help="call one agent API route (contract-validated)")
    api_p.add_argument("method", choices=["get", "post", "GET", "POST"])
    api_p.add_argument("path")
    api_p.add_argument("-q", "--query", action="append", metavar="K=V")
    api_p.add_argument("--json")
    api_p.add_argument("--input", metavar="FILE")
    api_p.add_argument("--actor", metavar="DISCORD_ID")
    api_p.add_argument("--key", metavar="IDEMPOTENCY_KEY")
    api_p.set_defaults(fn=cmd_api)

    cart = sub.add_parser("cart").add_subparsers(dest="cmd", required=True)
    b = cart.add_parser("build", help="Saturday build: price checks → tier 1 → cart result")
    b.add_argument("--cycle-id")
    b.add_argument("--member", help="default: the cart member")
    b.set_defaults(fn=cmd_cart_build)
    f = cart.add_parser("finish", help="post the cart result after tier-2 fallback")
    f.add_argument("--cycle-id", required=True)
    f.add_argument("--outcomes", help='{"<line index>": "tier2"|"failed"}')
    f.add_argument("--order-id", action="append")
    f.set_defaults(fn=cmd_cart_finish)
    u = cart.add_parser("url", help="print the tier-1 add-to-cart URL (smoke)")
    u.add_argument("asin", nargs="+", metavar="ASIN[:QTY]")
    u.set_defaults(fn=cmd_cart_url)

    rec = sub.add_parser("receipts").add_subparsers(dest="cmd", required=True)
    s = rec.add_parser("sweep", help="ingest final orders newer than the cursor (or --backfill)")
    s.add_argument("--member", required=True)
    s.add_argument("--backfill", action="store_true")
    s.add_argument("--max-orders", type=int)
    s.set_defaults(fn=cmd_receipts_sweep)
    i = rec.add_parser("ingest", help="ingest a receipt the agent extracted from page text")
    i.add_argument("--member", required=True)
    i.add_argument("--json")
    i.add_argument("--input", metavar="FILE")
    i.set_defaults(fn=cmd_receipts_ingest)

    ph = sub.add_parser("photo").add_subparsers(dest="cmd", required=True)
    ps = ph.add_parser("submit", help="classify, upload and create the audit job")
    ps.add_argument("--file")
    ps.add_argument("--media-key", help="re-file an uploaded photo (with --job-type)")
    ps.add_argument("--actor", required=True)
    ps.add_argument("--caption")
    ps.add_argument("--description", help="local (Ollama) image description, if any")
    ps.add_argument("--job-type", choices=["paper_receipt", "trash_cam"], help="human's choice")
    ps.add_argument("--channel-id")
    ps.add_argument("--message-id")
    ps.add_argument("--cycle-id")
    ps.set_defaults(fn=cmd_photo_submit)
    pc = ph.add_parser("classify")
    pc.add_argument("--caption")
    pc.add_argument("--description")
    pc.set_defaults(fn=cmd_photo_classify)

    d = sub.add_parser("diagnostics").add_subparsers(dest="cmd", required=True)
    dw = d.add_parser("write", help="fetch the weekly report and write /diagnostics")
    dw.add_argument("--week")
    dw.add_argument("--dir")
    dw.set_defaults(fn=cmd_diagnostics_write)

    jb = sub.add_parser("jobs").add_subparsers(dest="cmd", required=True)
    jr = jb.add_parser("replies", help="text replies for finished photo jobs (or NO_REPLY)")
    jr.add_argument("--limit", type=int, default=10)
    jr.set_defaults(fn=cmd_jobs_replies)

    t = sub.add_parser("telemetry").add_subparsers(dest="cmd", required=True)
    te = t.add_parser("emit")
    te.add_argument("metric")
    te.add_argument("--payload", help="JSON object")
    te.set_defaults(fn=cmd_telemetry_emit)

    lk = sub.add_parser("lock", help="per-profile lease (tier-2 browser work)")
    lk_sub = lk.add_subparsers(dest="lock_cmd", required=True)
    la = lk_sub.add_parser("acquire")
    la.add_argument("--member", required=True)
    la.add_argument("--owner", default="agent")
    la.add_argument("--ttl", type=float, default=900)
    lr = lk_sub.add_parser("release")
    lr.add_argument("--member", required=True)
    lr.add_argument("--token", required=True)
    ls = lk_sub.add_parser("status")
    ls.add_argument("--member", required=True)
    lk.set_defaults(fn=cmd_lock)

    cdp = sub.add_parser("cdp").add_subparsers(dest="cmd", required=True)
    cc = cdp.add_parser("check", help="attach to a member's Chromium (smoke)")
    cc.add_argument("--member", required=True)
    cc.set_defaults(fn=cmd_cdp_check)

    cfg = sub.add_parser("config").add_subparsers(dest="cmd", required=True)
    cfg.add_parser("show").set_defaults(fn=cmd_config_show)
    return p


def run(argv: Sequence[str] | None = None, env: Env | None = None) -> tuple[int, Any]:
    args = build_parser().parse_args(argv)
    if hasattr(args, "method"):
        args.method = args.method.upper()
    env = env or Env(args)
    env.args = args
    code, out = 0, None
    try:
        out = cast(Callable[[Env], Any], args.fn)(env)
    except CliError as err:
        code, out = err.code, err.payload
    except ProfileLocked as err:
        code, out = 3, {"error": "profile_locked", "profile": err.profile, "owner": err.owner}
    except guard.UnsafeUrl as err:
        code, out = 4, {"error": "refused_url", "reason": err.reason, "url": err.url}
    except api_mod.ApiError as err:
        code, out = 1, err.as_json()
    except ValidationError as err:
        code, out = 1, {"error": "invalid", "details": api_mod.validation_details(err)}
    except (KeyError, ValueError, FileNotFoundError) as err:
        code, out = 1, {"error": str(err).strip("'\"")}
    finally:
        if env._api is not None or env.tel.events:
            try:
                env.tel.flush(env.api)
            except Exception as err:
                print(f"telemetry dropped: {err}", file=sys.stderr)
    return code, out


def main(argv: Sequence[str] | None = None) -> int:
    code, out = run(argv)
    print(out if isinstance(out, str) else json.dumps(out, indent=1, default=str))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
