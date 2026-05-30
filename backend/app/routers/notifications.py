"""Runtime-editable notification config (ntfy + webhook).

Mirrors the .env defaults into app_settings on first PUT so an admin can
tweak ntfy URL + topic + token from the UI without a redeploy. The notify
loop reads these via accounts.get_app_setting on every send.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .. import accounts
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
    await accounts.set_app_setting("ntfy_base", body.base.strip())
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
