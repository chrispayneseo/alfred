"""Phase 7 personal-agent experience control plane.

Phase 7 makes Alfred easier to use from the existing phone and Mac web surfaces
without introducing a second executor, approval path, or source of truth.
Commands still enter the authoritative orchestrator; the agent inbox is derived
from existing Phase 5/6 state; search is local-first; and notifications are an
in-app attention feed rather than an unsolicited briefing system.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from . import daily_operations, memory_service, observability, phase6_acceptance
from .clients import ollama_recall
from .orchestrator import orchestrate
from .recall_store import requested_list


MODE = "personal_agent_experience_v1"
COMMAND_MODE = "authoritative_core_command_v1"
INBOX_MODE = "agent_inbox_v1"
SEARCH_MODE = "personal_search_local_first_v1"
NOTIFICATION_MODE = "event_driven_attention_v1"
router = APIRouter(tags=["core-personal-agent-experience"])


class CommandRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = Field(default=None, max_length=160)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=12)


async def _answer_from_recall(message: str, sources: list[dict]) -> str:
    if requested_list(message):
        if not sources:
            return "I couldn't find any matching open items saved on the Dell."
        labels = [
            f"{item['title']}{' — ' + item['due'] if item.get('due') else ''}"
            for item in sources
        ]
        return "Here are the saved items I found: " + "; ".join(labels) + "."
    if not sources:
        return "I couldn't find anything matching that in Alfred's local memory, tasks or reminders."
    try:
        return await ollama_recall(message, sources)
    except Exception:
        snippets = [str(item.get("content") or item.get("title") or "")[:250].replace("\n", " ") for item in sources[:3]]
        return "I found this saved on the Dell: " + "; ".join(snippets) + ". Check the linked sources for the full details."


def _normalise_need(item: dict) -> dict:
    item_type = str(item.get("type") or "attention")
    if item_type == "intake":
        title = item.get("title") or "Captured item needs review"
        route = "/capture"
    elif item_type == "agent_approval":
        title = item.get("action") or "Alfred needs approval"
        route = "/inbox"
    else:
        title = item.get("action") or "Alfred needs attention"
        route = "/inbox"
    return {
        "id": item.get("id"),
        "type": item_type,
        "state": "needs_you",
        "title": str(title),
        "reason": str(item.get("reason") or "attention_required"),
        "due": item.get("due"),
        "risk_level": item.get("risk_level"),
        "route": route,
    }


def agent_inbox() -> dict:
    """Return one content-minimised inbox for Needs you / Working / Done."""
    daily = daily_operations.today_view()
    agent = daily.get("agent") if isinstance(daily.get("agent"), dict) else observability.today_view()

    needs_you = [_normalise_need(item) for item in daily.get("needs_you", [])][:50]

    working: list[dict] = []
    for goal in agent.get("active_goals", [])[:30]:
        current = goal.get("current_step") if isinstance(goal.get("current_step"), dict) else None
        action = current.get("action") if current else None
        state = current.get("state") if current else goal.get("state")
        working.append({
            "id": goal.get("goal_id"),
            "type": "agent_work",
            "state": "working",
            "title": str(action or "Alfred goal in progress"),
            "reason": str((current or {}).get("why") or "Active durable goal"),
            "step_state": state,
            "route": "/inbox",
        })

    done: list[dict] = []
    for item in agent.get("completed_work", [])[:30]:
        done.append({
            "id": item.get("execution_id"),
            "type": "verified_completion",
            "state": "done",
            "title": str(item.get("action") or "Alfred completed work"),
            "reason": "Verified completed by the existing Core executor.",
            "completed_at": item.get("created_at"),
            "route": "/inbox",
        })

    return {
        "mode": INBOX_MODE,
        "content_policy": "metadata_and_owner_reviewed_titles",
        "raw_forwarded_body_exposed": False,
        "tool_arguments_exposed": False,
        "tool_results_exposed": False,
        "counts": {
            "needs_you": len(needs_you),
            "working": len(working),
            "done": len(done),
        },
        "needs_you": needs_you,
        "working": working,
        "done": done,
    }


def personal_search(query: str, limit: int = 12) -> dict:
    clean = query.strip()[:500]
    if not clean:
        raise HTTPException(422, "Search query is required")
    size = max(1, min(limit, 25))
    pack = memory_service.build_context_pack(clean, limit=size, max_chars=9000)
    results: list[dict] = []
    for item in pack.get("items", [])[:size]:
        content = str(item.get("content") or item.get("title") or "").strip()
        snippet = content.replace("\n", " ")[:320]
        results.append({
            "id": item.get("id"),
            "kind": item.get("kind"),
            "memory_type": item.get("memory_type"),
            "title": str(item.get("title") or snippet[:120] or "Saved item"),
            "snippet": snippet,
            "due": item.get("due"),
            "url": item.get("url"),
            "source": item.get("source"),
            "score": item.get("score"),
        })
    return {
        "mode": SEARCH_MODE,
        "query": clean,
        "count": len(results),
        "results": results,
        "cloud_models": False,
        "connected_account_search": "use_command_interface",
        "budget": pack.get("budget", {}),
    }


def notifications() -> dict:
    inbox = agent_inbox()
    items: list[dict] = []
    for need in inbox["needs_you"][:20]:
        items.append({
            "id": f"need:{need.get('type')}:{need.get('id')}",
            "level": "attention",
            "title": need["title"],
            "reason": need["reason"],
            "route": need["route"],
        })
    for completed in inbox["done"][:10]:
        items.append({
            "id": f"done:{completed.get('id')}",
            "level": "completed",
            "title": completed["title"],
            "reason": completed["reason"],
            "route": completed["route"],
        })
    return {
        "mode": NOTIFICATION_MODE,
        "delivery": "in_app_event_feed",
        "daily_briefing": False,
        "unsolicited_cloud_reasoning": False,
        "count": len(items),
        "items": items,
    }


def status() -> dict:
    phase6 = phase6_acceptance.acceptance_status()
    return {
        "mode": MODE,
        "phase6_accepted": phase6.get("accepted") is True,
        "surfaces": ["phone_web", "mac_web"],
        "command_mode": COMMAND_MODE,
        "inbox_mode": INBOX_MODE,
        "search_mode": SEARCH_MODE,
        "notification_mode": NOTIFICATION_MODE,
        "authoritative_core": True,
        "connected_reads_via_existing_core": True,
        "owner_reviewed_capture_reused": True,
        "exact_scope_approval_reused": True,
        "new_executor": False,
        "new_policy_path": False,
        "automatic_external_mutation": False,
        "browser_submit_enabled_by_phase7": False,
        "email_send_enabled_by_phase7": False,
        "local_search_cloud_models": False,
        "daily_briefing": False,
    }


@router.get("/v1/core/experience/status")
async def experience_status():
    return status()


@router.get("/v1/core/experience/inbox")
async def experience_inbox():
    return agent_inbox()


@router.get("/v1/core/experience/search")
async def experience_search(q: str = Query(min_length=1, max_length=500), limit: int = 12):
    return personal_search(q, limit)


@router.get("/v1/core/experience/notifications")
async def experience_notifications():
    return notifications()


@router.post("/v1/core/experience/command")
async def experience_command(request: CommandRequest):
    result = await orchestrate(
        channel="web",
        message=request.message,
        conversation_id=request.conversation_id,
        recall_answerer=_answer_from_recall,
        history=request.history,
    )
    payload = dict(result)
    payload["experience"] = {
        "mode": MODE,
        "command_mode": COMMAND_MODE,
        "authoritative_core": True,
    }
    return payload
