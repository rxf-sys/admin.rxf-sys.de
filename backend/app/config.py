from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---- App ----
    app_env: str = "production"
    log_level: str = "INFO"
    cors_origins: list[str] = Field(default_factory=lambda: ["https://admin.rxf-sys.de"])
    auth_enabled: bool = True

    # ---- Cloudflare Access ----
    # Team domain, e.g. "rxf-sys.cloudflareaccess.com"
    cf_access_team_domain: str = "rxf-sys.cloudflareaccess.com"
    # AUD tag of the Access Application (configured in CF dashboard)
    cf_access_aud: str = ""

    # ---- Proxmox VE ----
    proxmox_host: str = "192.168.2.200"
    proxmox_port: int = 8006
    proxmox_node: str = "rxf-sys"
    proxmox_token_id: str = ""  # e.g. "root@pam!admin-dashboard"
    proxmox_token_secret: str = ""
    proxmox_verify_tls: bool = False

    # ---- Proxmox Backup Server ----
    pbs_host: str = "192.168.2.209"
    pbs_port: int = 8007
    pbs_token_id: str = ""  # e.g. "root@pam!admin-dashboard"
    pbs_token_secret: str = ""
    pbs_datastore: str = "backup"
    pbs_verify_tls: bool = False

    # ---- Cloudflare API ----
    cf_account_id: str = "66464b06aae97e8cdfce53397aa03d99"
    cf_zone_id: str = ""
    cf_zone_name: str = "rxf-sys.de"
    cf_api_token: str = ""
    cf_tunnel_id: str = ""

    # ---- UniFi (local UCG-Ultra) ----
    # Preferred: create a UniFi Integration API key in the Network app
    # (Settings -> Control Plane -> Integrations -> Add API Key).
    # Falls back to legacy username/password cookie auth if the key is empty.
    unifi_host: str = "192.168.2.1"
    unifi_port: int = 443
    unifi_api_key: str = ""
    unifi_username: str = ""
    unifi_password: str = ""
    unifi_site: str = "default"
    unifi_verify_tls: bool = False

    # ---- Service probes ----
    # Maps subdomain -> internal LAN URL for the "INT" reachability check.
    # Public host is derived as <name>.{cf_zone_name}.
    probe_targets: dict[str, str] = Field(
        default_factory=lambda: {
            "vault":   "http://192.168.2.203",
            "cloud":   "http://192.168.2.206:11000",
            "photos":  "http://192.168.2.205:2283",
            "docs":    "http://192.168.2.205:8000",
            "media":   "http://192.168.2.207:8096",
            "ha":      "http://192.168.2.208:8123",
            "monitor": "http://192.168.2.204:3001",
            "pbs":     "https://192.168.2.209:8007",
        }
    )
    probe_timeout_s: float = 4.0

    # ---- Cache TTLs (seconds) ----
    cache_ttl_system: int = 15
    cache_ttl_services: int = 30
    cache_ttl_tunnel: int = 30
    cache_ttl_pbs: int = 60
    cache_ttl_unifi: int = 30
    cache_ttl_certs: int = 600
    cache_ttl_geoip: int = 21_600  # 6h; ISP info changes rarely

    # ---- IP Geolocation (for ISP name when UniFi doesn't expose it) ----
    geoip_enabled: bool = True

    # ---- Notifications ----
    # Discord/Slack-compatible incoming webhook URL. Empty = disabled.
    notify_webhook_url: str = ""
    # Service must stay degraded this long before we notify (anti-flap).
    notify_service_threshold_s: int = 180
    # Cert "expires soon" threshold in days.
    notify_cert_days: int = 14
    # Loop interval for the notification background task.
    notify_interval_s: int = 60


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
