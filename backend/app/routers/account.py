"""Self-service endpoints for the logged-in user: UI settings + password."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .. import accounts, totp
from ..auth import verify_session
from .auth import MIN_PASSWORD_LEN

router = APIRouter(prefix="/api/account", tags=["account"])


class SettingsBody(BaseModel):
    # Opaque UI-settings blob owned by the frontend. Stored verbatim.
    settings: dict


class PasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=MIN_PASSWORD_LEN, max_length=256)


@router.get("/settings")
async def get_settings_endpoint(user: dict = Depends(verify_session)) -> dict:
    return {"settings": await accounts.get_user_settings(user["id"])}


@router.put("/settings")
async def put_settings(
    body: SettingsBody, user: dict = Depends(verify_session)
) -> dict:
    try:
        await accounts.set_user_settings(user["id"], body.settings)
    except accounts.AccountError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    return {"ok": True}


@router.post("/password")
async def change_password(
    body: PasswordBody, user: dict = Depends(verify_session)
) -> dict:
    # Re-authenticate with the current password before allowing the change.
    check = await accounts.authenticate(user["username"], body.current_password)
    if check is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="aktuelles Passwort falsch",
        )
    await accounts.set_password(user["id"], body.new_password)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Per-user API tokens
# ---------------------------------------------------------------------------


class CreateTokenBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scope: str = Field(default="read", pattern=r"^(read|write|admin)$")
    ttl_days: int | None = Field(default=None, ge=1, le=3650)


@router.get("/tokens")
async def list_my_tokens(user: dict = Depends(verify_session)) -> dict:
    return {"tokens": await accounts.list_api_tokens(user_id=user["id"])}


@router.post("/tokens", status_code=status.HTTP_201_CREATED)
async def create_my_token(
    body: CreateTokenBody, user: dict = Depends(verify_session)
) -> dict:
    """Returns the raw token *once*. Subsequent reads only see the prefix.

    When the request itself is token-authenticated, the new token's scope is
    capped at the authenticating token's scope — otherwise a leaked 'write'
    token could mint itself an 'admin' replacement."""
    auth_scope = user.get("token_scope")
    if auth_scope is not None and (
        accounts.TOKEN_SCOPE_RANK.get(body.scope, 0)
        > accounts.TOKEN_SCOPE_RANK.get(auth_scope, 0)
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Token-Scope '{body.scope}' übersteigt den Scope des verwendeten Tokens",
        )
    raw, meta = await accounts.create_api_token(
        user["id"], body.name, scope=body.scope, ttl_days=body.ttl_days
    )
    return {"token": raw, "meta": meta}


@router.delete("/tokens/{token_id}")
async def delete_my_token(
    token_id: int, user: dict = Depends(verify_session)
) -> dict:
    ok = await accounts.delete_api_token(token_id, user_id=user["id"])
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Token nicht gefunden")
    return {"ok": True}


# ---------------------------------------------------------------------------
# 2FA (TOTP)
# ---------------------------------------------------------------------------


class TotpVerifyBody(BaseModel):
    code: str = Field(min_length=4, max_length=20)


class TotpDisableBody(BaseModel):
    password: str = Field(min_length=1, max_length=256)


@router.get("/2fa")
async def get_2fa_status(user: dict = Depends(verify_session)) -> dict:
    return await totp.status_for(user["id"])


@router.post("/2fa/setup")
async def begin_2fa_setup(user: dict = Depends(verify_session)) -> dict:
    """Start (or restart) provisioning. Returns the secret + QR for the
    authenticator app. Caller must call /2fa/verify with the first code
    from the app to actually enable 2FA."""
    try:
        return await totp.begin_setup(user["id"], user["username"])
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


@router.post("/2fa/verify")
async def verify_2fa_setup(
    body: TotpVerifyBody, user: dict = Depends(verify_session)
) -> dict:
    """Confirm provisioning by sending the first TOTP code. Server marks
    2FA as enabled and returns 8 one-shot backup codes (shown exactly
    once)."""
    try:
        backup = await totp.verify_setup(user["id"], body.code)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    return {"enabled": True, "backup_codes": backup}


@router.delete("/2fa")
async def disable_2fa(
    body: TotpDisableBody, user: dict = Depends(verify_session)
) -> dict:
    """Disable 2FA. Re-authenticates with the current password so a
    forgotten-but-still-open session can't drop the second factor."""
    check = await accounts.authenticate(user["username"], body.password)
    if check is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Passwort falsch",
        )
    await totp.disable(user["id"])
    return {"enabled": False}
