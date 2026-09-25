"""Durable approval-to-tool resume bridge for conversational mutations.

The client confirms only an approval id. Exact tool arguments are retained on the
Dell and are revalidated against the approval scope before execution, so a
confirmation cannot be repurposed for changed arguments.
"""

from __future__ import annotations

import json

from .conversation_store import record_turn
from .db import connection, record_audit, resolve_approval
from .execution import _scope_hash as execution_scope_hash, execute_tool
from .lifecycle import transition_request


VALID_PROPOSAL_STATES = {"pending", "approved", "rejected", "completed", "failed"}


def initialise() -> None:
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS resumable_tool_proposals (
          approval_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          conversation_id TEXT,
          plan_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          action TEXT NOT NULL,
          integration TEXT NOT NULL,
          arguments TEXT NOT NULL,
          scope_hash TEXT NOT NULL,
          state TEXT NOT NULL,
          execution_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        db.execute(
            "CREATE INDEX IF NOT EXISTS resumable_tool_proposals_state "
            "ON resumable_tool_proposals(state, updated_at DESC)"
        )


def _canonical(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _decode(value: str) -> dict:
    payload = json.loads(value)
    if not isinstance(payload, dict):
        raise ValueError("Stored proposal arguments are invalid")
    return payload


def _approval(approval_id: str) -> dict | None:
    with connection() as db:
        row = db.execute(
            """SELECT id, request_id, plan_id, action, summary, risk_level, state,
                      scope_hash, step_index, created_at, resolved_at
               FROM approvals WHERE id = ?""",
            (approval_id,),
        ).fetchone()
    return dict(row) if row else None


def get_proposal(approval_id: str) -> dict | None:
    initialise()
    with connection() as db:
        row = db.execute(
            """SELECT approval_id, request_id, conversation_id, plan_id, step_index,
                      action, integration, arguments, scope_hash, state, execution_id,
                      created_at, updated_at
               FROM resumable_tool_proposals WHERE approval_id = ?""",
            (approval_id,),
        ).fetchone()
    if row is None:
        return None
    item = dict(row)
    item["arguments"] = _decode(item["arguments"])
    return item


def register_proposal(*, approval: dict, request_id: str, conversation_id: str | None,
                      plan_id: str, step_index: int, action: str, arguments: dict,
                      integration: str) -> dict:
    """Persist the exact local payload needed to resume one approval safely."""
    initialise()
    approval_id = approval.get("id")
    approval_scope = approval.get("scope_hash")
    expected_scope = execution_scope_hash(action, arguments, plan_id, step_index)
    if not isinstance(approval_id, str) or not approval_id:
        raise ValueError("Approval id is required for a resumable proposal")
    if not isinstance(approval_scope, str) or approval_scope != expected_scope:
        raise ValueError("Approval scope does not match the proposed tool action")

    encoded = _canonical(arguments)
    clean_conversation = conversation_id[:160] if isinstance(conversation_id, str) else None
    with connection() as db:
        db.execute(
            """INSERT OR IGNORE INTO resumable_tool_proposals
               (approval_id, request_id, conversation_id, plan_id, step_index, action,
                integration, arguments, scope_hash, state)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')""",
            (
                approval_id, request_id, clean_conversation, plan_id, step_index,
                action, integration, encoded, expected_scope,
            ),
        )
        row = db.execute(
            """SELECT request_id, plan_id, step_index, action, integration, arguments,
                      scope_hash, state
               FROM resumable_tool_proposals WHERE approval_id = ?""",
            (approval_id,),
        ).fetchone()
    if row is None:
        raise RuntimeError("Resumable proposal could not be stored")
    stored = dict(row)
    if (
        stored["request_id"] != request_id
        or stored["plan_id"] != plan_id
        or stored["step_index"] != step_index
        or stored["action"] != action
        or stored["integration"] != integration
        or stored["arguments"] != encoded
        or stored["scope_hash"] != expected_scope
    ):
        raise ValueError("Approval id is already bound to a different tool proposal")
    return {
        "approval_id": approval_id,
        "request_id": request_id,
        "action": action,
        "integration": integration,
        "state": stored["state"],
    }


def _set_proposal_state(approval_id: str, state: str, execution_id: str | None = None) -> None:
    if state not in VALID_PROPOSAL_STATES:
        raise ValueError("Invalid resumable proposal state")
    with connection() as db:
        db.execute(
            """UPDATE resumable_tool_proposals
               SET state = ?, execution_id = COALESCE(?, execution_id),
                   updated_at = CURRENT_TIMESTAMP
               WHERE approval_id = ?""",
            (state, execution_id, approval_id),
        )


def _integrity_error(approval: dict, proposal: dict) -> str | None:
    expected_scope = execution_scope_hash(
        proposal["action"], proposal["arguments"], proposal["plan_id"], proposal["step_index"]
    )
    if proposal["scope_hash"] != expected_scope:
        return "Stored proposal scope no longer matches its arguments."
    if approval.get("scope_hash") != expected_scope:
        return "Approval scope no longer matches the stored proposal."
    if approval.get("request_id") != proposal["request_id"]:
        return "Approval request does not match the stored proposal."
    if approval.get("plan_id") != proposal["plan_id"]:
        return "Approval plan does not match the stored proposal."
    if approval.get("step_index") != proposal["step_index"]:
        return "Approval step does not match the stored proposal."
    if approval.get("action") != proposal["action"]:
        return "Approval action does not match the stored proposal."
    return None


def _completion_reply(action: str, result: dict | None) -> str:
    payload = result if isinstance(result, dict) else {}
    if action == "tasks.create":
        item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
        kind = "reminder" if item.get("kind") == "reminder" else "task"
        return f"Done — I created the {kind}."
    if action == "calendar.events.create":
        return "Done — I created the calendar event."
    if action == "calendar.events.update":
        return "Done — I updated the calendar event."
    if action == "calendar.events.delete":
        return "Done — I deleted the calendar event."
    if action == "home_assistant.service":
        return "Done — I sent the Home Assistant action."
    return "Done — the approved action completed and was verified."


async def resolve_and_resume(approval_id: str, approved: bool) -> dict:
    """Resolve an approval and, when resumable, execute only its bound payload."""
    initialise()
    approval = _approval(approval_id)
    if approval is None:
        return {"id": approval_id, "state": "not_found", "resumed": False}

    desired = "approved" if approved else "rejected"
    proposal = get_proposal(approval_id)

    if proposal is not None:
        integrity_error = _integrity_error(approval, proposal)
        if integrity_error:
            record_audit(
                "approval.resume_scope_mismatch",
                {"approval_id": approval_id, "action": proposal["action"]},
                proposal["request_id"],
                proposal.get("conversation_id"),
            )
            return {
                "id": approval_id,
                "state": "scope_mismatch",
                "resumed": False,
                "error": integrity_error,
            }

    current_state = approval.get("state")
    if current_state not in {"pending", desired}:
        return {
            "id": approval_id,
            "state": "conflict",
            "approval_state": current_state,
            "requested_state": desired,
            "resumed": False,
        }

    # Non-resumable approvals keep the legacy resolve-only behaviour.
    if proposal is None:
        if current_state == "pending":
            if not resolve_approval(approval_id, approved):
                return {"id": approval_id, "state": "conflict", "resumed": False}
        record_audit(
            "approval.resolved",
            {"approval_id": approval_id, "approved": approved, "resumed": False},
            approval.get("request_id"),
        )
        return {"id": approval_id, "state": desired, "resumed": False}

    request_id = proposal["request_id"]
    conversation_id = proposal.get("conversation_id")
    provider = f"integration:{proposal['integration']}"

    if not approved:
        if current_state == "pending" and not resolve_approval(approval_id, False):
            return {"id": approval_id, "state": "conflict", "resumed": False}
        _set_proposal_state(approval_id, "rejected")
        transition_request(request_id, "denied", route="denied", provider=provider)
        reply = "Cancelled — I did not make the change."
        if conversation_id:
            record_turn(conversation_id, "assistant", reply, request_id=approval_id)
        record_audit(
            "approval.rejected",
            {"approval_id": approval_id, "action": proposal["action"], "resumed": False},
            request_id,
            conversation_id,
        )
        return {
            "id": approval_id,
            "state": "rejected",
            "resumed": False,
            "reply": reply,
            "tool_action": proposal["action"],
            "integration": proposal["integration"],
        }

    if current_state == "pending":
        if not resolve_approval(approval_id, True):
            return {"id": approval_id, "state": "conflict", "resumed": False}
        _set_proposal_state(approval_id, "approved")

    execution = await execute_tool(
        request_id=request_id,
        action=proposal["action"],
        arguments=proposal["arguments"],
        plan_id=proposal["plan_id"],
        step_index=proposal["step_index"],
    )
    execution_state = execution.get("state")
    verified = (execution.get("verification") or {}).get("ok") is True

    if execution_state == "completed" and verified:
        _set_proposal_state(approval_id, "completed", execution.get("id"))
        transition_request(request_id, "completed", route="tool", provider=provider)
        reply = _completion_reply(proposal["action"], execution.get("result"))
        if conversation_id:
            record_turn(conversation_id, "assistant", reply, request_id=approval_id)
        record_audit(
            "approval.resumed_completed",
            {
                "approval_id": approval_id,
                "action": proposal["action"],
                "execution_id": execution.get("id"),
                "replayed": bool(execution.get("replayed")),
            },
            request_id,
            conversation_id,
        )
        return {
            "id": approval_id,
            "state": "completed",
            "approval_state": "approved",
            "resumed": True,
            "reply": reply,
            "tool_action": proposal["action"],
            "integration": proposal["integration"],
            "execution": execution,
        }

    terminal_state = "denied" if execution_state == "denied" else "failed"
    _set_proposal_state(approval_id, "failed", execution.get("id"))
    transition_request(
        request_id,
        terminal_state,
        route=terminal_state if terminal_state == "denied" else "tool_failed",
        provider=provider,
        error_type=None if terminal_state == "denied" else "ApprovedToolExecutionError",
    )
    reply = (
        "The approved change is no longer available, so I did not execute it."
        if terminal_state == "denied"
        else "The approved action did not complete safely."
    )
    if conversation_id:
        record_turn(conversation_id, "assistant", reply, request_id=approval_id)
    record_audit(
        "approval.resumed_failed",
        {
            "approval_id": approval_id,
            "action": proposal["action"],
            "execution_state": execution_state,
        },
        request_id,
        conversation_id,
    )
    return {
        "id": approval_id,
        "state": terminal_state,
        "approval_state": "approved",
        "resumed": True,
        "reply": reply,
        "tool_action": proposal["action"],
        "integration": proposal["integration"],
        "execution": execution,
    }
