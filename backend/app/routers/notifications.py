"""Runtime-editable notification config (ntfy + webhook).

Mirrors the .env defaults into app_settings on first PUT so an admin can
tweak ntfy URL + topic + token from the UI without a redeploy. The notify
loop reads these via accounts.get_app_setting on every send.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .. import accounts, weekly_report
from ..audit import record as audit_record
from ..auth import require_admin, verify_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


class NtfyConfig(BaseModel):
    base: str = Field(default="", max_length=300)
    topic: str = Field(default="", max_length=120)
    token: str = Field(default="", max_length=300)


async def _read_effective_ntfy(settings: Settings) -> NtfyConfig:
    base = await accounts.get_app_setting("ntfy_base")
    topic = await accounts.get_app_setting("ntfy_topic")
    token = await accounts.get_app_setting("ntfy_token")
    return NtfyConfig(
        base=base if base is not None else settings.ntfy_base,
        topic=topic if topic is not None else settings.ntfy_topic,
        token=token if token is not None else settings.ntfy_token,
    )


@router.get("/ntfy", dependencies=[Depends(verify_session)])
async def get_ntfy(settings: Settings = Depends(get_settings)) -> dict:
    cfg = await _read_effective_ntfy(settings)
    # Never return the raw token — show "set" / "unset" so the UI can
    # display state without leaking it through any cache / response log.
    return {
        "base": cfg.base,
        "topic": cfg.topic,
        "token_set": bool(cfg.token),
    }


@router.put("/ntfy")
async def update_ntfy(body: NtfyConfig, admin: dict = Depends(require_admin)) -> dict:
    """Upsert the three ntfy settings. Empty strings clear the override
    (subsequent reads fall back to the .env defaults)."""
    base = body.base.strip()
    if base and not base.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ntfy_base muss mit http:// oder https:// beginnen",
        )
    await accounts.set_app_setting("ntfy_base", base)
    await accounts.set_app_setting("ntfy_topic", body.topic.strip())
    # Only overwrite the token when the caller actually sent one — the UI
    # sends an empty string to mean "unchanged" so the admin doesn't have
    # to re-type it on every save.
    if body.token != "":
        await accounts.set_app_setting("ntfy_token", body.token)
    audit_record("notify.ntfy_updated", actor=admin["username"])
    return {"ok": True}


@router.post("/ntfy/test")
async def test_ntfy(
    settings: Settings = Depends(get_settings), admin: dict = Depends(require_admin)
) -> dict:
    """Send a single test message to the configured ntfy topic.

    Useful for an admin to confirm the URL/topic/token combination works
    without having to wait for an actual service incident."""
    cfg = await _read_effective_ntfy(settings)
    if not cfg.base or not cfg.topic:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ntfy_base oder ntfy_topic nicht konfiguriert",
        )
    url = f"{cfg.base.rstrip('/')}/{cfg.topic}"
    headers = {"Title": "rxf-admin · Test", "Priority": "3", "Tags": "white_check_mark"}
    if cfg.token:
        headers["Authorization"] = f"Bearer {cfg.token}"
    body = f"Test-Push aus dem Dashboard von {admin['username']}."
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.post(url, content=body.encode("utf-8"), headers=headers)
            r.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"ntfy nicht erreichbar: {e}",
        ) from e
    audit_record("notify.ntfy_test", actor=admin["username"])
    return {"ok": True, "url": url}


# ---------------------------------------------------------------------------
# SMTP / Weekly report
# ---------------------------------------------------------------------------


class SmtpConfig(BaseModel):
    host: str = Field(default="", max_length=200)
    port: int = Field(default=587, ge=1, le=65535)
    user: str = Field(default="", max_length=200)
    password: str = Field(default="", max_length=300)
    starttls: bool = True
    from_addr: str = Field(default="", max_length=200)


class ReportConfig(BaseModel):
    enabled: bool
    hour: int = Field(ge=0, le=23)
    to: str = Field(default="", max_length=400)


@router.get("/smtp", dependencies=[Depends(verify_session)])
async def get_smtp(settings: Settings = Depends(get_settings)) -> dict:
    """Returns the effective SMTP config — password redacted to a bool."""
    async def _val(key: str, default: str) -> str:
        v = await accounts.get_app_setting(key)
        return v if v is not None else default
    port_str = await accounts.get_app_setting("smtp_port")
    starttls_str = await accounts.get_app_setting("smtp_starttls")
    return {
        "host": await _val("smtp_host", settings.smtp_host),
        "port": int(port_str) if port_str and port_str.isdigit() else settings.smtp_port,
        "user": await _val("smtp_user", settings.smtp_user),
        "password_set": bool(await accounts.get_app_setting("smtp_password") or settings.smtp_password),
        "starttls": (starttls_str == "true") if starttls_str is not None else settings.smtp_starttls,
        "from_addr": await _val("smtp_from", settings.smtp_from),
    }


@router.put("/smtp")
async def update_smtp(body: SmtpConfig, admin: dict = Depends(require_admin)) -> dict:
    await accounts.set_app_setting("smtp_host", body.host.strip())
    await accounts.set_app_setting("smtp_port", str(body.port))
    await accounts.set_app_setting("smtp_user", body.user.strip())
    if body.password != "":
        await accounts.set_app_setting("smtp_password", body.password)
    await accounts.set_app_setting("smtp_starttls", "true" if body.starttls else "false")
    await accounts.set_app_setting("smtp_from", body.from_addr.strip())
    audit_record("notify.smtp_updated", actor=admin["username"])
    return {"ok": True}


@router.get("/report", dependencies=[Depends(verify_session)])
async def get_report_config(settings: Settings = Depends(get_settings)) -> dict:
    enabled_str = await accounts.get_app_setting("weekly_report_enabled")
    hour_str = await accounts.get_app_setting("report_hour")
    to_addr = await accounts.get_app_setting("report_to")
    last = await accounts.get_app_setting("weekly_report_last_week")
    return {
        "enabled": (enabled_str == "true") if enabled_str is not None else settings.weekly_report_enabled,
        "hour": int(hour_str) if hour_str and hour_str.isdigit() else settings.report_hour,
        "to": to_addr if to_addr is not None else settings.report_to,
        "last_sent_week": last,
    }


@router.put("/report")
async def update_report_config(
    body: ReportConfig, admin: dict = Depends(require_admin)
) -> dict:
    await accounts.set_app_setting("weekly_report_enabled", "true" if body.enabled else "false")
    await accounts.set_app_setting("report_hour", str(body.hour))
    await accounts.set_app_setting("report_to", body.to.strip())
    audit_record("notify.report_config_updated", actor=admin["username"])
    return {"ok": True}


@router.post("/report/send")
async def send_report_now(
    settings: Settings = Depends(get_settings), admin: dict = Depends(require_admin)
) -> dict:
    """Manually trigger the weekly report — useful for SMTP testing without
    waiting until Monday."""
    try:
        result = await weekly_report.send_report(settings, subject_prefix="Test-Report")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Report-Versand fehlgeschlagen: {e}",
        ) from e
    audit_record("notify.report_sent_manually", actor=admin["username"])
    return {"ok": True, **result}
