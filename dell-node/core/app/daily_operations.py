"""Phase 6 daily-utility control plane.

Phase 6 sits above Alfred's accepted Phase 5 execution boundary. It unifies
reviewed capture state, local tasks/reminders and Phase 5 observability into one
owner-facing daily view. Raw forwarded message bodies are deliberately excluded
from this surface.

The only mutation routes in this module persist an owner-reviewed suggestion or
delegate to the already-existing exact-scope Core proposal/approval path. This
module does not install an executor hook, weaken policy, invent actions, or
resolve an approval other than the one already linked to the selected intake
item.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import hardening_acceptance, inbox_api, observability, whatsapp_core_bridge
from .approval_resume import get_proposal, resolve_and_resume
from .db import connection


MODE = "daily_command_centre_v1"
CAPTURE_MODE = "reviewed_capture_v1"
DISPATCH_MODE = "phase5_guarded_dispatch_v1"
CONTENT_POLICY = "owner_reviewed_titles_only"
router = APIRouter(tags=["core-daily-operations"])


class ReviewedSuggestion(BaseModel):
    kind: str = Field(pattern="^(note|task|reminder|clarify)$")
    title: str = Field(min_length=1, max_length=200)
    due: str | None = None
    detail: str = Field(default="", max_length=1000)


class IntakeResolution(BaseModel):
    approved: bool


def _initialise() -> None:
    inbox_api.initialise()
    whatsapp_core_bridge.initialise()


def _normalise_review(review: ReviewedSuggestion) -> tuple[str, str | None, str]:
    title = review.title.strip()
    if not title:
        raise HTTPException(422, "Title is required")
    try:
        due = inbox_api.parse_due(review.due)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if review.kind == "reminder" and due is None:
        raise HTTPException(422, "A reminder needs a date")
    return title, due, review.detail.strip()


def _pending_intake() -> list[dict]:
    _initialise()
    with inbox_api.inbox_connection() as db:
        rows = db.execute(
            """SELECT id, state, suggested_kind, suggested_title, suggested_due,
                      triaged_at, reviewed_at, core_request_id, core_approval_id,
                      core_proposed_at
               FROM whatsapp_inbox
               WHERE state != 'filed'
               ORDER BY created_at ASC LIMIT 50"""
        ).fetchall()

    items: list[dict] = []
    for row in rows:
        approval_id = row["core_approval_id"]
        proposal = get_proposal(approval_id) if isinstance(approval_id, str) and approval_id else None
        items.append({
            "id": str(row["id"]),
            "source": "whatsapp_forward",
            "state": str(row["state"]),
            "kind": str(row["suggested_kind"]) if row["suggested_kind"] else None,
            "title": str(row["suggested_title"]) if row["suggested_title"] else None,
            "due": str(row["suggested_due"]) if row["suggested_due"] else None,
            "triaged_at": str(row["triaged_at"]) if row["triaged_at"] else None,
            "reviewed_at": str(row["reviewed_at"]) if row["reviewed_at"] else None,
            "core_request_id": str(row["core_request_id"]) if row["core_request_id"] else None,
            "approval_id": str(approval_id) if approval_id else None,
            "approval_state": proposal.get("state") if proposal else None,
            "proposed_at": str(row["core_proposed_at"]) if row["core_proposed_at"] else None,
        })
    return items


def _open_local_items() -> list[dict]:
    inbox_api.initialise()
    with connection() as db:
        rows = db.execute(
            """SELECT source_id, kind, title, due, created_at
               FROM inbox_filed
               WHERE kind IN ('task', 'reminder') AND completed_at IS NULL
               ORDER BY CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, created_at
               LIMIT 100"""
        ).fetchall()
    return [
        {
            "source_id": str(row["source_id"]),
            "kind": str(row["kind"]),
            "title": str(row["title"]),
            "due": str(row["due"]) if row["due"] else None,
            "created_at": str(row["created_at"]),
        }
        for row in rows
    ]


def _needs_you(intake: list[dict], agent: dict) -> list[dict]:
    items: list[dict] = []
    for item in intake:
        if item["approval_state"] == "pending":
            reason = "approval_required"
        elif item["state"] == "new":
            reason = "analysis_pending"
        elif item["kind"] == "clarify":
            reason = "clarification_required"
        else:
            reason = "review_required"
        items.append({
            "type": "intake",
            "reason": reason,
            "id": item["id"],
            "source": item["source"],
            "kind": item["kind"],
            "title": item["title"],
            "due": item["due"],
            "approval_id": item["approval_id"],
            "approval_state": item["approval_state"],
        })

    for approval in agent.get("waiting_approvals", []):
        items.append({
            "type": "agent_approval",
            "reason": "approval_required",
            "id": approval.get("approval_id"),
            "action": approval.get("action"),
            "risk_level": approval.get("risk_level"),
            "why": approval.get("why"),
        })
    for attention in agent.get("attention_items", []):
        items.append({
            "type": "agent_attention",
            "reason": "execution_attention",
            "id": attention.get("execution_id"),
            "action": attention.get("action"),
            "state": attention.get("state"),
            "why": attention.get("why"),
        })
    return items[:50]


def today_view() -> dict:
    intake = _pending_intake()
    local_items = _open_local_items()
    agent = observability.today_view()
    today = date.fromisoformat(str(agent["date"]))
    overdue = sum(1 for item in local_items if item["due"] and date.fromisoformat(item["due"]) < today)
    due_today = sum(1 for item in local_items if item["due"] == today.isoformat())
    needs_you = _needs_you(intake, agent)
    return {
        "mode": MODE,
        "capture_mode": CAPTURE_MODE,
        "dispatch_mode": DISPATCH_MODE,
        "date": today.isoformat(),
        "content_policy": CONTENT_POLICY,
        "raw_forwarded_body_exposed": False,
        "forwarded_detail_exposed": False,
        "cloud_models": False,
        "counts": {
            "pending_intake": len(intake),
            "needs_you": len(needs_you),
            "open_local_items": len(local_items),
            "due_today": due_today,
            "overdue": overdue,
            "active_goals": agent["counts"]["active_goals"],
            "waiting_agent_approvals": agent["counts"]["waiting_approvals"],
            "completed_work_today": agent["counts"]["completed_work_today"],
            "attention_items_today": agent["counts"]["attention_items_today"],
        },
        "needs_you": needs_you,
        "pending_intake": intake,
        "open_local_items": local_items,
        "agent": agent,
    }


def status() -> dict:
    phase5 = hardening_acceptance.acceptance_status()
    return {
        "mode": MODE,
        "capture_mode": CAPTURE_MODE,
        "dispatch_mode": DISPATCH_MODE,
        "phase5_accepted": phase5.get("accepted") is True,
        "sources": ["whatsapp_forward", "manual_local"],
        "local_classifier": True,
        "raw_forwarded_text_as_instruction": False,
        "owner_review_before_dispatch": True,
        "exact_scope_core_approval": True,
        "new_executor": False,
        "new_policy_path": False,
        "automatic_external_mutation": False,
        "browser_submit_enabled_by_phase6": False,
        "email_send_enabled_by_phase6": False,
        "content_policy": CONTENT_POLICY,
        "cloud_models": False,
    }


@router.get("/v1/core/daily/status")
async def daily_status():
    return status()


@router.get("/v1/core/daily/today")
async def daily_today():
    return today_view()


@router.post("/v1/core/daily/intake/{message_id}/review")
async def review_intake(message_id: str, review: ReviewedSuggestion):
    """Persist the owner's reviewed interpretation without executing it."""
    _initialise()
    title, due, detail = _normalise_review(review)
    with inbox_api.inbox_connection() as db:
        row = db.execute(
            "SELECT state, core_approval_id FROM whatsapp_inbox WHERE id = ?",
            (message_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "WhatsApp message not found")
        if row["state"] == "filed":
            raise HTTPException(409, "Already filed")
        if row["core_approval_id"]:
            raise HTTPException(409, "A Core proposal already exists for this reviewed scope")
        db.execute(
            """UPDATE whatsapp_inbox
               SET state = 'review', suggested_kind = ?, suggested_title = ?,
                   suggested_due = ?, suggested_detail = ?, reviewed_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (review.kind, title, due, detail, message_id),
        )
        db.commit()
    return {
        "reviewed": True,
        "message_id": message_id,
        "kind": review.kind,
        "title": title,
        "due": due,
    }


@router.post("/v1/core/daily/intake/{message_id}/propose")
async def propose_intake(message_id: str):
    """Delegate a reviewed task/reminder to the accepted Core approval path."""
    return await whatsapp_core_bridge.propose_whatsapp_action(message_id)


@router.post("/v1/core/daily/intake/{message_id}/resolve")
async def resolve_intake(message_id: str, resolution: IntakeResolution):
    """Resolve only the exact Core approval already linked to this intake item."""
    _initialise()
    with inbox_api.inbox_connection() as db:
        row = db.execute(
            "SELECT state, core_approval_id FROM whatsapp_inbox WHERE id = ?",
            (message_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "WhatsApp message not found")
    approval_id = row["core_approval_id"]
    if not isinstance(approval_id, str) or not approval_id:
        raise HTTPException(409, "No Core approval is linked to this intake item")

    result = await resolve_and_resume(approval_id, resolution.approved)
    if result.get("state") == "not_found":
        raise HTTPException(404, "Approval not found")
    if result.get("state") in {"conflict", "scope_mismatch"}:
        raise HTTPException(409, "Approval no longer matches the reviewed action")

    inbox_state = str(row["state"])
    if resolution.approved and result.get("state") == "completed":
        with inbox_api.inbox_connection() as db:
            db.execute(
                """UPDATE whatsapp_inbox SET state = 'filed', reviewed_at = CURRENT_TIMESTAMP
                   WHERE id = ? AND core_approval_id = ?""",
                (message_id, approval_id),
            )
            db.commit()
        inbox_state = "filed"

    return {
        "message_id": message_id,
        "approval_id": approval_id,
        "approved": resolution.approved,
        "state": result.get("state"),
        "inbox_state": inbox_state,
    }
