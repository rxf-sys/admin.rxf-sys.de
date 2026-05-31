"""TOTP setup + verify + disable + login-code flow."""

from __future__ import annotations

import pyotp
import pytest

from app import accounts, totp


@pytest.fixture
async def db(tmp_path, settings):
    settings_obj = settings.model_copy(
        update={"storage_db_path": str(tmp_path / "totp.db")}
    )
    accounts.reset_for_tests("")
    await accounts.ensure_schema(settings_obj)
    yield
    accounts.reset_for_tests("")


async def test_status_for_unprovisioned(db):
    user = await accounts.create_user("alice", "supersecret")
    s = await totp.status_for(user["id"])
    assert s == {"enabled": False, "pending": False, "backup_codes_remaining": 0}


async def test_setup_then_verify_then_status(db):
    user = await accounts.create_user("alice", "supersecret")
    setup = await totp.begin_setup(user["id"], user["username"])
    assert setup["secret_b32"]
    assert setup["provisioning_uri"].startswith("otpauth://totp/")
    assert "<svg" in setup["qr_svg"]

    # Pending state — secret stored, enabled_at NULL.
    s = await totp.status_for(user["id"])
    assert s["enabled"] is False and s["pending"] is True

    # Compute a real TOTP from the issued secret.
    code = pyotp.TOTP(setup["secret_b32"]).now()
    backup = await totp.verify_setup(user["id"], code)
    assert len(backup) == totp.BACKUP_CODE_COUNT
    assert all("-" in c for c in backup)

    s = await totp.status_for(user["id"])
    assert s["enabled"] is True and s["pending"] is False
    assert s["backup_codes_remaining"] == totp.BACKUP_CODE_COUNT


async def test_verify_rejects_wrong_code(db):
    user = await accounts.create_user("alice", "supersecret")
    await totp.begin_setup(user["id"], user["username"])
    with pytest.raises(ValueError):
        await totp.verify_setup(user["id"], "000000")


async def test_login_code_accepts_totp_and_consumes_backup(db):
    user = await accounts.create_user("alice", "supersecret")
    setup = await totp.begin_setup(user["id"], user["username"])
    code = pyotp.TOTP(setup["secret_b32"]).now()
    backup = await totp.verify_setup(user["id"], code)

    # Real TOTP works.
    new_code = pyotp.TOTP(setup["secret_b32"]).now()
    assert await totp.verify_login_code(user["id"], new_code) is True

    # Backup code works exactly once.
    assert await totp.verify_login_code(user["id"], backup[0]) is True
    assert await totp.verify_login_code(user["id"], backup[0]) is False
    s = await totp.status_for(user["id"])
    assert s["backup_codes_remaining"] == totp.BACKUP_CODE_COUNT - 1


async def test_login_code_for_user_without_2fa_passes(db):
    """No TOTP row → no second factor required; verify_login_code returns True
    so the login path doesn't accidentally reject 2FA-free users."""
    user = await accounts.create_user("alice", "supersecret")
    assert await totp.verify_login_code(user["id"], "anything") is True


async def test_begin_setup_refuses_when_already_enabled(db):
    user = await accounts.create_user("alice", "supersecret")
    setup = await totp.begin_setup(user["id"], user["username"])
    code = pyotp.TOTP(setup["secret_b32"]).now()
    await totp.verify_setup(user["id"], code)
    with pytest.raises(ValueError):
        await totp.begin_setup(user["id"], user["username"])


async def test_disable_wipes_the_row(db):
    user = await accounts.create_user("alice", "supersecret")
    setup = await totp.begin_setup(user["id"], user["username"])
    code = pyotp.TOTP(setup["secret_b32"]).now()
    await totp.verify_setup(user["id"], code)
    await totp.disable(user["id"])
    s = await totp.status_for(user["id"])
    assert s["enabled"] is False and s["pending"] is False
