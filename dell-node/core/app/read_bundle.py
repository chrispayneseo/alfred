"""Deterministic multi-tool chaining for read-only Alfred integrations.

Bundles are intentionally conservative: every clause must independently map to an
existing read+auto tool, the whole request must be mutation-free, and a bundle is
capped at four steps. Core preflights availability before executing any step.
"""

from __future__ import annotations

from dataclasses import asdict
import json
import re

from .core import TOOLS, decide
from .execution import execute_tool
from .integrations import action_available
from .read_tool_planner import MUTATION_RE, ReadToolPlan, plan_read_tool, render_result, sources_for_result


_SPLIT_RE = re.compile(r"\s+(?:and|also|plus|then)\s+|\s*;\s*", re.IGNORECASE)
_LABELS = {
    "alfred_tasks": "Tasks",
    "home_assistant": "Home Assistant",
    "local_files": "Files",
    "google_calendar": "Calendar",
    "gmail": "Gmail",
}


def _key(plan: ReadToolPlan) -> str:
    return json.dumps(
        {"action": plan.action, "arguments": plan.arguments, "integration": plan.integration},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def _safe_read_plan(plan: ReadToolPlan) -> bool:
    definition = TOOLS.get(plan.action)
    if not definition:
        return False
    policy = decide(plan.action)
    return policy.level == "read" and policy.decision == "auto"


def plan_read_tools(message: str, *, now=None) -> list[ReadToolPlan]:
    """Return 2-4 deterministic read plans, or an empty list for non-bundles."""
    if not isinstance(message, str) or not message.strip() or MUTATION_RE.search(message):
        return []

    clean = message.strip()[:4000]
    clauses = [part.strip(" ,.;") for part in _SPLIT_RE.split(clean) if part.strip(" ,.;")]
    if len(clauses) < 2 or len(clauses) > 4:
        return []

    plans: list[ReadToolPlan] = []
    seen: set[str] = set()
    for clause in clauses:
        plan = plan_read_tool(clause, now=now)
        if plan is None or not _safe_read_plan(plan):
            return []
        key = _key(plan)
        if key not in seen:
            plans.append(plan)
            seen.add(key)

    return plans if 2 <= len(plans) <= 4 else []


def _label(plan: ReadToolPlan) -> str:
    return _LABELS.get(plan.integration, plan.integration.replace("_", " ").title())


async def execute_read_bundle(*, request_id: str, plans: list[ReadToolPlan]) -> dict:
    """Preflight and execute an already validated read bundle sequentially."""
    if not 2 <= len(plans) <= 4 or not all(_safe_read_plan(plan) for plan in plans):
        return {"state": "denied", "error": "Read bundle is not valid.", "steps": []}

    for plan in plans:
        available, reason = action_available(plan.action)
        if not available:
            return {
                "state": "unavailable",
                "error": reason or "A requested integration is unavailable.",
                "integration": plan.integration,
                "action": plan.action,
                "steps": [],
            }

    steps: list[dict] = []
    replies: list[str] = []
    sources: list[dict] = []
    bundle_plan_id = f"read-bundle:{request_id}"

    for index, plan in enumerate(plans):
        execution = await execute_tool(
            request_id=request_id,
            action=plan.action,
            arguments=plan.arguments,
            plan_id=bundle_plan_id,
            step_index=index,
        )
        verified = (execution.get("verification") or {}).get("ok") is True
        if execution.get("state") != "completed" or not verified:
            return {
                "state": "failed",
                "error": execution.get("error") or "A bundled read failed verification.",
                "integration": plan.integration,
                "action": plan.action,
                "steps": steps,
            }

        payload = execution.get("result") if isinstance(execution.get("result"), dict) else {}
        reply = render_result(plan.action, payload)
        step_sources = sources_for_result(plan.action, payload)
        steps.append({
            "index": index,
            "action": plan.action,
            "integration": plan.integration,
            "execution_id": execution.get("id"),
            "source_count": len(step_sources),
        })
        replies.append(f"{_label(plan)}: {reply}")
        for source in step_sources:
            sources.append({
                "action": plan.action,
                "integration": plan.integration,
                "source": dict(source) if isinstance(source, dict) else source,
            })

    return {
        "state": "completed",
        "reply": "\n".join(replies),
        "sources": sources,
        "steps": steps,
        "actions": [plan.action for plan in plans],
        "integrations": [plan.integration for plan in plans],
    }
