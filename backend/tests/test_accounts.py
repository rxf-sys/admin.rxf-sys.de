from __future__ import annotations

import time

import pytest

from app import accounts
from app.config import Settings


@pytest.fixture
async def db(tmp_path):
    """A fresh accounts database per test."""
    path = str(tmp_path / "accounts.db")
    accounts.reset_for_tests(path)
    s = Settings(storage_db_path=path, auth_enabled=True)
    await accounts.ensure_schema(s)
    return s


async def test_create_and_fetch_user(db):
    user = await accounts.create_user("robin", "supersecret", role="admin", email="r@x.de")
    assert user["username"] == "robin"
    assert user["role"] == "admin"
    assert "password_hash" not in user  # never leaked
    fetched = await accounts.get_user_by_id(user["id"])
    assert fetched is not None
    assert fetched["email"] == "r@x.de"


async def test_duplicate_username_rejected(db):
    await accounts.create_user("robin", "supersecret")
    with pytest.raises(accounts.AccountError):
        await accounts.create_user("ROBIN", "anotherpw")  # case-insensitive clash


async def test_authenticate_paths(db):
    await accounts.create_user("robin", "supersecret")
    assert await accounts.authenticate("robin", "supersecret") is not None
    assert await accounts.authenticate("robin", "wrong") is None
    assert await accounts.authenticate("ghost", "whatever") is None


async def test_disabled_user_cannot_authenticate(db):
    user = await accounts.create_user("robin", "supersecret")
    await accounts.update_user(user["id"], disabled=True)
    assert await accounts.authenticate("robin", "supersecret") is None


async def test_session_lifecycle(db):
    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=1)
    resolved = await accounts.resolve_session(token)
    assert resolved is not None
    assert resolved["id"] == user["id"]
    await accounts.delete_session(token)
    assert await accounts.resolve_session(token) is None


async def test_expired_session_rejected(db):
    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=-1)  # already expired
    assert await accounts.resolve_session(token) is None


async def test_disabling_user_kills_sessions(db):
    user = await accounts.create_user("robin", "supersecret")
    token = await accounts.create_session(user["id"], ttl_hours=24)
    await accounts.update_user(user["id"], disabled=True)
    assert await accounts.resolve_session(token) is None


async def test_user_settings_roundtrip(db):
    user = await accounts.create_user("robin", "supersecret")
    assert await accounts.get_user_settings(user["id"]) == {}
    await accounts.set_user_settings(user["id"], {"theme": "light", "density": "cozy"})
    assert await accounts.get_user_settings(user["id"]) == {
        "theme": "light",
        "density": "cozy",
    }


async def test_set_password_changes_credentials(db):
    user = await accounts.create_user("robin", "oldpassword")
    await accounts.set_password(user["id"], "newpassword")
    assert await accounts.authenticate("robin", "oldpassword") is None
    assert await accounts.authenticate("robin", "newpassword") is not None


async def test_admin_count_and_delete(db):
    a1 = await accounts.create_user("admin1", "supersecret", role="admin")
    await accounts.create_user("user1", "supersecret", role="user")
    assert await accounts.admin_count() == 1
    assert await accounts.admin_count(exclude_user_id=a1["id"]) == 0
    await accounts.delete_user(a1["id"])
    assert await accounts.get_user_by_id(a1["id"]) is None


async def test_bootstrap_creates_first_admin_only(db):
    s = Settings(
        storage_db_path=db.storage_db_path,
        bootstrap_admin_user="root",
        bootstrap_admin_password="bootstrap-pw",
    )
    await accounts.bootstrap_admin(s)
    users = await accounts.list_users()
    assert len(users) == 1
    assert users[0]["role"] == "admin"
    # Running again is a no-op once an account exists.
    await accounts.bootstrap_admin(s)
    assert len(await accounts.list_users()) == 1


async def test_cleanup_expired_sessions(db):
    user = await accounts.create_user("robin", "supersecret")
    await accounts.create_session(user["id"], ttl_hours=-1)
    await accounts.create_session(user["id"], ttl_hours=24)
    removed = await accounts.cleanup_expired_sessions()
    assert removed == 1
    _ = time.time()


async def test_list_active_sessions_excludes_expired_and_joins_user(db):
    alice = await accounts.create_user("alice", "supersecret", role="admin")
    bob = await accounts.create_user("bob", "supersecret")
    # Two live sessions and one already-expired session.
    await accounts.create_session(alice["id"], ttl_hours=24)
    await accounts.create_session(bob["id"], ttl_hours=24)
    await accounts.create_session(bob["id"], ttl_hours=-1)

    rows = await accounts.list_active_sessions()

    assert len(rows) == 2
    usernames = {r["username"] for r in rows}
    assert usernames == {"alice", "bob"}
    # User identity must be attached to each row.
    alice_row = next(r for r in rows if r["username"] == "alice")
    assert alice_row["role"] == "admin"
    assert alice_row["email"] is None
    # Token is never returned in full — only the short prefix.
    assert all(len(r["token_prefix"]) == 8 for r in rows)


async def test_revoke_session_matches_prefix(db):
    user = await accounts.create_user("robin", "supersecret")
    token1 = await accounts.create_session(user["id"], ttl_hours=24)
    await accounts.create_session(user["id"], ttl_hours=24)

    revoked = await accounts.revoke_session(token1[:8])
    assert revoked == 1
    # The other session is still live.
    assert len(await accounts.list_active_sessions()) == 1


async def test_revoke_session_rejects_short_prefix(db):
    user = await accounts.create_user("robin", "supersecret")
    await accounts.create_session(user["id"], ttl_hours=24)
    # Guard against accidentally revoking every session with an empty/very
    # short prefix.
    assert await accounts.revoke_session("") == 0
    assert await accounts.revoke_session("ab") == 0
    assert len(await accounts.list_active_sessions()) == 1
