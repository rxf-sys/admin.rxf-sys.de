from __future__ import annotations

import time

import httpx
import pytest
import respx

from app.config import Settings
from app.notify import NotificationCenter


@pytest.fixture
def notify_settings() -> Settings:
    return Settings(
        notify_webhook_url="https://hooks.example/abc",
        notify_service_threshold_s=10,
        notify_cert_days=14,
    )


@pytest.mark.asyncio
@respx.mock
async def test_no_op_without_webhook():
    s = Settings(notify_webhook_url="")
    nc = NotificationCenter(settings=s)
    await nc.evaluate_service("vault", "err", 999)
    # No HTTP traffic should have happened.
    assert len(respx.calls) == 0


@pytest.mark.asyncio
@respx.mock
async def test_service_degraded_only_after_threshold(notify_settings):
    nc = NotificationCenter(settings=notify_settings)
    route = respx.post("https://hooks.example/abc").respond(204)

    # First sighting -> just records first_seen_bad, no webhook yet.
    await nc.evaluate_service("vault", "err", 999)
    assert route.call_count == 0

    # Backdate so the threshold has elapsed.
    nc.state["service:vault"].first_seen_bad = time.time() - 30
    await nc.evaluate_service("vault", "err", 999)
    assert route.call_count == 1

    # Should not re-notify on subsequent ticks.
    await nc.evaluate_service("vault", "err", 999)
    assert route.call_count == 1


@pytest.mark.asyncio
@respx.mock
async def test_service_recovery_emits_info(notify_settings):
    nc = NotificationCenter(settings=notify_settings)
    route = respx.post("https://hooks.example/abc").respond(204)

    # Pretend we already notified that vault was bad.
    nc.state["service:vault"] = _make_state(
        first_seen_bad=time.time() - 30, notified_bad_at=time.time() - 10
    )

    await nc.evaluate_service("vault", "ok", 50)
    assert route.call_count == 1
    body = route.calls.last.request.content.decode()
    assert "erholt" in body


@pytest.mark.asyncio
@respx.mock
async def test_backup_unreachable_then_recovered(notify_settings):
    nc = NotificationCenter(settings=notify_settings)
    route = respx.post("https://hooks.example/abc").respond(204)

    await nc.evaluate_backup(reachable=False, success_today=0, total_today=0)
    assert route.call_count == 1

    # Subsequent unreachable shouldn't re-notify.
    await nc.evaluate_backup(reachable=False, success_today=0, total_today=0)
    assert route.call_count == 1

    # Recovery emits info.
    await nc.evaluate_backup(reachable=True, success_today=2, total_today=2)
    assert route.call_count == 2


@pytest.mark.asyncio
@respx.mock
async def test_cert_expiring_within_threshold(notify_settings):
    nc = NotificationCenter(settings=notify_settings)
    route = respx.post("https://hooks.example/abc").respond(204)

    await nc.evaluate_certs(
        [
            {"domain": "vault.rxf-sys.de", "days_left": 5},
            {"domain": "cloud.rxf-sys.de", "days_left": 90},
        ]
    )
    # Only the close-to-expiry cert triggers
    assert route.call_count == 1
    assert "vault.rxf-sys.de" in route.calls.last.request.content.decode()


@pytest.mark.asyncio
@respx.mock
async def test_webhook_failure_does_not_propagate(notify_settings):
    nc = NotificationCenter(settings=notify_settings)
    respx.post("https://hooks.example/abc").mock(
        side_effect=httpx.ConnectError("network down")
    )

    # Backdate to force a notification attempt.
    nc.state["service:vault"] = _make_state(first_seen_bad=time.time() - 30)
    # Should not raise.
    await nc.evaluate_service("vault", "err", 999)


def _make_state(
    first_seen_bad: float = 0.0, notified_bad_at: float = 0.0
):
    from app.notify import _EventState

    return _EventState(
        first_seen_bad=first_seen_bad,
        notified_bad_at=notified_bad_at,
    )
