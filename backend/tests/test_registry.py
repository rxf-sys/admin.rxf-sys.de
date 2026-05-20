from __future__ import annotations

import pytest

from app import registry
from app.config import Settings


@pytest.fixture
async def db(tmp_path):
    """Per-test SQLite file for the registry module. Yields the Settings."""
    db_path = tmp_path / "registry.db"
    registry.reset_for_tests(str(db_path))
    s = Settings(storage_db_path=str(db_path))
    await registry.ensure_schema(s)
    yield s
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
async def test_seed_builtin_services_runs_once(db):
    catalogue = [
        {"id": "vault", "name": "vault", "icon": "lock", "desc": "Vaultwarden"},
        {"id": "pbs", "name": "pbs", "icon": "archive", "desc": "PBS"},
    ]
    await registry.seed_builtin_services(db, catalogue)
    seeded = await registry.list_services()
    assert {s["id"] for s in seeded} == {"vault", "pbs"}
    # Seeded built-ins are normal registry rows — editable and removable.
    assert all(s["custom"] is True for s in seeded)

    # Idempotent: a second run must not duplicate.
    await registry.seed_builtin_services(db, catalogue)
    assert len(await registry.list_services()) == 2

    # A removed built-in is not re-seeded on the next run.
    await registry.delete_service("vault")
    await registry.seed_builtin_services(db, catalogue)
    assert {s["id"] for s in await registry.list_services()} == {"pbs"}


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
