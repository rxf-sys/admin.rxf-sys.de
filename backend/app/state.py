"""In-memory snapshot of the latest service-probe results.

Decouples HTTP handlers from the act of probing. A dedicated background task
in ``main.py`` writes here on a fixed cadence; ``/api/services`` and the
notification loop read here. CRUD on the service registry can call
``request_refresh()`` to ask the loop for an immediate re-probe instead of
waiting out the next tick.
"""

from __future__ import annotations

import asyncio
import time

from .models import ServiceStatus


class ServiceSnapshot:
    def __init__(self) -> None:
        self._results: list[ServiceStatus] | None = None
        self._updated_at: float = 0.0
        self._lock = asyncio.Lock()
        self._refresh = asyncio.Event()

    async def set(self, results: list[ServiceStatus]) -> None:
        async with self._lock:
            self._results = list(results)
            self._updated_at = time.time()

    async def get(self) -> tuple[list[ServiceStatus] | None, float]:
        async with self._lock:
            current = list(self._results) if self._results is not None else None
            return current, self._updated_at

    def request_refresh(self) -> None:
        """Signal the probe loop to skip its remaining sleep and re-probe now."""
        self._refresh.set()

    async def wait_for_tick(self, interval_s: float) -> None:
        """Block until either ``interval_s`` elapsed or ``request_refresh`` was called."""
        if interval_s <= 0:
            await self._refresh.wait()
            self._refresh.clear()
            return
        try:
            await asyncio.wait_for(self._refresh.wait(), timeout=interval_s)
        except asyncio.TimeoutError:
            pass
        finally:
            self._refresh.clear()

    def reset_for_tests(self) -> None:
        self._results = None
        self._updated_at = 0.0
        self._refresh = asyncio.Event()


service_snapshot = ServiceSnapshot()
