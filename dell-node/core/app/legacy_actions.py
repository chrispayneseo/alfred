"""Compatibility helpers that route legacy explicit UI actions through Core execution.

The old API represents confirmation as a boolean on the request. This bridge
turns that explicit owner confirmation into a durable scoped approval, then
re-enters the normal executor. It never bypasses policy or verification.
"""

from __future__ import annotations

from uuid import uuid4

from .db import record_audit, resolve_approval
from .execution import execute_tool


async def execute_legacy_action(
    *,
    action: str,
    arguments: dict,
    confirmed: bool,
    request_id: str | None = None,
) -> dict:
    request_id = request_id or f"legacy:{uuid4()}"
    first = await execute_tool(
        request_id=request_id,
        action=action,
        arguments=arguments,
    )

    if first.get("state") != "approval_required" or not confirmed:
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
