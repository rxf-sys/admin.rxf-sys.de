#!/usr/bin/env python3
"""Promote an existing account to the admin role.

When the dashboard is bootstrapped fresh, the first account created via
``BOOTSTRAP_ADMIN_USER`` already has ``role = admin``. Any later account is
created through the dashboard's own UI by an admin — but if you've lost
admin access (single admin disabled, role manually demoted in SQL, etc.)
this tool brings a named user back to ``admin`` against the live database.

Usage::

    cd /opt/rxf-admin/backend
    python -m tools.promote_admin <username>

Or inside the backend container::

    docker compose exec backend python -m tools.promote_admin <username>

Reads ``STORAGE_DB_PATH`` (and the rest of the settings) from the standard
``.env`` lookup order, just like the running backend, so it always points at
the same SQLite file the API is using.
"""

from __future__ import annotations

import asyncio
import sys

from app import accounts
from app.config import get_settings


async def _promote(username: str) -> int:
    settings = get_settings()
    await accounts.ensure_schema(settings)

    users = await accounts.list_users()
    match = next(
        (u for u in users if u["username"].lower() == username.lower()),
        None,
    )
    if match is None:
        print(f"error: no user named {username!r} found", file=sys.stderr)
        print(
            "       run with no admin? bootstrap one with BOOTSTRAP_ADMIN_USER + BOOTSTRAP_ADMIN_PASSWORD instead.",
            file=sys.stderr,
        )
        return 2

    if match["role"] == "admin" and not match["disabled"]:
        print(f"{match['username']} is already an active admin — nothing to do.")
        return 0

    updated = await accounts.update_user(
        match["id"], role="admin", disabled=False
    )
    assert updated is not None
    print(
        f"promoted {updated['username']} (id={updated['id']}) to role=admin, "
        f"disabled={updated['disabled']}"
    )
    return 0


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] in {"-h", "--help"}:
        print(__doc__)
        return 0 if len(sys.argv) == 2 and sys.argv[1] in {"-h", "--help"} else 1
    return asyncio.run(_promote(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())
