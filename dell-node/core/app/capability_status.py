"""Content-minimised operator status for Alfred Phase 3 capabilities."""

from __future__ import annotations

from .core import TOOLS
from .db import connection
from .integrations import action_owner, integration_health, integration_registry


def _pending_approvals(limit: int = 50) -> list[dict]:
    size = max(1, min(limit, 100))
    with connection() as db:
        rows = db.execute(
            """SELECT id, request_id, action, summary, risk_level, created_at
               FROM approvals WHERE state = 'pending'
               ORDER BY created_at DESC LIMIT ?""",
            (size,),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "request_id": row["request_id"],
            "action": row["action"],
            "integration": action_owner(row["action"]),
            "summary": row["summary"],
            "risk_level": row["risk_level"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]


async def snapshot() -> dict:
    health = {item["id"]: item for item in await integration_health()}
    integrations = []
    for item in integration_registry():
        capabilities = []
        for capability in item["capabilities"]:
            policy = TOOLS.get(capability["action"], {})
            capabilities.append({
                "action": capability["action"],
                "title": capability["title"],
                "mode": capability["mode"],
                "enabled": bool(capability.get("enabled")),
                "sends_off_device": bool(capability.get("sends_off_device")),
                "risk": policy.get("risk"),
                "permission": policy.get("permission"),
            })
        health_item = health.get(item["id"], {})
        integrations.append({
            "id": item["id"],
            "name": item["name"],
            "category": item["category"],
            "boundary": item["boundary"],
            "configured": bool(item["configured"]),
            "state": health_item.get("state", item["state"]),
            "enabled_capabilities": sum(1 for capability in capabilities if capability["enabled"]),
            "total_capabilities": len(capabilities),
            "capabilities": capabilities,
        })

    approvals = _pending_approvals()
    return {
        "phase": 3,
        "integrations": integrations,
        "approvals": {
            "pending_count": len(approvals),
            "items": approvals,
        },
    }
