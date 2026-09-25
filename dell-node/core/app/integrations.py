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
        id="home_assistant",
        name="Home Assistant",
        category="smart_home",
        boundary="local_network",
        capabilities=(
            Capability(
                action="home_assistant.service",
                title="Run a Home Assistant service",
                mode="action",
                sends_off_device=False,
                data_types=("device_state",),
            ),
        ),
    ),
    # Declared now so Calendar can be added without inventing a separate
    # registration model. No Calendar actions are executable until a later
    # Phase 3 slice explicitly registers them with Core policy + adapters.
    IntegrationDefinition(
        id="google_calendar",
        name="Google Calendar",
        category="calendar",
        boundary="cloud",
        capabilities=(),
        planned=True,
    ),
)


def _configured(integration_id: str) -> bool:
    settings = config.settings
    if integration_id == "home_assistant":
        return bool(settings.ha_url and settings.ha_token)
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
