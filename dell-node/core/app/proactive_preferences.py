"""Durable owner-controlled Phase 4 proactive preferences.

Environment variables remain the safe defaults. This module stores only explicit
local overrides in Alfred's SQLite database so the owner can change proactive
behaviour from the private PWA without editing .env or restarting Core.

These preferences affect local observation and briefing only. Outbound delivery
remains disabled elsewhere in the Phase 4 boundary.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import time
import sys
from typing import Any

from pydantic import BaseModel, Field, field_validator

from .config import settings
from .db import connection, record_audit


_KEYS = (
    "enabled",
    "poll_seconds",
    "quiet_start",
    "quiet_end",
    "min_priority",
    "cooldown_minutes",
    "morning_brief_enabled",
    "morning_brief_time",
)

_ATTRS = {
    "enabled": "proactive_enabled",
    "poll_seconds": "proactive_poll_seconds",
    "quiet_start": "proactive_quiet_start",
    "quiet_end": "proactive_quiet_end",
    "min_priority": "proactive_min_priority",
    "cooldown_minutes": "proactive_cooldown_minutes",
    "morning_brief_enabled": "proactive_morning_brief_enabled",
    "morning_brief_time": "proactive_morning_brief_time",
}

_BOOL_KEYS = {"enabled", "morning_brief_enabled"}
_INT_KEYS = {"poll_seconds", "min_priority", "cooldown_minutes"}


class PreferencesUpdate(BaseModel):
    enabled: bool | None = None
    poll_seconds: int | None = Field(default=None, ge=300, le=3600)
    quiet_start: str | None = None
    quiet_end: str | None = None
    min_priority: int | None = Field(default=None, ge=0, le=100)
    cooldown_minutes: int | None = Field(default=None, ge=0, le=1440)
    morning_brief_enabled: bool | None = None
    morning_brief_time: str | None = None

    @field_validator("quiet_start", "quiet_end", "morning_brief_time")
    @classmethod
    def valid_clock(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = time.fromisoformat(value.strip())
        except ValueError as exc:
            raise ValueError("Time must use HH:MM") from exc
        if parsed.second or parsed.microsecond:
            raise ValueError("Time must use HH:MM")
        return parsed.strftime("%H:%M")


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS proactive_preferences (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")


def _decode(key: str, raw: str) -> Any:
    if key in _BOOL_KEYS:
        return raw.strip().casefold() in {"1", "true", "yes", "on"}
    if key in _INT_KEYS:
        try:
            return int(raw)
        except ValueError:
            return None
    return raw


def _encode(key: str, value: Any) -> str:
    if key in _BOOL_KEYS:
        return "true" if bool(value) else "false"
    return str(value)


def current(defaults=settings) -> dict:
    """Return effective settings, overlaying durable overrides on defaults."""
    initialise()
    with connection() as db:
        rows = db.execute("SELECT key, value FROM proactive_preferences").fetchall()
    overrides = {str(row["key"]): str(row["value"]) for row in rows if row["key"] in _KEYS}
    result: dict[str, Any] = {}
    for key in _KEYS:
        default = getattr(defaults, _ATTRS[key])
        if key in overrides:
            decoded = _decode(key, overrides[key])
            result[key] = default if decoded is None else decoded
        else:
            result[key] = default
    result["delivery"] = "disabled"
    result["source"] = "local_override" if overrides else "environment_defaults"
    return result


def apply_runtime_preferences() -> dict:
    """Apply effective proactive values to already-imported Core modules.

    Settings is a frozen dataclass, so we replace only the proactive fields and
    update each module's bound settings reference. This makes changes effective
    immediately while keeping every unrelated secret/config value untouched.
    """
    effective = current(settings)
    runtime = replace(
        settings,
        proactive_enabled=bool(effective["enabled"]),
        proactive_poll_seconds=int(effective["poll_seconds"]),
        proactive_quiet_start=str(effective["quiet_start"]),
        proactive_quiet_end=str(effective["quiet_end"]),
        proactive_min_priority=int(effective["min_priority"]),
        proactive_cooldown_minutes=int(effective["cooldown_minutes"]),
        proactive_morning_brief_enabled=bool(effective["morning_brief_enabled"]),
        proactive_morning_brief_time=str(effective["morning_brief_time"]),
    )

    from . import config
    config.settings = runtime

    for module_name in (
        "app.proactive",
        "app.proactive_brief",
        "app.proactive_schedule",
        "app.main",
    ):
        module = sys.modules.get(module_name)
        if module is not None and hasattr(module, "settings"):
            setattr(module, "settings", runtime)
    return effective


def update(values: PreferencesUpdate, defaults=settings) -> dict:
    initialise()
    changes = values.model_dump(exclude_none=True)
    if not changes:
        return current(defaults)
    with connection() as db:
        for key, value in changes.items():
            if key not in _KEYS:
                continue
            db.execute("""INSERT INTO proactive_preferences(key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = CURRENT_TIMESTAMP""", (key, _encode(key, value)))
    record_audit("proactive.preferences_updated", {
        "keys": sorted(changes),
        "delivery": "disabled",
    })
    apply_runtime_preferences()
    return current(defaults)


def register_routes() -> None:
    from . import proactive

    existing = {route.path for route in proactive.router.routes}
    if "/v1/core/proactive/settings" in existing:
        return

    @proactive.router.get("/settings")
    async def proactive_settings():
        return current(settings)

    @proactive.router.post("/settings")
    async def update_proactive_settings(payload: PreferencesUpdate):
        return update(payload, settings)
