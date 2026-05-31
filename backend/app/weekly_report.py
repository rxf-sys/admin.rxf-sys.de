"""Weekly summary report — aggregates uptime, audit and backup stats from
the storage layer and ships them via SMTP.

Runs from the background loop in main.py once a week, plus can be invoked
manually via /api/notifications/report/send. The SMTP send goes through
``asyncio.to_thread`` so the stdlib ``smtplib`` (blocking) doesn't stall
the event loop and we avoid adding aiosmtplib as a dep.
"""

from __future__ import annotations

import asyncio
import smtplib
import ssl
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Any

import structlog

from . import accounts, auditor, storage
from .clients import pbs, probes
from .config import Settings

log = structlog.get_logger("weekly_report")


async def _read_smtp_settings(s: Settings) -> dict[str, Any]:
    """Effective SMTP config: DB overrides > .env defaults."""
    pairs = {
        "host": ("smtp_host", s.smtp_host),
        "port": ("smtp_port", str(s.smtp_port)),
        "user": ("smtp_user", s.smtp_user),
        "password": ("smtp_password", s.smtp_password),
        "starttls": ("smtp_starttls", "true" if s.smtp_starttls else "false"),
        "from_addr": ("smtp_from", s.smtp_from),
        "to_addr": ("report_to", s.report_to),
    }
    out: dict[str, Any] = {}
    for key, (db_key, default) in pairs.items():
        stored = await accounts.get_app_setting(db_key)
        out[key] = stored if stored is not None else default
    try:
        out["port"] = int(out["port"]) if str(out["port"]).isdigit() else s.smtp_port
    except (TypeError, ValueError):
        out["port"] = s.smtp_port
    out["starttls"] = str(out["starttls"]).lower() == "true"
    return out


async def build_report(s: Settings) -> dict[str, Any]:
    """Collect the numbers shown in the report. Each subsection is
    best-effort — a single upstream failure shouldn't blank the whole
    email, the report just notes the gap."""
    now = int(time.time())
    week_ago = now - 7 * 86400
    services = await probes.probe_all(s)
    backups = None
    try:
        backups = await pbs.fetch_backup_summary(s)
    except Exception as e:  # noqa: BLE001
        log.info("weekly.backup_skip", error=str(e))
    audit_runs = await auditor.list_runs(limit=20)
    recent_audits = [r for r in audit_runs if r["started_at"] >= week_ago]
    last_audit = audit_runs[0] if audit_runs else None
    rows: list[dict[str, Any]] = []
    for svc in services:
        uptime = await storage.uptime_pct(svc.id, hours=168) if storage.is_enabled() else None
        p95 = await storage.p95_ms(svc.id, hours=168) if storage.is_enabled() else None
        rows.append({
            "id": svc.id,
            "status": svc.status,
            "uptime_pct": uptime,
            "p95_ms": p95,
        })
    return {
        "generated_at": now,
        "period_start": week_ago,
        "services": rows,
        "backups": {
            "reachable": backups.reachable if backups else False,
            "total_today": backups.total_today if backups else 0,
            "success_today": backups.success_today if backups else 0,
        } if backups else None,
        "audit_runs_count": len(recent_audits),
        "last_audit_summary": last_audit.get("summary") if last_audit else None,
    }


def _format_html(report: dict[str, Any]) -> str:
    generated = datetime.fromtimestamp(report["generated_at"], tz=timezone.utc)
    period_start = datetime.fromtimestamp(report["period_start"], tz=timezone.utc)
    rows = report["services"]
    bk = report.get("backups")
    audit_count = report["audit_runs_count"]
    last_audit = report.get("last_audit_summary") or {}

    svc_rows = "\n".join(
        f"<tr><td>{r['id']}</td>"
        f"<td>{r['status']}</td>"
        f"<td>{(r['uptime_pct'] or 0):.2f}%</td>"
        f"<td>{(r['p95_ms'] or 0)} ms</td></tr>"
        for r in rows
    )
    backup_block = ""
    if bk:
        backup_block = (
            "<h3>Backups (heute)</h3>"
            f"<p>{bk['success_today']}/{bk['total_today']} Jobs erfolgreich · "
            f"{'reachable' if bk['reachable'] else 'OFFLINE'}</p>"
        )
    audit_block = (
        "<h3>Audit</h3>"
        f"<p>{audit_count} Läufe in den letzten 7 Tagen · "
        f"zuletzt: ok={last_audit.get('ok', '—')} warn={last_audit.get('warn', '—')} "
        f"err={last_audit.get('err', '—')} skipped={last_audit.get('skipped', '—')}</p>"
    )

    return f"""<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;max-width:680px;margin:auto;padding:20px;color:#222">
<h2 style="margin-top:0">rxf-sys · Wochenreport</h2>
<p style="color:#666;font-size:12px">
  Zeitraum: {period_start.strftime('%Y-%m-%d %H:%M')} – {generated.strftime('%Y-%m-%d %H:%M')} UTC
</p>
<h3>Services</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
  <thead><tr><th align="left">Service</th><th align="left">Status</th><th align="left">Uptime 7d</th><th align="left">p95</th></tr></thead>
  <tbody>{svc_rows or '<tr><td colspan="4">keine Services konfiguriert</td></tr>'}</tbody>
</table>
{backup_block}
{audit_block}
<p style="color:#888;font-size:11px;margin-top:20px">
  Automatisch generiert · admin.rxf-sys.de
</p>
</body></html>"""


def _format_text(report: dict[str, Any]) -> str:
    lines = ["rxf-sys · Wochenreport", ""]
    lines.append("Services:")
    for r in report["services"]:
        lines.append(f"  {r['id']:<12} {r['status']:<6} uptime {((r['uptime_pct'] or 0)):.1f}%  p95 {r['p95_ms'] or 0}ms")
    bk = report.get("backups")
    if bk:
        lines.append("")
        lines.append(f"Backups heute: {bk['success_today']}/{bk['total_today']}")
    lines.append(f"Audit-Läufe (7d): {report['audit_runs_count']}")
    return "\n".join(lines)


def _send_blocking(cfg: dict[str, Any], subject: str, html: str, text: str) -> None:
    """Build the multipart message and ship it via stdlib smtplib."""
    msg = EmailMessage()
    msg["From"] = cfg["from_addr"] or cfg["user"]
    msg["To"] = cfg["to_addr"]
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain="rxf-sys.de")
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    if cfg["port"] == 465:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=15, context=context) as smtp:
            if cfg["user"]:
                smtp.login(cfg["user"], cfg["password"])
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=15) as smtp:
            if cfg["starttls"]:
                smtp.starttls(context=ssl.create_default_context())
            if cfg["user"]:
                smtp.login(cfg["user"], cfg["password"])
            smtp.send_message(msg)


async def send_report(s: Settings, *, subject_prefix: str = "Wochenreport") -> dict[str, Any]:
    """Compile + send the report once. Raises on SMTP errors so the caller
    (manual trigger or auto-loop) can surface a 502 / log the failure."""
    cfg = await _read_smtp_settings(s)
    if not cfg["host"] or not cfg["to_addr"]:
        raise RuntimeError("smtp_host oder report_to nicht konfiguriert")
    report = await build_report(s)
    subject = f"[rxf-sys] {subject_prefix} · {datetime.now(timezone.utc):%Y-%m-%d}"
    html = _format_html(report)
    text = _format_text(report)
    await asyncio.to_thread(_send_blocking, cfg, subject, html, text)
    log.info("weekly.sent", to=cfg["to_addr"], services=len(report["services"]))
    return {
        "to": cfg["to_addr"],
        "services_count": len(report["services"]),
    }
