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

    # Google Calendar is optional. Credentials stay in the Dell environment and
    # are never exposed by the integration registry or health endpoints.
    google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "")
    google_client_secret: str = os.getenv("GOOGLE_CLIENT_SECRET", "")
    google_refresh_token: str = os.getenv("GOOGLE_REFRESH_TOKEN", "")
    google_calendar_id: str = os.getenv("GOOGLE_CALENDAR_ID", "primary") or "primary"
    google_calendar_write_enabled: bool = _env_bool("GOOGLE_CALENDAR_WRITE_ENABLED", False)
    google_timeout_seconds: float = float(os.getenv("ALFRED_GOOGLE_TIMEOUT_SECONDS", "20"))

    # Optional cloud specialists. A missing key disables the provider in Core.
    # These names intentionally match the existing Alfred web/server environment.
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-5.6-terra")
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    anthropic_model: str = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")
    cloud_timeout_seconds: float = float(os.getenv("ALFRED_CLOUD_TIMEOUT_SECONDS", "120"))


settings = Settings()
