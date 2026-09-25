from dataclasses import dataclass
import os


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().casefold() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    api_key: str = os.getenv("ALFRED_API_KEY", "")
    tailscale_user: str = os.getenv("ALFRED_TAILSCALE_USER", "")
    web_origin: str = os.getenv("ALFRED_WEB_ORIGIN", "")
    timezone: str = os.getenv("ALFRED_TIMEZONE", "Europe/London") or "Europe/London"
    ollama_url: str = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")
    chat_model: str = os.getenv("OLLAMA_CHAT_MODEL", "qwen3:4b")
    router_model: str = os.getenv("OLLAMA_ROUTER_MODEL", "qwen3:1.7b")
    sqlite_path: str = os.getenv("SQLITE_PATH", "/data/alfred.db")
    ha_url: str = os.getenv("HOME_ASSISTANT_URL", "").rstrip("/")
    ha_token: str = os.getenv("HOME_ASSISTANT_TOKEN", "")
    mqtt_host: str = os.getenv("MQTT_HOST", "")
    mqtt_port: int = int(os.getenv("MQTT_PORT", "1883"))
    mqtt_username: str = os.getenv("MQTT_USERNAME", "")
    mqtt_password: str = os.getenv("MQTT_PASSWORD", "")

    # A dedicated read-only bind mount is the only local filesystem surface
    # exposed to Core. The integration remains disabled unless explicitly opted in.
    files_enabled: bool = _env_bool("ALFRED_FILES_ENABLED", False)
    files_root: str = os.getenv("ALFRED_FILES_ROOT", "/files") or "/files"
    files_max_read_bytes: int = int(os.getenv("ALFRED_FILES_MAX_READ_BYTES", "262144"))

    # Google Calendar is optional. Credentials stay in the Dell environment and
    # are never exposed by the integration registry or health endpoints.
    google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "")
    google_client_secret: str = os.getenv("GOOGLE_CLIENT_SECRET", "")
    google_refresh_token: str = os.getenv("GOOGLE_REFRESH_TOKEN", "")
    google_calendar_id: str = os.getenv("GOOGLE_CALENDAR_ID", "primary") or "primary"
    google_calendar_write_enabled: bool = _env_bool("GOOGLE_CALENDAR_WRITE_ENABLED", False)
    google_timeout_seconds: float = float(os.getenv("ALFRED_GOOGLE_TIMEOUT_SECONDS", "20"))

    # Gmail reads use their own minimum-scope credentials.
    gmail_client_id: str = os.getenv("GMAIL_CLIENT_ID", "")
    gmail_client_secret: str = os.getenv("GMAIL_CLIENT_SECRET", "")
    gmail_refresh_token: str = os.getenv("GMAIL_REFRESH_TOKEN", "")
    gmail_user_id: str = os.getenv("GMAIL_USER_ID", "me") or "me"
    gmail_timeout_seconds: float = float(os.getenv("ALFRED_GMAIL_TIMEOUT_SECONDS", "20"))

    # Gmail mutation credentials are deliberately separate from read credentials.
    # The first write capability is draft creation only and remains disabled until
    # both a write-capable token and the explicit feature gate are present.
    gmail_write_client_id: str = os.getenv("GMAIL_WRITE_CLIENT_ID", "")
    gmail_write_client_secret: str = os.getenv("GMAIL_WRITE_CLIENT_SECRET", "")
    gmail_write_refresh_token: str = os.getenv("GMAIL_WRITE_REFRESH_TOKEN", "")
    gmail_write_user_id: str = os.getenv("GMAIL_WRITE_USER_ID", "me") or "me"
    gmail_write_enabled: bool = _env_bool("GMAIL_WRITE_ENABLED", False)

    # Phase 4 proactive observation is local-first and opt-in. Enabling observation
    # does not enable outbound nudges; the push gate below is separately opt-in.
    proactive_enabled: bool = _env_bool("ALFRED_PROACTIVE_ENABLED", False)
    proactive_poll_seconds: int = int(os.getenv("ALFRED_PROACTIVE_POLL_SECONDS", "900"))
    proactive_quiet_start: str = os.getenv("ALFRED_PROACTIVE_QUIET_START", "22:00") or "22:00"
    proactive_quiet_end: str = os.getenv("ALFRED_PROACTIVE_QUIET_END", "07:00") or "07:00"
    proactive_min_priority: int = int(os.getenv("ALFRED_PROACTIVE_MIN_PRIORITY", "60"))
    proactive_cooldown_minutes: int = int(os.getenv("ALFRED_PROACTIVE_COOLDOWN_MINUTES", "180"))
    proactive_task_horizon_days: int = int(os.getenv("ALFRED_PROACTIVE_TASK_HORIZON_DAYS", "2"))
    proactive_calendar_hours: int = int(os.getenv("ALFRED_PROACTIVE_CALENDAR_HOURS", "24"))
    proactive_gmail_query: str = os.getenv(
        "ALFRED_PROACTIVE_GMAIL_QUERY", "is:unread newer_than:2d"
    ) or "is:unread newer_than:2d"
    proactive_push_enabled: bool = _env_bool("ALFRED_PROACTIVE_PUSH_ENABLED", False)

    # Phase 4C stores one local morning-brief snapshot per local day. Phase 4G can
    # optionally send one generic "brief ready" nudge per day, subordinate to the
    # main proactive push gate and quiet hours.
    proactive_morning_brief_enabled: bool = _env_bool("ALFRED_PROACTIVE_MORNING_BRIEF_ENABLED", True)
    proactive_morning_brief_time: str = os.getenv("ALFRED_PROACTIVE_MORNING_BRIEF_TIME", "08:00") or "08:00"
    proactive_morning_brief_max_items: int = int(os.getenv("ALFRED_PROACTIVE_MORNING_BRIEF_MAX_ITEMS", "8"))
    proactive_brief_retention_days: int = int(os.getenv("ALFRED_PROACTIVE_BRIEF_RETENTION_DAYS", "14"))
    proactive_morning_brief_push_enabled: bool = _env_bool("ALFRED_PROACTIVE_MORNING_BRIEF_PUSH_ENABLED", False)

    # Optional cloud specialists. A missing key disables the provider in Core.
    # These names intentionally match the existing Alfred web/server environment.
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-5.6-terra")
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    anthropic_model: str = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")
    cloud_timeout_seconds: float = float(os.getenv("ALFRED_CLOUD_TIMEOUT_SECONDS", "120"))


settings = Settings()
