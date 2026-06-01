"""Audit runner: executes the curated audit shell script and persists the
results, so the dashboard can show "Audit starten -> Bericht" without losing
history across restarts.

The script either runs locally inside the backend container (default) or
on a remote host via SSH when ``settings.audit_ssh_host`` is set. Only one
audit may run at a time (module-level mutex) — concurrent ``POST /run`` calls
get HTTP 409.

Output contract: the script must print a single JSON object to stdout of the
shape ``{"summary": {"ok": N, "warn": N, "err": N, "skipped": N},
"findings": [{"id": "...", "status": "ok|warn|err|skipped", "title": "...",
"detail": "...", "category": "updates|...", "fix": "..."}, ...]}``.
Both ``category`` and ``fix`` on a finding are optional — the frontend
derives a category from the leading dot-segment of ``id`` when ``category``
is absent, and only renders the FIX line when a snippet is provided.
Anything else is treated as an error and the raw stdout/stderr is kept in
``log_output`` for diagnosis.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from pathlib import Path
from typing import Any

import aiosqlite
import structlog

from .config import Settings

log = structlog.get_logger("auditor")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_runs (
    id          TEXT    PRIMARY KEY,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    status      TEXT    NOT NULL,
    exit_code   INTEGER,
    started_by  TEXT,
    location    TEXT    NOT NULL,
    summary     TEXT,
    findings    TEXT,
    log_output  TEXT,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_runs_started ON audit_runs (started_at DESC);
"""


class AuditorBusy(Exception):
    """Raised when another audit is already in flight."""


_db_path: str = ""
_lock = asyncio.Lock()
_running: bool = False
_current_job: str | None = None


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


async def ensure_schema(settings: Settings) -> None:
    global _db_path
    _db_path = settings.storage_db_path
    if not _db_path:
        log.info("auditor.disabled", reason="storage_db_path is empty")
        return
    Path(_db_path).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(_db_path) as db:
        await db.executescript(_SCHEMA)
        await db.commit()
    log.info("auditor.ready", db=_db_path)


def _connect() -> aiosqlite.Connection:
    return aiosqlite.connect(_db_path)


# ---------------------------------------------------------------------------
# Row mapping + CRUD
# ---------------------------------------------------------------------------


def _row_to_run(row: aiosqlite.Row, *, include_log: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": row["id"],
        "started_at": int(row["started_at"]),
        "finished_at": int(row["finished_at"]) if row["finished_at"] else None,
        "status": row["status"],
        "exit_code": int(row["exit_code"]) if row["exit_code"] is not None else None,
        "started_by": row["started_by"],
        "location": row["location"],
        "summary": _maybe_json(row["summary"]),
        "findings": _maybe_json(row["findings"]) or [],
        "error": row["error"],
    }
    if include_log:
        d["log_output"] = row["log_output"] or ""
    return d


def _maybe_json(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


async def list_runs(limit: int = 20) -> list[dict[str, Any]]:
    if not _db_path:
        return []
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM audit_runs ORDER BY started_at DESC LIMIT ?",
            (max(1, min(limit, 100)),),
        ) as cur:
            return [_row_to_run(r) for r in await cur.fetchall()]


async def get_run(job_id: str) -> dict[str, Any] | None:
    if not _db_path:
        return None
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM audit_runs WHERE id = ?", (job_id,)
        ) as cur:
            row = await cur.fetchone()
            return _row_to_run(row, include_log=True) if row else None


async def _insert_running(job_id: str, started_by: str, location: str) -> None:
    async with _connect() as db:
        await db.execute(
            """
            INSERT INTO audit_runs (id, started_at, status, started_by, location)
            VALUES (?, ?, 'running', ?, ?)
            """,
            (job_id, int(time.time()), started_by, location),
        )
        await db.commit()


async def _finalise_run(
    job_id: str,
    *,
    status: str,
    exit_code: int | None,
    summary: dict | None,
    findings: list | None,
    log_output: str,
    error: str | None,
) -> None:
    async with _connect() as db:
        await db.execute(
            """
            UPDATE audit_runs
            SET finished_at = ?, status = ?, exit_code = ?, summary = ?,
                findings = ?, log_output = ?, error = ?
            WHERE id = ?
            """,
            (
                int(time.time()),
                status,
                exit_code,
                json.dumps(summary) if summary is not None else None,
                json.dumps(findings) if findings is not None else None,
                log_output,
                error,
                job_id,
            ),
        )
        await db.commit()


# ---------------------------------------------------------------------------
# Script resolution + execution
# ---------------------------------------------------------------------------


def _default_script_path() -> Path:
    # ``app/auditor.py`` -> ``app/`` -> ``backend/`` -> ``backend/scripts/audit.sh``
    return Path(__file__).resolve().parent.parent / "scripts" / "audit.sh"


def _resolve_script(settings: Settings) -> Path:
    raw = settings.audit_script_path.strip()
    return Path(raw).expanduser() if raw else _default_script_path()


