"""Runtime-editable instance metadata: name, timezone, time format.

Reads from the ``app_settings`` key-value table (populated lazily from the
.env defaults on first GET). PUT requires admin. This is intentionally a
flat key/value bucket and not a typed Pydantic settings page — the set of
knobs is small and stays small."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .. import accounts
from ..auth import require_admin, verify_session
from ..config import Settings, get_settings

router = APIRouter(prefix="/api/instance", tags=["instance"])

# Keys we accept on PUT — anything else is rejected so a typo can't pollute
# the table with dead entries.
_ALLOWED_KEYS: dict[str, str] = {
    "instance_name": "branding name shown in the header + browser tab",
    "default_timezone": "IANA timezone id used for formatting timestamps",
    "time_format": "either '12h' or '24h'",
}


class InstanceUpdate(BaseModel):
    instance_name: str | None = Field(default=None, max_length=80)
    default_timezone: str | None = Field(default=None, max_length=80)
    time_format: str | None = Field(default=None, pattern=r"^(12h|24h)$")


async def _resolve(key: str, default: str) -> str:
    stored = await accounts.get_app_setting(key)
    return stored if stored is not None else default


@router.get("", dependencies=[Depends(verify_session)])
async def get_instance(settings: Settings = Depends(get_settings)) -> dict:
    """Returns the effective instance settings (overrides + .env defaults)."""
    return {
        "instance_name": await _resolve("instance_name", settings.instance_name),
        "default_timezone": await _resolve("default_timezone", settings.default_timezone),
        "time_format": await _resolve("time_format", settings.time_format),
    }


@router.put("")
async def update_instance(
    body: InstanceUpdate, admin: dict = Depends(require_admin)
) -> dict:
    """Admin-only: update one or more instance knobs.

    Empty body is a no-op. Each field is upserted into ``app_settings``
    individually so a partial update doesn't overwrite the other keys.
    """
    updates: dict[str, str] = {}
    if body.instance_name is not None:
        name = body.instance_name.strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="instance_name darf nicht leer sein",
            )
        updates["instance_name"] = name
    if body.default_timezone is not None:
        updates["default_timezone"] = body.default_timezone.strip()
    if body.time_format is not None:
        updates["time_format"] = body.time_format
    for k, v in updates.items():
        await accounts.set_app_setting(k, v)
    settings = get_settings()
    return {
        "instance_name": await _resolve("instance_name", settings.instance_name),
        "default_timezone": await _resolve("default_timezone", settings.default_timezone),
        "time_format": await _resolve("time_format", settings.time_format),
        "_": admin["username"],  # actor for audit trail downstream
    }
