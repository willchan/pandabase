from __future__ import annotations

from pathlib import Path

import pytest

from pandabase_tools.lock import ProfileLock, ProfileLocked


def test_one_driver_per_profile(tmp_path: Path) -> None:
    now = [1000.0]
    lock = ProfileLock(tmp_path, clock=lambda: now[0])
    with lock.held("will", "cart build"):
        with pytest.raises(ProfileLocked) as err:
            lock.acquire("will", "receipts sweep", 60, hold_pid=True)
        assert err.value.owner == "cart build"
        lock.acquire("partner", "receipts sweep", 60, hold_pid=True)  # other profile is free
    lease = lock.acquire("will", "tier2", 60, hold_pid=False)
    assert lock.status("will") == {"owner": "tier2", "expires_at": 1060.0}
    assert not lock.release("will", "wrong-token")
    assert lock.release("will", lease.token)
    assert lock.status("will") is None


def test_expired_or_dead_leases_are_stale(tmp_path: Path) -> None:
    now = [1000.0]
    ProfileLock(tmp_path, clock=lambda: now[0]).acquire("will", "agent", 60, hold_pid=False)
    now[0] = 1061.0
    ProfileLock(tmp_path, clock=lambda: now[0]).acquire("will", "next", 60, hold_pid=False)
    # A lease held by a process that no longer exists is stale too.
    dead = ProfileLock(tmp_path / "b", pid=2**22 + 12345)
    dead.acquire("will", "crashed", 3600, hold_pid=True)
    ProfileLock(tmp_path / "b").acquire("will", "after crash", 60, hold_pid=True)
