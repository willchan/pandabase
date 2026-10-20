"""Per-profile lease lock: one driver per Chromium profile at a time (DESIGN §6).

A lease is a JSON file `{owner, pid, expires_at}` in the state dir. The tools take it for the
duration of a command (`pid` = this process); the agent takes it explicitly with
`pandabase-tools lock acquire` before driving the profile through OpenClaw's browser tool for
tier-2 fallback, and releases it after. A lease whose expiry passed or whose process is gone is
stale and may be taken over. Read-modify-write is serialized with `flock` on a sidecar file.
"""

from __future__ import annotations

import fcntl
import json
import os
import secrets
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


class ProfileLocked(Exception):
    def __init__(self, profile: str, owner: str, expires_at: float) -> None:
        super().__init__(f"profile {profile!r} is locked by {owner!r}")
        self.profile = profile
        self.owner = owner
        self.expires_at = expires_at


@dataclass(frozen=True)
class Lease:
    profile: str
    token: str
    owner: str
    expires_at: float


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class ProfileLock:
    def __init__(
        self, state_dir: Path, clock: Callable[[], float] = time.time, pid: int | None = None
    ) -> None:
        self.dir = state_dir / "locks"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.pid = os.getpid() if pid is None else pid

    def _path(self, profile: str) -> Path:
        return self.dir / f"{profile}.lease.json"

    @contextmanager
    def _mutex(self, profile: str) -> Iterator[None]:
        with open(self.dir / f"{profile}.mutex", "a+") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    def _current(self, profile: str) -> dict[str, object] | None:
        try:
            data = json.loads(self._path(profile).read_text())
        except FileNotFoundError, json.JSONDecodeError:
            return None
        if not isinstance(data, dict):
            return None
        expires = float(data.get("expires_at", 0))
        pid = data.get("pid")
        if expires <= self.clock() or (isinstance(pid, int) and not _pid_alive(pid)):
            return None
        return data

    def acquire(self, profile: str, owner: str, ttl_seconds: float, *, hold_pid: bool) -> Lease:
        with self._mutex(profile):
            cur = self._current(profile)
            if cur is not None:
                raise ProfileLocked(profile, str(cur.get("owner")), float(str(cur["expires_at"])))
            lease = Lease(profile, secrets.token_hex(8), owner, self.clock() + ttl_seconds)
            body = {"owner": owner, "token": lease.token, "expires_at": lease.expires_at}
            if hold_pid:
                body["pid"] = self.pid
            self._path(profile).write_text(json.dumps(body))
            return lease

    def release(self, profile: str, token: str) -> bool:
        with self._mutex(profile):
            try:
                data = json.loads(self._path(profile).read_text())
            except FileNotFoundError, json.JSONDecodeError:
                return False
            if data.get("token") != token:
                return False
            self._path(profile).unlink(missing_ok=True)
            return True

    def status(self, profile: str) -> dict[str, object] | None:
        with self._mutex(profile):
            cur = self._current(profile)
        return None if cur is None else {k: v for k, v in cur.items() if k != "token"}

    @contextmanager
    def held(self, profile: str, owner: str, ttl_seconds: float = 3600) -> Iterator[Lease]:
        lease = self.acquire(profile, owner, ttl_seconds, hold_pid=True)
        try:
            yield lease
        finally:
            self.release(profile, lease.token)
