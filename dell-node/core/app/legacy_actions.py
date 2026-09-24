"""Compatibility helpers that route legacy explicit UI actions through Core execution.

The old API represents confirmation as a boolean on the request. Unconfirmed
legacy calls remain proposals only. Once the owner explicitly confirms, this
bridge creates a durable exact-scope approval and re-enters the normal executor.
It never bypasses policy or verification.
"""

from __future__ import annotations

from uuid import uuid4

from .core import decide
from .db import record_audit, resolve_approval
from .execution import execute_tool


async def execute_legacy_action(
    *,
    action: str,
    arguments: dict,
    confirmed: bool,
) -> dict:
    if not confirmed:
        policy = decide(action)
        return {
            "state": "approval_required" if policy.decision == "confirm" else policy.decision,
            "policy": policy.__dict__,
        }

    request_id = f"legacy:{uuid4()}"
    first = await execute_tool(
        request_id=request_id,
        action=action,
        arguments=arguments,
    )
    if first.get("state") != "approval_required":
        return first

    approval = first.get("approval") or {}
    approval_id = approval.get("id")
    if not isinstance(approval_id, str) or not resolve_approval(approval_id, True):
        return {
            **first,
            "state": "failed",
            "error": "Unable to persist explicit owner approval",
        }

    record_audit(
        "approval.resolved",
        {"approval_id": approval_id, "approved": True, "source": "legacy_explicit_confirmation"},
        request_id,
    )
    return await execute_tool(
        request_id=request_id,
        action=action,
        arguments=arguments,
    )
