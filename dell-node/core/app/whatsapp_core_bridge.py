"""Bridge reviewed WhatsApp inbox suggestions into Alfred Core approvals.

Raw forwarded WhatsApp text remains untrusted inbox data. This bridge never sends
that text to the orchestrator as an instruction. Only the locally normalised
review suggestion (task or dated reminder) can be converted into an exact Core
mutation proposal, which still requires the normal approval/resume path.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, HTTPException

from .approval_resume import get_proposal
from .db import record_audit
from .inbox_api import inbox_connection, parse_due
from .lifecycle import get_request
from .orchestrator import orchestrate


router = APIRouter(prefix="/v1/core/whatsapp", tags=["whatsapp-core"])


def initialise() -> None:
    with inbox_connection() as db:
        existing = {row[1] for row in db.execute("PRAGMA table_info(whatsapp_inbox)")}
        for name, column_type in (
            ("core_request_id", "TEXT"),
            ("core_approval_id", "TEXT"),
            ("core_proposed_at", "TEXT"),
        ):
            if name not in existing:
                db.execute(f"ALTER TABLE whatsapp_inbox ADD COLUMN {name} {column_type}")
        db.commit()


def _row(message_id: str):
    initialise()
    with inbox_connection() as db:
        return db.execute(
            """SELECT id, state, suggested_kind, suggested_title, suggested_due,
                      suggested_detail, core_request_id, core_approval_id,
                      core_proposed_at
               FROM whatsapp_inbox WHERE id = ?""",
            (message_id,),
        ).fetchone()


def _status_payload(row) -> dict:
    approval_id = row["core_approval_id"]
    request_id = row["core_request_id"]
    proposal = get_proposal(approval_id) if isinstance(approval_id, str) and approval_id else None
    request = get_request(request_id) if isinstance(request_id, str) and request_id else None
    return {
        "message_id": row["id"],
        "inbox_state": row["state"],
        "suggested_kind": row["suggested_kind"],
        "core_request_id": request_id,
        "approval_id": approval_id,
        "proposal_state": proposal.get("state") if proposal else None,
        "request_state": request.get("state") if request else None,
        "proposed_at": row["core_proposed_at"],
    }


def _command_from_review(row) -> str:
    if row["state"] != "review":
        raise HTTPException(409, "WhatsApp message must be triaged and awaiting review")

    kind = row["suggested_kind"]
    title = row["suggested_title"]
    if kind not in {"task", "reminder"}:
        raise HTTPException(409, "Only reviewed task or dated reminder suggestions can become Core proposals")
    if not isinstance(title, str) or not title.strip():
        raise HTTPException(409, "Reviewed suggestion has no usable title")

    clean_title = title.strip()[:200]
    if kind == "task":
        return f"Add task: {clean_title}"

    try:
        due = parse_due(row["suggested_due"])
    except ValueError:
        due = None
    if due is None:
        raise HTTPException(409, "A reminder suggestion needs a verified date before Core proposal")
    return f"Create reminder: {clean_title} due {due}"


@router.get("/{message_id}")
async def whatsapp_core_status(message_id: str):
    row = _row(message_id)
    if row is None:
        raise HTTPException(404, "WhatsApp message not found")
    return _status_payload(row)


@router.post("/{message_id}/propose")
async def propose_whatsapp_action(message_id: str):
    """Create at most one exact-scope Core approval for a reviewed suggestion."""
    row = _row(message_id)
    if row is None:
        raise HTTPException(404, "WhatsApp message not found")

    if row["core_request_id"] or row["core_approval_id"]:
        return _status_payload(row)

    command = _command_from_review(row)
    result = await orchestrate(
        channel="whatsapp",
        message=command,
        conversation_id=f"whatsapp-inbox:{message_id}"[:160],
    )
    if result.get("decision") != "approval_required":
        record_audit(
            "whatsapp.core_proposal_failed",
            {"message_id": message_id, "decision": result.get("decision")},
            result.get("request_id"),
            result.get("conversation_id"),
        )
        raise HTTPException(409, "Reviewed suggestion could not produce a safe Core approval")

    approval = result.get("approval") if isinstance(result.get("approval"), dict) else None
    approval_id = approval.get("id") if approval else None
    request_id = result.get("request_id")
    if not isinstance(approval_id, str) or not approval_id or not isinstance(request_id, str):
        raise HTTPException(503, "Core did not return a resumable approval")

    # First writer wins. A repeated POST returns the already-linked proposal and
    # never creates another task/reminder approval for the same forwarded item.
    with inbox_connection() as db:
        updated = db.execute(
            """UPDATE whatsapp_inbox
               SET core_request_id = ?, core_approval_id = ?, core_proposed_at = CURRENT_TIMESTAMP
               WHERE id = ? AND core_request_id IS NULL AND core_approval_id IS NULL""",
            (request_id, approval_id, message_id),
        )
        db.commit()

    stored = _row(message_id)
    if stored is None:
        raise HTTPException(404, "WhatsApp message not found")
    if updated.rowcount == 0 and stored["core_approval_id"] != approval_id:
        # A concurrent request linked a different proposal first. The new one is
        # left pending but never returned as the canonical WhatsApp linkage; log
        # the anomaly so it can be reconciled rather than silently duplicated.
        record_audit(
            "whatsapp.core_proposal_race",
            {"message_id": message_id, "orphan_approval_id": approval_id},
            request_id,
            result.get("conversation_id"),
        )

    record_audit(
        "whatsapp.core_proposed",
        {"message_id": message_id, "approval_id": stored["core_approval_id"]},
        stored["core_request_id"],
        result.get("conversation_id"),
    )
    return _status_payload(stored)
