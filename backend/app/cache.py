from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar

T = TypeVar("T")


class TTLCache(Generic[T]):
    """Tiny async-safe TTL cache with single-flight semantics per key.

    On hit, returns the cached value. On miss/expiry, runs the loader once;
    concurrent callers awaiting the same key share the in-flight task.
    """

    def __init__(self) -> None:
        self._store: dict[str, tuple[float, T]] = {}
        self._inflight: dict[str, asyncio.Task[T]] = {}
        self._lock = asyncio.Lock()

    async def get_or_set(self, key: str, ttl: int, loader: Callable[[], Awaitable[T]]) -> T:
        now = time.monotonic()
        cached = self._store.get(key)
        if cached and cached[0] > now:
            return cached[1]

        async with self._lock:
            cached = self._store.get(key)
            if cached and cached[0] > now:
                return cached[1]
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.create_task(self._run(key, ttl, loader))
                self._inflight[key] = task
        return await task

    async def _run(self, key: str, ttl: int, loader: Callable[[], Awaitable[T]]) -> T:
        try:
            value = await loader()
            self._store[key] = (time.monotonic() + ttl, value)
            return value
        finally:
            self._inflight.pop(key, None)

    def invalidate(self, key: str | None = None) -> None:
        if key is None:
            self._store.clear()
        else:
            self._store.pop(key, None)


cache: TTLCache[Any] = TTLCache()
