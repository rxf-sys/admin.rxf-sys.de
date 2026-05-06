from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import verify_cf_access
from ..cache import cache
from ..clients import pbs
from ..config import Settings, get_settings
from ..models import BackupSummary

router = APIRouter(prefix="/api/backups", tags=["backups"], dependencies=[Depends(verify_cf_access)])


@router.get("", response_model=BackupSummary)
async def get_backups(settings: Settings = Depends(get_settings)) -> BackupSummary:
    async def loader() -> BackupSummary:
        return await pbs.fetch_backup_summary(settings)

    return await cache.get_or_set("backups", settings.cache_ttl_pbs, loader)
