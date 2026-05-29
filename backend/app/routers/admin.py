"""Admin-only account management: list / create / update / delete users."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from .. import accounts
from ..audit import record as audit_record
from ..auth import require_admin
from .auth import MIN_PASSWORD_LEN

log = structlog.get_logger("admin")

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])


class CreateUserBody(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=MIN_PASSWORD_LEN, max_length=256)
    role: str = Field(default="user")
    email: str | None = Field(default=None, max_length=200)


class UpdateUserBody(BaseModel):
    role: str | None = None
    email: str | None = Field(default=None, max_length=200)
    disabled: bool | None = None


class ResetPasswordBody(BaseModel):
    new_password: str = Field(min_length=MIN_PASSWORD_LEN, max_length=256)


@router.get("/users")
async def list_users() -> dict:
    return {"users": await accounts.list_users()}


@router.get("/sessions")
async def list_active_sessions() -> dict:
    """All non-expired sessions across all users.

    Drives the 'Aktive Sessions' card in the admin tab. Tokens are returned
    truncated to a short prefix — sufficient for the UI to identify a row
    for revocation, never enough to reconstruct the real token."""
    return {"sessions": await accounts.list_active_sessions()}


@router.delete("/sessions/{token_prefix}")
async def revoke_session(
    token_prefix: str, admin: dict = Depends(require_admin)
) -> dict:
    """Revoke (delete) sessions whose token starts with ``token_prefix``.

    8-char prefixes are unique in practice; we still return ``revoked`` so
    the caller can detect a zero-match (already expired) or a multi-match
    (extremely unlikely collision)."""
    revoked = await accounts.revoke_session(token_prefix)
    audit_record(
        "admin.session_revoked",
        actor=admin["username"],
        token_prefix=token_prefix,
        revoked=revoked,
    )
    return {"revoked": revoked}


@router.post("/users", status_code=status.HTTP_201_CREATED)
async def create_user(
    body: CreateUserBody, admin: dict = Depends(require_admin)
) -> dict:
    try:
        user = await accounts.create_user(
            body.username, body.password, role=body.role, email=body.email
        )
    except accounts.AccountError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    audit_record("admin.user_created", actor=admin["username"], target=body.username, role=body.role)
    return {"user": user}


@router.patch("/users/{user_id}")
async def update_user(
    user_id: int, body: UpdateUserBody, admin: dict = Depends(require_admin)
) -> dict:
    target = await accounts.get_user_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Konto nicht gefunden")

    # Guard: never strip the last enabled admin of its privileges, and don't
    # let an admin lock themselves out by disabling / demoting their own
    # account when they're the last one standing.
    losing_admin = (target["role"] == "admin") and (
        body.role not in (None, "admin") or body.disabled is True
    )
    if losing_admin and await accounts.admin_count(exclude_user_id=user_id) == 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="der letzte Admin kann nicht deaktiviert oder herabgestuft werden",
        )

    try:
        updated = await accounts.update_user(
            user_id, role=body.role, email=body.email, disabled=body.disabled
        )
    except accounts.AccountError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    audit_record("admin.user_updated", actor=admin["username"], target=target["username"])
    return {"user": updated}


@router.post("/users/{user_id}/password")
async def reset_password(
    user_id: int, body: ResetPasswordBody, admin: dict = Depends(require_admin)
) -> dict:
    target = await accounts.get_user_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Konto nicht gefunden")
    await accounts.set_password(user_id, body.new_password)
    audit_record("admin.password_reset", actor=admin["username"], target=target["username"])
    return {"ok": True}


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, admin: dict = Depends(require_admin)) -> dict:
    target = await accounts.get_user_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Konto nicht gefunden")
    if user_id == admin["id"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="das eigene Konto kann nicht gelöscht werden",
        )
    if target["role"] == "admin" and await accounts.admin_count(exclude_user_id=user_id) == 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="der letzte Admin kann nicht gelöscht werden",
        )
    await accounts.delete_user(user_id)
    audit_record("admin.user_deleted", actor=admin["username"], target=target["username"])
    return {"ok": True}
