"""End-to-end tests for the audit-runner router (/api/audit/*)."""

from __future__ import annotations

import asyncio
import stat

import httpx
import pytest
from fastapi import FastAPI

from app import auditor
from app.config import get_settings
from app.routers import auditor as auditor_router


def _write_script(path, body: str) -> str:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(path)


@pytest.fixture
async def client(tmp_path, monkeypatch):
    db = str(tmp_path / "auditor-router.db")
    script = _write_script(
        tmp_path / "audit.sh",
        """#!/usr/bin/env bash
        printf '%s\\n' '{"summary":{"ok":1,"warn":0,"err":0,"skipped":0},"findings":[{"id":"x","status":"ok","title":"X","detail":""}]}'
        """,
    )
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("STORAGE_DB_PATH", db)
    monkeypatch.setenv("AUDIT_SCRIPT_PATH", script)
    monkeypatch.setenv("AUDIT_TIMEOUT_S", "10")
    get_settings.cache_clear()
    auditor.reset_for_tests(db)
    await auditor.ensure_schema(get_settings())

    app = FastAPI()
    app.include_router(auditor_router.router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    auditor.reset_for_tests()
    get_settings.cache_clear()


async def _wait_done(client: httpx.AsyncClient, job_id: str, max_seconds: float = 3.0) -> dict:
    deadline = asyncio.get_event_loop().time() + max_seconds
    while asyncio.get_event_loop().time() < deadline:
        r = await client.get(f"/api/audit/jobs/{job_id}")
        assert r.status_code == 200
        data = r.json()
        if data["status"] != "running":
            return data
        await asyncio.sleep(0.05)
    raise AssertionError(f"audit run {job_id} did not finish in time")


async def test_run_and_inspect_job(client):
    r = await client.post("/api/audit/run")
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    final = await _wait_done(client, job_id)
    assert final["status"] == "ok"
    assert final["summary"] == {"ok": 1, "warn": 0, "err": 0, "skipped": 0}
    assert [f["id"] for f in final["findings"]] == ["x"]
    # Single-job endpoint also exposes the raw log.
    assert "log_output" in final


async def test_concurrent_run_returns_409(client, tmp_path, monkeypatch):
    # Switch to a slow script for this test so we can race the second POST.
    slow = _write_script(
        tmp_path / "slow.sh",
        """#!/usr/bin/env bash
        sleep 0.4
        printf '%s\\n' '{"summary":{"ok":0,"warn":0,"err":0,"skipped":0},"findings":[]}'
        """,
    )
    monkeypatch.setenv("AUDIT_SCRIPT_PATH", slow)
    get_settings.cache_clear()

    r1 = await client.post("/api/audit/run")
    assert r1.status_code == 202
    r2 = await client.post("/api/audit/run")
    assert r2.status_code == 409
    # detail is a plain string now (was a dict, which serialised badly in
    # the frontend toast); the in-flight job id is surfaced via header so
    # a polling client can still find it.
    assert r2.json()["detail"] == "audit already running"
    assert r2.headers["X-Running-Job-Id"] == r1.json()["job_id"]
    await _wait_done(client, r1.json()["job_id"])


async def test_jobs_list_returns_history(client):
    r = await client.post("/api/audit/run")
    await _wait_done(client, r.json()["job_id"])

    listing = (await client.get("/api/audit/jobs")).json()
    assert listing["current_job_id"] is None  # finished
    assert len(listing["jobs"]) == 1
    # The list endpoint omits the heavy log payload.
    assert "log_output" not in listing["jobs"][0]


async def test_unknown_job_id_returns_404(client):
    r = await client.get("/api/audit/jobs/does-not-exist")
    assert r.status_code == 404
