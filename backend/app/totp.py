"""TOTP-based two-factor authentication.

State lives in the ``user_totp`` table created alongside the accounts
schema. A user has one of three TOTP states:

* not provisioned    — no row in user_totp
* provisioning       — row exists, ``enabled_at`` is NULL (secret generated,
                       waiting for the user to verify their first OTP)
* enabled            — row exists, ``enabled_at`` is set

Backup codes are 10-char alphanumeric, sha256-hashed at rest. Each can be
used exactly once — verification removes it from the JSON array.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import secrets
import time
from typing import Any

import aiosqlite
import pyotp
import qrcode
import qrcode.image.svg
import structlog

from . import accounts

log = structlog.get_logger("totp")

ISSUER = "rxf-sys admin"
BACKUP_CODE_COUNT = 8


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.upper().encode("utf-8")).hexdigest()


def _generate_backup_codes() -> list[str]:
    """Return 8 short codes like ``A3K9-PQRX``. Stored as sha256, shown raw
    to the user exactly once during 2FA setup."""
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no I/L/O/0/1 confusables
    codes: list[str] = []
    for _ in range(BACKUP_CODE_COUNT):
        chunk1 = "".join(secrets.choice(alphabet) for _ in range(4))
        chunk2 = "".join(secrets.choice(alphabet) for _ in range(4))
        codes.append(f"{chunk1}-{chunk2}")
    return codes


def _qr_svg(provisioning_uri: str) -> str:
    """Render the otpauth:// URI to an inline SVG string."""
    img = qrcode.make(
        provisioning_uri,
        image_factory=qrcode.image.svg.SvgPathImage,
        box_size=8,
        border=2,
    )
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode("utf-8")


# ---------------------------------------------------------------------------
# CRUD on the user_totp row
# ---------------------------------------------------------------------------


async def _get_row(user_id: int) -> dict[str, Any] | None:
    async with accounts._connect() as db:  # noqa: SLF001 - intentional reuse
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT secret_b32, enabled_at, backup_codes_json, last_used_step"
            " FROM user_totp WHERE user_id = ?",
            (user_id,),
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    try:
        codes = json.loads(row["backup_codes_json"])
        if not isinstance(codes, list):
            codes = []
    except (TypeError, ValueError):
        codes = []
    return {
        "secret_b32": row["secret_b32"],
        "enabled_at": int(row["enabled_at"]) if row["enabled_at"] else None,
        "backup_codes_hashes": codes,
        "last_used_step": int(row["last_used_step"] or 0),
    }


def _match_step(secret_b32: str, code: str, at: float | None = None) -> int | None:
    """Return the TOTP timestep the code is valid for (±1 step), or None.

    Resolving the concrete step — instead of a bare verify() — is what makes
    replay protection possible: we persist the highest accepted step per user
    and reject anything at or below that watermark, so a code sniffed off the
    wire can't be reused inside its validity window.
    """
    totp_obj = pyotp.TOTP(secret_b32)
    now = time.time() if at is None else at
    for offset in (0, -1, 1):
        t = now + offset * totp_obj.interval
        if hmac.compare_digest(totp_obj.at(t), code):
            return int(t // totp_obj.interval)
    return None


async def _bump_last_used_step(user_id: int, step: int) -> None:
    async with accounts._connect() as db:  # noqa: SLF001
        await db.execute(
            "UPDATE user_totp SET last_used_step = ? WHERE user_id = ? AND last_used_step < ?",
            (step, user_id, step),
        )
        await db.commit()


async def status_for(user_id: int) -> dict[str, Any]:
    """Public status for the settings UI: enabled / pending / off + backup
    code count remaining."""
    row = await _get_row(user_id)
    if row is None:
        return {"enabled": False, "pending": False, "backup_codes_remaining": 0}
    return {
        "enabled": row["enabled_at"] is not None,
        "pending": row["enabled_at"] is None,
        "backup_codes_remaining": len(row["backup_codes_hashes"]) if row["enabled_at"] else 0,
    }


async def begin_setup(user_id: int, username: str) -> dict[str, Any]:
    """Generate a fresh secret + provisioning URI for the user.

    Replaces any in-progress provisioning row. Refuses when 2FA is already
    enabled — the user must explicitly disable first (re-rolling silently
    would be a footgun)."""
    existing = await _get_row(user_id)
    if existing and existing["enabled_at"] is not None:
        raise ValueError("2FA ist bereits aktiv — zuerst deaktivieren")
    secret = pyotp.random_base32()
    uri = pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=ISSUER)
    async with accounts._connect() as db:  # noqa: SLF001
        await db.execute(
            "INSERT INTO user_totp (user_id, secret_b32) VALUES (?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET secret_b32 = excluded.secret_b32, "
            "  enabled_at = NULL, backup_codes_json = '[]'",
            (user_id, secret),
        )
        await db.commit()
    return {
        "secret_b32": secret,
        "provisioning_uri": uri,
        "qr_svg": _qr_svg(uri),
    }


