from __future__ import annotations

import pytest

from app.config import Settings


@pytest.fixture
def settings() -> Settings:
    """Test Settings populated with predictable values; bypass .env loading."""
    return Settings(
        app_env="test",
        auth_enabled=False,
        proxmox_host="pve.test",
        proxmox_port=8006,
        proxmox_node="test-node",
        proxmox_token_id="root@pam!test",
        proxmox_token_secret="secret",
        proxmox_verify_tls=False,
        pbs_host="pbs.test",
        pbs_port=8007,
        pbs_token_id="root@pam!test",
        pbs_token_secret="pbs-secret",
        pbs_datastore="backup",
        pbs_verify_tls=False,
        cf_account_id="acct-test",
        cf_zone_id="zone-test",
        cf_zone_name="example.test",
        cf_api_token="cf-token",
        cf_tunnel_id="tun-test",
        cf_access_aud="aud-test",
    )
