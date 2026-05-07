from __future__ import annotations

from fastapi import APIRouter, Depends

from ..audit import recent
from ..auth import verify_cf_access

router = APIRouter(prefix="/api/audit", tags=["audit"], dependencies=[Depends(verify_cf_access)])


@router.get("")
async def get_audit(limit: int = 50) -> dict:
    return {"events": recent(min(max(limit, 1), 200))}
