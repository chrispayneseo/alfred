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
            Capability(
                action="home_assistant.state",
                title="Read one Home Assistant entity state",
                mode="read",
                sends_off_device=False,
                data_types=("device_state",),
            ),
            Capability(
                action="home_assistant.service",
                title="Run a Home Assistant service",
                mode="action",
                sends_off_device=False,
                data_types=("device_state",),
            ),
        ),
    ),
    IntegrationDefinition(
        id="google_calendar",
        name="Google Calendar",
        category="calendar",
        boundary="cloud",
        capabilities=(
            Capability(
                action="calendar.events.list",
                title="List Google Calendar events in a bounded time window",
                mode="read",
                sends_off_device=True,
                data_types=("calendar_event", "time_window"),
            ),
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
        return bool(
            settings.google_client_id
            and settings.google_client_secret
            and settings.google_refresh_token
            and settings.google_calendar_id
        )
    return False


def integration_registry() -> list[dict]:
    registry: list[dict] = []
    for definition in DEFINITIONS:
        configured = _configured(definition.id)
        state: State = "planned" if definition.planned else ("ready" if configured else "not_configured")
        item = asdict(definition)
        item["capabilities"] = [asdict(capability) for capability in definition.capabilities]
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


def action_owner(action: str) -> str:
    integration = integration_for_action(action)
    return integration["id"] if integration else "core"


def action_available(action: str) -> tuple[bool, str | None]:
    """Fail closed for registered integration actions whose system is unavailable."""
    integration = integration_for_action(action)
    if integration is None:
        return True, None
    if integration["state"] == "ready":
        return True, None
    if integration["state"] == "planned":
        return False, f"{integration['name']} capability is not enabled yet."
    return False, f"{integration['name']} is not configured."


async def integration_health() -> list[dict]:
    """Return health states without returning secrets, entities or user content."""
    from .clients import home_assistant_health
    from .google_calendar import health as google_calendar_health

    results: list[dict] = []
    for integration in integration_registry():
        item = {
            "id": integration["id"],
            "name": integration["name"],
            "configured": integration["configured"],
            "boundary": integration["boundary"],
        }
        if integration["state"] == "planned":
            item["state"] = "planned"
        elif integration["id"] == "home_assistant":
            item.update(await home_assistant_health())
        elif integration["id"] == "google_calendar":
            item.update(await google_calendar_health())
        else:
            item["state"] = integration["state"]
        results.append(item)
    return results
