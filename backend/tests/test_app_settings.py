"""Smoke tests for the app_settings key/value bucket — the foundation that
all runtime-editable configuration sits on (instance, ntfy, smtp, audit-auto).
"""

from __future__ import annotations

import pytest

from app import accounts


@pytest.fixture
async def db(tmp_path, settings):
    settings_obj = settings.model_copy(
        update={"storage_db_path": str(tmp_path / "app-settings.db")}
    )
    accounts.reset_for_tests("")
    await accounts.ensure_schema(settings_obj)
    yield
    accounts.reset_for_tests("")


async def test_get_returns_none_when_unset(db):
    assert await accounts.get_app_setting("instance_name") is None


async def test_set_then_get_roundtrip(db):
    await accounts.set_app_setting("instance_name", "Homeserver")
    assert await accounts.get_app_setting("instance_name") == "Homeserver"


async def test_set_is_upsert(db):
    await accounts.set_app_setting("k", "v1")
    await accounts.set_app_setting("k", "v2")
    assert await accounts.get_app_setting("k") == "v2"


async def test_get_with_no_db_path_returns_none(db):
    accounts.reset_for_tests("")
    assert await accounts.get_app_setting("anything") is None
