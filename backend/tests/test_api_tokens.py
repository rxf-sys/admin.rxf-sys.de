"""Tests for the API token table — create/list/delete and the
``resolve_api_token`` auth path the verify_session dependency uses."""

from __future__ import annotations

import pytest

from app import accounts


@pytest.fixture
async def db(tmp_path, settings):
    settings_obj = settings.model_copy(
        update={"storage_db_path": str(tmp_path / "tokens.db")}
    )
    accounts.reset_for_tests("")
    await accounts.ensure_schema(settings_obj)
    yield
    accounts.reset_for_tests("")


async def test_create_returns_raw_token_once(db):
    user = await accounts.create_user("alice", "supersecret")
    raw, meta = await accounts.create_api_token(user["id"], "bot")
    assert raw.startswith("rxf_")
    assert len(raw) > 40
    assert meta["name"] == "bot"
    assert meta["token_prefix"] == raw[:accounts.TOKEN_PREFIX_LEN]
    assert meta["scope"] == "read"
    assert meta["expires_at"] is None


async def test_resolve_returns_user_and_bumps_last_used(db):
    user = await accounts.create_user("alice", "supersecret")
    raw, _ = await accounts.create_api_token(user["id"], "bot")
    resolved = await accounts.resolve_api_token(raw)
    assert resolved is not None
    assert resolved["username"] == "alice"
    tokens = await accounts.list_api_tokens(user_id=user["id"])
    assert tokens[0]["last_used_at"] is not None


async def test_resolve_rejects_unknown_token(db):
    assert await accounts.resolve_api_token("rxf_not_real") is None
    assert await accounts.resolve_api_token("missing_prefix") is None
    assert await accounts.resolve_api_token("") is None


async def test_resolve_rejects_disabled_owner(db):
    user = await accounts.create_user("alice", "supersecret")
    raw, _ = await accounts.create_api_token(user["id"], "bot")
    await accounts.update_user(user["id"], disabled=True)
    assert await accounts.resolve_api_token(raw) is None


async def test_resolve_rejects_expired(db):
    user = await accounts.create_user("alice", "supersecret")
    # ttl_days=1 sets expires_at to +1d; we cheat the column to be in the
    # past so the resolver's expiry check fires.
    raw, meta = await accounts.create_api_token(user["id"], "bot", ttl_days=1)
    import aiosqlite
    async with aiosqlite.connect(accounts._db_path) as dbconn:  # noqa: SLF001
        await dbconn.execute(
            "UPDATE api_tokens SET expires_at = 1 WHERE id = ?", (meta["id"],)
        )
        await dbconn.commit()
    assert await accounts.resolve_api_token(raw) is None


async def test_delete_scoped_to_owner(db):
    alice = await accounts.create_user("alice", "supersecret")
    bob = await accounts.create_user("bob", "supersecret")
    _, atok = await accounts.create_api_token(alice["id"], "alice-bot")
    # Bob can't delete alice's token via the user-scoped path.
    assert await accounts.delete_api_token(atok["id"], user_id=bob["id"]) is False
    assert await accounts.delete_api_token(atok["id"], user_id=alice["id"]) is True
