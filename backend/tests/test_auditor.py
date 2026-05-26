from __future__ import annotations

import asyncio
import os
import stat

import pytest

from app import auditor
from app.config import Settings


def _write_script(tmp_path, body: str) -> str:
    p = tmp_path / "audit.sh"
    p.write_text(body)
    p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(p)


@pytest.fixture
async def db(tmp_path):
    """Per-test SQLite file for the auditor module."""
    db_path = tmp_path / "auditor.db"
    auditor.reset_for_tests(str(db_path))
    await auditor.ensure_schema(Settings(storage_db_path=str(db_path)))
    yield
    auditor.reset_for_tests()


@pytest.mark.asyncio
async def test_disabled_when_path_empty():
    auditor.reset_for_tests()
    await auditor.ensure_schema(Settings(storage_db_path=""))
    assert await auditor.list_runs() == []
    assert await auditor.get_run("anything") is None


@pytest.mark.asyncio
async def test_full_run_parses_summary_and_findings(db, tmp_path):
    script = _write_script(
        tmp_path,
        """#!/usr/bin/env bash
        echo "preamble line that must be ignored"
        printf '%s\\n' '{"summary":{"ok":2,"warn":1,"err":0,"skipped":0},"findings":[{"id":"a","status":"ok","title":"A","detail":""},{"id":"b","status":"warn","title":"B","detail":"x"}]}'
        """,
    )
    settings = Settings(storage_db_path=os.environ.get("STORAGE_DB_PATH", ""), audit_script_path=script)
    # Force the module-level _db_path used by start_run.
    auditor.reset_for_tests(_db_path_for(db))
    await auditor.ensure_schema(Settings(storage_db_path=_db_path_for(db)))

    job_id = await auditor.start_run(settings, started_by="tester")
    await _wait_until_done(job_id)

    run = await auditor.get_run(job_id)
    assert run is not None
    assert run["status"] == "warn"  # summary has 1 warn, 0 err
    assert run["exit_code"] == 0
    assert run["summary"] == {"ok": 2, "warn": 1, "err": 0, "skipped": 0}
    assert [f["id"] for f in run["findings"]] == ["a", "b"]
    assert run["started_by"] == "tester"
    assert run["location"] == "local"


@pytest.mark.asyncio
async def test_err_status_when_summary_has_errors(db, tmp_path):
    script = _write_script(
        tmp_path,
        """#!/usr/bin/env bash
        printf '%s\\n' '{"summary":{"ok":0,"warn":0,"err":2,"skipped":0},"findings":[]}'
        """,
    )
    settings = Settings(storage_db_path=_db_path_for(db), audit_script_path=script)
    job_id = await auditor.start_run(settings, started_by="tester")
    await _wait_until_done(job_id)
    run = await auditor.get_run(job_id)
    assert run is not None and run["status"] == "err"


@pytest.mark.asyncio
async def test_invalid_output_marks_run_as_err(db, tmp_path):
    script = _write_script(
        tmp_path,
        """#!/usr/bin/env bash
        echo "not json at all"
        exit 0
        """,
    )
    settings = Settings(storage_db_path=_db_path_for(db), audit_script_path=script)
    job_id = await auditor.start_run(settings, started_by="tester")
    await _wait_until_done(job_id)
    run = await auditor.get_run(job_id)
    assert run is not None
    assert run["status"] == "err"
    assert "JSON" in (run["error"] or "")
    assert "not json at all" in run["log_output"]


@pytest.mark.asyncio
async def test_missing_script_marks_run_as_err(db, tmp_path):
    settings = Settings(
        storage_db_path=_db_path_for(db),
        audit_script_path=str(tmp_path / "does-not-exist.sh"),
    )
    job_id = await auditor.start_run(settings, started_by="tester")
    await _wait_until_done(job_id)
    run = await auditor.get_run(job_id)
    assert run is not None and run["status"] == "err"
    assert "nicht gefunden" in (run["error"] or "")


@pytest.mark.asyncio
async def test_concurrent_run_raises_busy(db, tmp_path):
    # A script that blocks long enough for the second start_run to race it.
    script = _write_script(
        tmp_path,
        """#!/usr/bin/env bash
        sleep 0.5
        printf '%s\\n' '{"summary":{"ok":0,"warn":0,"err":0,"skipped":0},"findings":[]}'
        """,
    )
    settings = Settings(storage_db_path=_db_path_for(db), audit_script_path=script)
    first = await auditor.start_run(settings, started_by="a")
    with pytest.raises(auditor.AuditorBusy):
        await auditor.start_run(settings, started_by="b")
    assert auditor.current_job() == first
    await _wait_until_done(first)
    assert auditor.current_job() is None


@pytest.mark.asyncio
async def test_timeout_marks_run_as_timeout(db, tmp_path):
    script = _write_script(
        tmp_path,
        """#!/usr/bin/env bash
        sleep 5
        """,
    )
    settings = Settings(
        storage_db_path=_db_path_for(db),
        audit_script_path=script,
        audit_timeout_s=1,
    )
    job_id = await auditor.start_run(settings, started_by="tester")
    await _wait_until_done(job_id, max_seconds=5)
    run = await auditor.get_run(job_id)
    assert run is not None and run["status"] == "timeout"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _db_path_for(_) -> str:
    """Pull the db path the fixture configured back out of the module."""
    return auditor._db_path  # noqa: SLF001 - test helper


async def _wait_until_done(job_id: str, max_seconds: float = 3.0) -> None:
    deadline = asyncio.get_event_loop().time() + max_seconds
    while asyncio.get_event_loop().time() < deadline:
        run = await auditor.get_run(job_id)
        if run is not None and run["status"] != "running":
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"audit run {job_id} did not finish in {max_seconds}s")