async def verify_setup(user_id: int, code: str) -> list[str]:
    """Finalise the pending setup: verify the supplied TOTP, mark enabled,
    generate + return the 8 backup codes (caller stores nothing — codes
    are shown to the user exactly once)."""
    row = await _get_row(user_id)
    if row is None or row["enabled_at"] is not None:
        raise ValueError("Kein laufender 2FA-Setup gefunden")
    step = _match_step(row["secret_b32"], code.strip().replace(" ", ""))
    if step is None:
        raise ValueError("TOTP-Code ungültig")
    backup_raw = _generate_backup_codes()
    backup_hashes = [_hash_code(c) for c in backup_raw]
    now = int(time.time())
    async with accounts._connect() as db:  # noqa: SLF001
        await db.execute(
            "UPDATE user_totp SET enabled_at = ?, backup_codes_json = ?,"
            " last_used_step = ? WHERE user_id = ?",
            (now, json.dumps(backup_hashes), step, user_id),
        )
        await db.commit()
    log.info("totp.enabled", user_id=user_id)
    return backup_raw


async def disable(user_id: int) -> None:
    """Wipe the user's 2FA configuration. Caller should re-authenticate
    before calling (passwort prompt in the UI)."""
    async with accounts._connect() as db:  # noqa: SLF001
        await db.execute("DELETE FROM user_totp WHERE user_id = ?", (user_id,))
        await db.commit()
    log.info("totp.disabled", user_id=user_id)


async def verify_login_code(user_id: int, code: str) -> bool:
    """Verify a TOTP or backup code at login time. Backup codes are
    one-shot: a match removes the code from the stored list. TOTP codes are
    one-shot per timestep — re-presenting an already-accepted code inside
    its validity window is rejected (replay protection)."""
    row = await _get_row(user_id)
    if row is None or row["enabled_at"] is None:
        return True  # 2FA not enabled → no second factor needed
    cleaned = code.strip().replace(" ", "").upper()
    # TOTP first (6-digit numeric)
    if cleaned.isdigit():
        step = _match_step(row["secret_b32"], cleaned)
        if step is None:
            return False
        if step <= row["last_used_step"]:
            log.info("totp.replay_rejected", user_id=user_id, step=step)
            return False
        await _bump_last_used_step(user_id, step)
        return True
    # Backup code path
    hashed = _hash_code(cleaned)
    if hashed in row["backup_codes_hashes"]:
        remaining = [h for h in row["backup_codes_hashes"] if h != hashed]
        async with accounts._connect() as db:  # noqa: SLF001
            await db.execute(
                "UPDATE user_totp SET backup_codes_json = ? WHERE user_id = ?",
                (json.dumps(remaining), user_id),
            )
            await db.commit()
        log.info("totp.backup_code_used", user_id=user_id, remaining=len(remaining))
        return True
    return False


async def is_enabled(user_id: int) -> bool:
    row = await _get_row(user_id)
    return row is not None and row["enabled_at"] is not None
