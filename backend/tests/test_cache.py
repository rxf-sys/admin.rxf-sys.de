from __future__ import annotations

import asyncio

import pytest

from app.cache import TTLCache


@pytest.mark.asyncio
async def test_get_or_set_caches_value():
    cache = TTLCache[str]()
    calls = 0

    async def load() -> str:
        nonlocal calls
        calls += 1
        return "x"

    a = await cache.get_or_set("k", 60, load)
    b = await cache.get_or_set("k", 60, load)
    assert a == b == "x"
    assert calls == 1


@pytest.mark.asyncio
async def test_ttl_zero_means_already_expired():
    cache = TTLCache[int]()
    calls = 0

    async def load() -> int:
        nonlocal calls
        calls += 1
        return calls

    first = await cache.get_or_set("k", 0, load)
    # A monotonic-clock tick later, the entry is past its (zero) TTL.
    await asyncio.sleep(0.05)
    second = await cache.get_or_set("k", 60, load)
    assert first == 1
    assert second == 2


@pytest.mark.asyncio
async def test_invalidate_specific_key_forces_reload():
    cache = TTLCache[int]()
    calls = 0

    async def load() -> int:
        nonlocal calls
        calls += 1
        return calls

    await cache.get_or_set("k", 60, load)
    cache.invalidate("k")
    again = await cache.get_or_set("k", 60, load)
    assert again == 2


@pytest.mark.asyncio
async def test_invalidate_all_keys():
    cache = TTLCache[str]()
    await cache.get_or_set("a", 60, lambda: _const("a"))
    await cache.get_or_set("b", 60, lambda: _const("b"))
    cache.invalidate()
    calls = 0

    async def reload() -> str:
        nonlocal calls
        calls += 1
        return "new"

    await cache.get_or_set("a", 60, reload)
    await cache.get_or_set("b", 60, reload)
    assert calls == 2  # both keys had to reload after invalidate()


@pytest.mark.asyncio
async def test_single_flight_dedupes_concurrent_loads():
    cache = TTLCache[str]()
    calls = 0
    started = asyncio.Event()
    finish = asyncio.Event()

    async def slow_load() -> str:
        nonlocal calls
        calls += 1
        started.set()
        await finish.wait()
        return "v"

    t1 = asyncio.create_task(cache.get_or_set("k", 60, slow_load))
    await started.wait()
    t2 = asyncio.create_task(cache.get_or_set("k", 60, slow_load))
    finish.set()
    r1, r2 = await asyncio.gather(t1, t2)
    assert r1 == r2 == "v"
    assert calls == 1  # second caller awaited the in-flight task


async def _const(v: str) -> str:
    return v
