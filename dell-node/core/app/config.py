from dataclasses import dataclass
import os


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

    # Optional cloud specialists. A missing key disables the provider in Core.
    # These names intentionally match the existing Alfred web/server environment.
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-5.6-terra")
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    anthropic_model: str = os.getenv("ANTHROPIC_MODEL", "claude-opus-5")
    cloud_timeout_seconds: float = float(os.getenv("ALFRED_CLOUD_TIMEOUT_SECONDS", "120"))


settings = Settings()