def _build_command(settings: Settings, script: Path) -> tuple[list[str], bytes, str]:
    """Return (argv, stdin_bytes, location_label) for the audit run."""
    script_bytes = script.read_bytes()
    if settings.audit_ssh_host:
        # Pin known_hosts onto the /data volume so the host fingerprint
        # survives container restarts — without this, every redeploy
        # would silently re-accept the host key (StrictHostKeyChecking
        # accept-new) which defeats the point of the check.
        known_hosts = "/data/.ssh_known_hosts"
        argv = [
            "ssh",
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"UserKnownHostsFile={known_hosts}",
            "-o", "ConnectTimeout=10",
        ]
        if settings.audit_ssh_key_path:
            argv += ["-i", settings.audit_ssh_key_path]
        argv += [f"{settings.audit_ssh_user}@{settings.audit_ssh_host}", "bash", "-s"]
        return argv, script_bytes, f"ssh:{settings.audit_ssh_host}"
    return ["bash", "-s"], script_bytes, "local"


async def _execute(job_id: str, settings: Settings) -> None:
    """Background task: run the script, parse its output, persist the result."""
    global _running, _current_job
    try:
        script = _resolve_script(settings)
        if not script.is_file():
            await _finalise_run(
                job_id,
                status="err",
                exit_code=None,
                summary=None,
                findings=None,
                log_output="",
                error=f"Audit-Skript nicht gefunden: {script}",
            )
            return
        argv, stdin_bytes, _ = _build_command(settings, script)

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            await _finalise_run(
                job_id,
                status="err",
                exit_code=None,
                summary=None,
                findings=None,
                log_output="",
                error=f"Konnte Audit nicht starten: {e}",
            )
            return

        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(input=stdin_bytes), timeout=settings.audit_timeout_s
            )
        except asyncio.TimeoutError:
            # SIGKILL the subprocess; ``proc.wait()`` after a cancelled
            # ``communicate`` can hang in asyncio's child watcher until the
            # original duration elapses, so we cap it explicitly. The kernel
            # has already reaped the child by this point.
            proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                pass
            await _finalise_run(
                job_id,
                status="timeout",
                exit_code=None,
                summary=None,
                findings=None,
                log_output="",
                error=f"Audit hat das Timeout überschritten ({settings.audit_timeout_s}s)",
            )
            return

        stdout = stdout_b.decode("utf-8", errors="replace")
        stderr = stderr_b.decode("utf-8", errors="replace")
        combined_log = stdout if not stderr else f"{stdout}\n--- stderr ---\n{stderr}"
        exit_code = proc.returncode

        # Parse the last JSON object from stdout — the script may emit extra
        # diagnostic lines but its final line is the JSON report.
        parsed: dict | None = None
        for line in reversed(stdout.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    parsed = json.loads(line)
                    break
                except ValueError:
                    continue

        if parsed is None:
            await _finalise_run(
                job_id,
                status="err",
                exit_code=exit_code,
                summary=None,
                findings=None,
                log_output=combined_log,
                error="Audit-Ausgabe enthielt kein gültiges JSON",
            )
            return

        summary = parsed.get("summary") if isinstance(parsed.get("summary"), dict) else None
        findings_raw = parsed.get("findings")
        findings = findings_raw if isinstance(findings_raw, list) else None

        # Derive run-level status from the summary.
        status_label = "ok"
        if exit_code != 0:
            status_label = "err"
        elif summary and int(summary.get("err", 0)) > 0:
            status_label = "err"
        elif summary and int(summary.get("warn", 0)) > 0:
            status_label = "warn"

        await _finalise_run(
            job_id,
            status=status_label,
            exit_code=exit_code,
            summary=summary,
            findings=findings,
            log_output=combined_log,
            error=None,
        )
    except Exception as e:  # noqa: BLE001 - never let the background task die silently
        log.exception("auditor.execute_failed", job_id=job_id)
        await _finalise_run(
            job_id,
            status="err",
            exit_code=None,
            summary=None,
            findings=None,
            log_output="",
            error=f"Unerwarteter Fehler: {e}",
        )
    finally:
        async with _lock:
            _running = False
            _current_job = None


async def start_run(settings: Settings, *, started_by: str) -> str:
    """Kick off an audit asynchronously. Returns the new job_id.

    Raises ``AuditorBusy`` when another audit is already in flight.
    """
    if not _db_path:
        raise RuntimeError("Auditor nicht initialisiert (storage_db_path leer)")
    global _running, _current_job
    job_id = f"audit-{int(time.time())}-{secrets.token_hex(3)}"
    async with _lock:
        if _running:
            raise AuditorBusy(_current_job or "unknown")
        location = (
            f"ssh:{settings.audit_ssh_host}" if settings.audit_ssh_host else "local"
        )
        await _insert_running(job_id, started_by, location)
        _running = True
        _current_job = job_id
    # Launch the background task outside the lock so the POST returns fast.
    asyncio.create_task(_execute(job_id, settings))
    log.info("auditor.started", job_id=job_id, started_by=started_by, location=location)
    return job_id


def current_job() -> str | None:
    """Return the in-flight job id, or None when no audit is running."""
    return _current_job if _running else None


def reset_for_tests(db_path: str = "") -> None:
    """Test hook: reset module state and point at a specific (or no) DB."""
    global _db_path, _running, _current_job
    _db_path = db_path
    _running = False
    _current_job = None
