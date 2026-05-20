from __future__ import annotations

from fastapi import APIRouter, Depends

from ..audit import recent
from ..auth import verify_session

router = APIRouter(prefix="/api/audit", tags=["audit"], dependencies=[Depends(verify_session)])

events_router = APIRouter(
    prefix="/api/events", tags=["events"], dependencies=[Depends(verify_session)]
)


@router.get("")
async def get_audit(limit: int = 50) -> dict:
    return {"events": recent(min(max(limit, 1), 200))}


@events_router.get("")
async def get_events(limit: int = 50) -> dict:
    """Alias for ``/api/audit`` — exposed under a more dashboard-friendly name
    for the upcoming Activity feed component."""
    return {"events": recent(min(max(limit, 1), 200))}
