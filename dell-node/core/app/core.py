"""Alfred Core's transport-independent request, policy and audit boundary."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

Risk = Literal["read", "safe_write", "reversible", "external", "high_impact"]
Decision = Literal["auto", "confirm", "deny"]

@dataclass(frozen=True)
class PolicyDecision:
    level: Risk
    decision: Decision
    reason: str


TOOLS = {
    "memory.read": {"risk": "read", "permission": "auto", "verification": "read_result"},
    "memory.write": {"risk": "safe_write", "permission": "confirm", "verification": "stored_row"},
    "memory.correct": {"risk": "safe_write", "permission": "confirm", "verification": "stored_row"},
    "memory.delete": {"risk": "safe_write", "permission": "confirm", "verification": "row_absent"},
    "memory.candidate.list": {"risk": "read", "permission": "auto", "verification": "read_result"},
    "memory.candidate.propose": {"risk": "safe_write", "permission": "auto", "verification": "candidate_row"},
    "memory.candidate.dismiss": {"risk": "safe_write", "permission": "auto", "verification": "candidate_state"},
    "memory.candidate.promote": {"risk": "safe_write", "permission": "confirm", "verification": "promoted_memory"},
    "tasks.list": {"risk": "read", "permission": "auto", "verification": "task_list"},
    "tasks.create": {"risk": "safe_write", "permission": "confirm", "verification": "stored_task"},
    "tasks.update": {"risk": "safe_write", "permission": "confirm", "verification": "stored_task"},
    "tasks.complete": {"risk": "safe_write", "permission": "confirm", "verification": "task_state"},
    "tasks.delete": {"risk": "safe_write", "permission": "confirm", "verification": "task_absent"},
    "home_assistant.state": {"risk": "read", "permission": "auto", "verification": "device_state"},
    "home_assistant.service": {"risk": "reversible", "permission": "confirm", "verification": "service_response"},
    "calendar.events.list": {"risk": "read", "permission": "auto", "verification": "calendar_events"},
}

def decide(action: str, confirmed: bool = False) -> PolicyDecision:
    """Policy is deterministic application code, never a model judgement."""
    if action in {
        "memory.read", "memory.candidate.list", "tasks.list", "home_assistant.state",
        "calendar.events.list", "recall.search", "chat.local", "route",
    }:
        return PolicyDecision("read", "auto", "Read-only Core operation.")
    if action in {"memory.candidate.propose", "memory.candidate.dismiss"}:
        return PolicyDecision(
            "safe_write",
            "auto",
            "Candidate-queue metadata is local working state and does not become durable memory.",
        )
    if action in {
        "memory.write", "memory.correct", "memory.delete", "memory.candidate.promote",
        "tasks.create", "tasks.update", "tasks.complete", "tasks.delete",
    }:
        return PolicyDecision(
            "safe_write",
            "auto" if confirmed else "confirm",
            "The owner must explicitly confirm this durable local change.",
        )
    if action == "home_assistant.service":
        return PolicyDecision("reversible", "auto" if confirmed else "confirm", "Changing a device state requires explicit confirmation.")
    return PolicyDecision("high_impact", "deny", "This action is not registered with Alfred Core.")


def tool_registry() -> list[dict]:
    # Import lazily so the transport/policy boundary does not depend on an
    # integration implementation during module initialisation.
    from .integrations import action_owner
    return [{"name": name, "integration": action_owner(name), **definition}
            for name, definition in TOOLS.items()]


def event_decision(event_type: str) -> str:
    """Events are stored first; only explicitly registered classes may notify."""
    if event_type in {"calendar.changed", "home_assistant.changed", "timer.due", "whatsapp.received"}:
        return "store"
    return "ignore"

def normalise_request(channel: str, message: str, conversation_id: str | None = None) -> dict:
    """Produce the canonical record used by every first-party channel."""
    request_id = str(uuid4())
    return {"request_id": request_id, "user": "Chris", "channel": channel,
            "message": message.strip(), "conversation_id": conversation_id or request_id,
            "trust_level": "owner", "timestamp": datetime.now(timezone.utc).isoformat()}
