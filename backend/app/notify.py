"""Notification center.

Watches dashboard state and fires webhook notifications when something bad
persists (degraded service, failed backup, expiring cert, unhealthy tunnel).

Designed to be webhook-shape agnostic but defaults to Discord's embed payload,
which Slack also accepts via the Slack-compatible Discord webhook URL.

State (per-event last-notified timestamps and "first seen bad" timestamps) is
kept in-memory; on process restart we re-evaluate from scratch, which means a
brief flap during deploys won't double-notify because the threshold has to
elapse again first.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Literal

import httpx
import structlog

from .config import Settings

log = structlog.get_logger("notify")

Severity = Literal["info", "warn", "err"]
_COLORS: dict[Severity, int] = {
    "info": 0x4F9EFF,  # blue
    "warn": 0xFFB020,  # amber
    "err": 0xFF4757,   # red
}


@dataclass
class _EventState:
    """Tracks the state machine for a single (kind, target) event."""

    first_seen_bad: float = 0.0
    notified_bad_at: float = 0.0
    last_severity: Severity = "info"


@dataclass
class NotificationCenter:
    """Evaluates dashboard state on a tick and emits webhook notifications."""

    settings: Settings
    state: dict[str, _EventState] = field(default_factory=dict)

    def _ev(self, key: str) -> _EventState:
        s = self.state.get(key)
        if s is None:
            s = _EventState()
            self.state[key] = s
        return s

    async def _send(
        self, title: str, description: str, severity: Severity = "warn"
    ) -> None:
        url = self.settings.notify_webhook_url
        if not url:
            return
        payload = {
            "username": "rxf-sys admin",
            "embeds": [
                {
                    "title": title,
                    "description": description,
                    "color": _COLORS[severity],
                }
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.post(url, json=payload)
                if r.status_code >= 400:
                    log.warning(
                        "notify.webhook_rejected",
                        status=r.status_code,
                        body=r.text[:200],
                    )
        except httpx.HTTPError as e:
            log.warning("notify.webhook_failed", error=str(e))

    async def evaluate_service(
        self, service_id: str, status: str, response_ms: int
    ) -> None:
        """Track a service's status; fire on persistent err/warn."""
        key = f"service:{service_id}"
        ev = self._ev(key)
        now = time.time()
        threshold = self.settings.notify_service_threshold_s

        if status == "ok":
            if ev.notified_bad_at > 0:
                await self._send(
                    f"Service erholt: {service_id}",
                    f"Antwortzeit {response_ms} ms — wieder OK.",
                    severity="info",
                )
            ev.first_seen_bad = 0.0
            ev.notified_bad_at = 0.0
            ev.last_severity = "info"
            return

        # status is warn / err / idle
        severity: Severity = "err" if status == "err" else "warn"
        if ev.first_seen_bad == 0.0:
            ev.first_seen_bad = now
            ev.last_severity = severity
            return

        # Already in a bad state. Notify once after threshold.
        elapsed = now - ev.first_seen_bad
        if ev.notified_bad_at == 0.0 and elapsed >= threshold:
            await self._send(
                f"Service degraded: {service_id}",
                f"Status **{status}** seit {int(elapsed)} s. Antwortzeit {response_ms} ms.",
                severity=severity,
            )
            ev.notified_bad_at = now

    async def evaluate_backup(
        self, reachable: bool, success_today: int, total_today: int
    ) -> None:
        key = "backup"
        ev = self._ev(key)
        now = time.time()

        if not reachable:
            if ev.notified_bad_at == 0.0:
                await self._send(
                    "PBS unerreichbar",
                    "Der Proxmox Backup Server antwortet nicht.",
                    severity="err",
                )
                ev.notified_bad_at = now
            return

        # Backup ran but had failures today
        if total_today > 0 and success_today < total_today:
            if ev.notified_bad_at == 0.0:
                await self._send(
                    "Backup-Job(s) fehlgeschlagen",
                    f"{total_today - success_today} von {total_today} Jobs heute nicht erfolgreich.",
                    severity="err",
                )
                ev.notified_bad_at = now
            return

        # Recovered
        if ev.notified_bad_at > 0:
            await self._send(
                "Backups erholt",
                f"PBS wieder erreichbar, {success_today}/{total_today} Jobs heute OK.",
                severity="info",
            )
        ev.notified_bad_at = 0.0

    async def evaluate_certs(self, certs: list[dict]) -> None:
        threshold = self.settings.notify_cert_days
        for c in certs:
            domain = c.get("domain", "?")
            days = int(c.get("days_left", 999))
            key = f"cert:{domain}"
            ev = self._ev(key)
            if days <= threshold:
                if ev.notified_bad_at == 0.0:
                    await self._send(
                        f"Zertifikat läuft bald ab: {domain}",
                        f"Nur noch **{days} Tage** gültig.",
                        severity="warn" if days > 7 else "err",
                    )
                    ev.notified_bad_at = time.time()
            else:
                ev.notified_bad_at = 0.0

    async def evaluate_tunnel(self, status: str) -> None:
        key = "tunnel"
        ev = self._ev(key)
        now = time.time()
        if status in ("healthy",):
            if ev.notified_bad_at > 0:
                await self._send(
                    "Cloudflare Tunnel erholt",
                    "Tunnel wieder healthy.",
                    severity="info",
                )
            ev.notified_bad_at = 0.0
            return
        if ev.notified_bad_at == 0.0:
            await self._send(
                "Cloudflare Tunnel degraded",
                f"Tunnel-Status: **{status}**.",
                severity="err" if status == "down" else "warn",
            )
            ev.notified_bad_at = now


async def run_notification_loop(
    center: NotificationCenter,
    fetch_state: "callable",  # type: ignore[valid-type]
    interval_s: float = 60.0,
) -> None:
    """Background loop that periodically evaluates state."""
    log.info("notify.loop_start", interval_s=interval_s)
    # Small startup delay so the cache has a chance to populate first.
    await asyncio.sleep(5.0)
    while True:
        try:
            snapshot = await fetch_state()
            for svc in snapshot.get("services", []):
                await center.evaluate_service(svc["id"], svc["status"], svc.get("ms", 0))
            backups = snapshot.get("backups")
            if backups:
                await center.evaluate_backup(
                    backups.get("reachable", True),
                    backups.get("success_today", 0),
                    backups.get("total_today", 0),
                )
            await center.evaluate_certs(snapshot.get("certs", []))
            tunnel = snapshot.get("tunnel")
            if tunnel:
                await center.evaluate_tunnel(tunnel.get("status", "unknown"))
        except asyncio.CancelledError:
            log.info("notify.loop_cancelled")
            raise
        except Exception as e:  # noqa: BLE001 - never let loop die
            log.error("notify.loop_error", error=str(e), error_type=type(e).__name__)
        await asyncio.sleep(interval_s)
