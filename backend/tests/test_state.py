"""Unit tests for the in-memory ServiceSnapshot."""

from __future__ import annotations

import asyncio

import pytest

from app.models import ServiceStatus
from app.state import ServiceSnapshot


def _mkstatus(sid: str, status: str = "ok") -> ServiceStatus:
    return ServiceStatus(
        id=sid,
        name=sid,
        sub="",
        icon="cloud",
        desc="",
        status=status,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_empty_snapshot_returns_none():
    snap = ServiceSnapshot()
    results, ts = await snap.get()
    assert results is None
    assert ts == 0.0


@pytest.mark.asyncio
async def test_set_then_get_roundtrip():
    snap = ServiceSnapshot()
    await snap.set([_mkstatus("vault"), _mkstatus("cloud", "warn")])
    results, ts = await snap.get()
    assert results is not None
    assert [r.id for r in results] == ["vault", "cloud"]
    assert ts > 0.0


@pytest.mark.asyncio
async def test_get_returns_a_copy():
    """Mutating the returned list must not mutate the stored snapshot."""
    snap = ServiceSnapshot()
    await snap.set([_mkstatus("vault")])
    first, _ = await snap.get()
    assert first is not None
    first.clear()
    second, _ = await snap.get()
    assert second is not None
    assert len(second) == 1


@pytest.mark.asyncio
async def test_wait_for_tick_returns_after_timeout():
    snap = ServiceSnapshot()
    # No refresh signal — the wait should fall through after the interval.
    await asyncio.wait_for(snap.wait_for_tick(0.05), timeout=1.0)


@pytest.mark.asyncio
async def test_wait_for_tick_returns_early_on_refresh():
    snap = ServiceSnapshot()

    async def fire_refresh():
        await asyncio.sleep(0.02)
        snap.request_refresh()

    asyncio.create_task(fire_refresh())
    # If the event wasn't honoured, the 10s timeout would fire instead.
    await asyncio.wait_for(snap.wait_for_tick(10.0), timeout=1.0)
