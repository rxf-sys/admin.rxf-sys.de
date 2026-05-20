from __future__ import annotations

import pytest

from app import registry
from app.config import Settings


@pytest.fixture
async def db(tmp_path):
    """Per-test SQLite file for the registry module."""
    db_path = tmp_path / "registry.db"
    registry.reset_for_tests(str(db_path))
    await registry.ensure_schema(Settings(storage_db_path=str(db_path)))
    yield
    registry.reset_for_tests()


@pytest.mark.asyncio
async def test_disabled_when_path_empty():
    registry.reset_for_tests()
    await registry.ensure_schema(Settings(storage_db_path=""))
    assert await registry.list_services() == []
    assert await registry.list_guest_labels() == {}
    with pytest.raises(registry.RegistryError):
        await registry.create_service(name="x", internal_url="http://x")


@pytest.mark.asyncio
async def test_service_crud_roundtrip(db):
    created = await registry.create_service(
        name="Grafana",
        internal_url="http://192.168.2.50:3000",
        icon="monitor",
        desc="Dashboards",
        created_by="admin",
    )
    assert created["id"].startswith("custom-")
    assert created["custom"] is True
    assert created["ext_url"] is None

    listed = await registry.list_services()
    assert len(listed) == 1

    updated = await registry.update_service(created["id"], name="Grafana v2")
    assert updated is not None and updated["name"] == "Grafana v2"

    assert await registry.delete_service(created["id"]) is True
    assert await registry.delete_service(created["id"]) is False
    assert await registry.list_services() == []


@pytest.mark.asyncio
async def test_service_rejects_bad_url(db):
    with pytest.raises(registry.RegistryError):
        await registry.create_service(name="bad", internal_url="ftp://nope")
    with pytest.raises(registry.RegistryError):
        await registry.create_service(name="", internal_url="http://ok")


@pytest.mark.asyncio
async def test_update_unknown_service_returns_none(db):
    assert await registry.update_service("custom-deadbeef", name="x") is None


@pytest.mark.asyncio
async def test_guest_label_upsert_and_clear(db):
    await registry.set_guest_label(201, "Proxmox Backup", updated_by="admin")
    assert await registry.list_guest_labels() == {201: "Proxmox Backup"}

    # Upsert overwrites the existing row.
    await registry.set_guest_label(201, "PBS", updated_by="admin")
    assert await registry.list_guest_labels() == {201: "PBS"}

    await registry.delete_guest_label(201)
    assert await registry.list_guest_labels() == {}

    with pytest.raises(registry.RegistryError):
        await registry.set_guest_label(201, "   ")
