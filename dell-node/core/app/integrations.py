"""First-class integration registry for Alfred Core.

Integrations describe external systems and the capabilities Alfred may expose
through them. The registry contains metadata only: models cannot add tools or
change permissions at runtime, and secret values are never returned.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

from . import config


Boundary = Literal["local", "local_network", "cloud"]
State = Literal["ready", "not_configured", "unavailable", "planned"]


@dataclass(frozen=True)
class Capability:
    action: str
    title: str
    mode: Literal["read", "write", "action"]
    sends_off_device: bool
    data_types: tuple[str, ...]
    requires_write_enable: bool = False


@dataclass(frozen=True)
class IntegrationDefinition:
    id: str
    name: str
    category: str
    boundary: Boundary
    capabilities: tuple[Capability, ...]
    planned: bool = False


DEFINITIONS: tuple[IntegrationDefinition, ...] = (
    IntegrationDefinition(
        id="alfred_tasks",
        name="Alfred Tasks",
        category="productivity",
        boundary="local",
        capabilities=(
            Capability("tasks.list", "List local tasks and reminders", "read", False, ("task", "reminder")),
            Capability("tasks.create", "Create a local task or reminder", "write", False, ("task", "reminder")),
            Capability("tasks.update", "Edit a local task or reminder", "write", False, ("task", "reminder")),
            Capability("tasks.complete", "Change task or reminder completion", "write", False, ("task", "reminder")),
            Capability("tasks.delete", "Delete a local task or reminder", "write", False, ("task", "reminder")),
        ),
    ),
    IntegrationDefinition(
        id="home_assistant",
        name="Home Assistant",
        category="smart_home",
        boundary="local_network",
        capabilities=(
            Capability("home_assistant.state", "Read one Home Assistant entity state", "read", False, ("device_state",)),
            Capability("home_assistant.service", "Run a Home Assistant service", "action", False, ("device_state",)),
        ),
    ),
    IntegrationDefinition(
        id="google_calendar",
        name="Google Calendar",
        category="calendar",
        boundary="cloud",
        capabilities=(
            Capability("calendar.events.list", "List Google Calendar events in a bounded time window", "read", True, ("calendar_event", "time_window")),
            Capability("calendar.events.create", "Create a Google Calendar event", "write", True, ("calendar_event",), True),
            Capability("calendar.events.update", "Update a Google Calendar event", "write", True, ("calendar_event",), True),
            Capability("calendar.events.delete", "Delete a Google Calendar event", "write", True, ("calendar_event",), True),
        ),
    ),
    IntegrationDefinition(
        id="gmail",
        name="Gmail",
        category="email",
        boundary="cloud",
        capabilities=(
            Capability("email.messages.search", "Search Gmail with a bounded query", "read", True, ("email_metadata", "search_query")),
            Capability("email.message.get", "Read one Gmail message", "read", True, ("email_metadata", "email_body")),
        ),
    ),
)


def _configured(integration_id: str) -> bool:
    settings = config.settings
    if integration_id == "alfred_tasks":
        return True
    if integration_id == "home_assistant":
        return bool(settings.ha_url and settings.ha_token)
    if integration_id == "google_calendar":
        return bool(settings.google_client_id and settings.google_client_secret and settings.google_refresh_token and settings.google_calendar_id)
    if integration_id == "gmail":
        return bool(settings.gmail_client_id and settings.gmail_client_secret and settings.gmail_refresh_token and settings.gmail_user_id)
    return False


def _capability_enabled(definition: IntegrationDefinition, capability: Capability) -> bool:
    if not _configured(definition.id):
        return False
    if definition.id == "google_calendar" and capability.requires_write_enable:
        return bool(config.settings.google_calendar_write_enabled)
    return True


def integration_registry() -> list[dict]:
    registry: list[dict] = []
    for definition in DEFINITIONS:
        configured = _configured(definition.id)
        state: State = "planned" if definition.planned else ("ready" if configured else "not_configured")
        item = asdict(definition)
        capabilities = []
        for capability in definition.capabilities:
            payload = asdict(capability)
            payload["enabled"] = _capability_enabled(definition, capability)
            capabilities.append(payload)
        item["capabilities"] = capabilities
        item["configured"] = configured
        item["state"] = state
        registry.append(item)
    return registry


def get_integration(integration_id: str) -> dict | None:
    return next((item for item in integration_registry() if item["id"] == integration_id), None)


def integration_for_action(action: str) -> dict | None:
    for item in integration_registry():
        for capability in item["capabilities"]:
            if capability["action"] == action:
                return item
    return None


def capability_for_action(action: str) -> dict | None:
    integration = integration_for_action(action)
    if integration is None:
        return None
    return next((item for item in integration["capabilities"] if item["action"] == action), None)


def action_owner(action: str) -> str:
    integration = integration_for_action(action)
    return integration["id"] if integration else "core"


def action_available(action: str) -> tuple[bool, str | None]:
    """Fail closed for registered integration actions whose system/capability is unavailable."""
    integration = integration_for_action(action)
    if integration is None:
        return True, None
    if integration["state"] == "planned":
        return False, f"{integration['name']} capability is not enabled yet."
    if integration["state"] != "ready":
        return False, f"{integration['name']} is not configured."
    capability = capability_for_action(action)
    if capability is not None and not capability.get("enabled", False):
        return False, f"{integration['name']} write capability is disabled."
    return True, None


async def integration_health() -> list[dict]:
    """Return health states without returning secrets, entities or user content."""
    from .clients import home_assistant_health
    from .gmail import health as gmail_health
    from .google_calendar import health as google_calendar_health

    results: list[dict] = []
    for integration in integration_registry():
        item = {
            "id": integration["id"],
            "name": integration["name"],
            "configured": integration["configured"],
            "boundary": integration["boundary"],
            "enabled_capabilities": sum(1 for capability in integration["capabilities"] if capability.get("enabled")),
            "total_capabilities": len(integration["capabilities"]),
        }
        if integration["state"] == "planned":
            item["state"] = "planned"
        elif integration["id"] == "home_assistant":
            item.update(await home_assistant_health())
        elif integration["id"] == "google_calendar":
            item.update(await google_calendar_health())
        elif integration["id"] == "gmail":
            item.update(await gmail_health())
        else:
            item["state"] = integration["state"]
        results.append(item)
    return results
