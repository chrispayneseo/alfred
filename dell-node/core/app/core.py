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

def decide(action: str, confirmed: bool = False) -> PolicyDecision:
    """Policy is deterministic application code, never a model judgement."""
    if action in {"memory.read", "recall.search", "chat.local", "route"}:
        return PolicyDecision("read", "auto", "Read-only Core operation.")
    if action in {"memory.write", "memory.correct", "memory.delete"}:
        return PolicyDecision("safe_write", "auto" if confirmed else "confirm", "The owner must explicitly confirm a durable memory change.")
    if action == "home_assistant.service":
        return PolicyDecision("reversible", "auto" if confirmed else "confirm", "Changing a device state requires explicit confirmation.")
    return PolicyDecision("high_impact", "deny", "This action is not registered with Alfred Core.")

def normalise_request(channel: str, message: str, conversation_id: str | None = None) -> dict:
    """Produce the canonical record used by every first-party channel."""
    request_id = str(uuid4())
    return {"request_id": request_id, "user": "Chris", "channel": channel,
            "message": message.strip(), "conversation_id": conversation_id or request_id,
            "trust_level": "owner", "timestamp": datetime.now(timezone.utc).isoformat()}
