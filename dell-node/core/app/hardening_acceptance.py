"""Final Phase 5 hardening and acceptance contract.

This module is deliberately read-only. It evaluates local metadata and static
policy invariants established by Phases 5A-5H; it does not execute tools, create
plans, resolve approvals, retry work, call a model, or add a second execution
history. Adversarial behaviour is exercised by the test and smoke suites.
"""

from __future__ import annotations

from fastapi import APIRouter

from . import (
    agent_loop,
    approval_engine,
    browser_actions,
    execution,
    execution_reliability,
    goals,
    observability,
    reusable_workflows,
    workflows,
)
from .core import TOOLS, decide


MODE = "phase5_hardening_acceptance_v1"
router = APIRouter(tags=["core-hardening-acceptance"])

_PHASE_MODES = {
    "5A": "durable_goals_v1",
    "5B": "bounded_agent_loop_v1",
    "5C": "verified_multi_tool_workflows_v1",
    "5D": "goal_aware_exact_scope_v1",
    "5E": "verified_execution_recovery_v1",
    "5F": "controlled_browser_v1",
    "5G": "reusable_workflows_v1",
    "5H": "agent_observability_v1",
}

_FORBIDDEN_ACTIONS = {
    "email.send",
    "email.reply",
    "email.forward",
    "email.delete",
    "files.write",
    "files.delete",
    "browser.download",
    "browser.upload",
    "browser.purchase",
    "browser.book",
    "shell.execute",
}

_EXACT_APPROVAL_ACTIONS = {
    "memory.write",
    "memory.correct",
    "memory.delete",
    "tasks.create",
    "tasks.update",
    "tasks.complete",
    "tasks.delete",
    "calendar.events.update",
    "calendar.events.delete",
    "email.draft.create",
    "home_assistant.service",
    "browser.submit",
}


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def acceptance_status() -> dict:
    phase_states = {
        "5A": goals.status(),
        "5B": agent_loop.status(),
        "5C": workflows.status(),
        "5D": approval_engine.status(),
        "5E": execution_reliability.status(),
        "5F": browser_actions.status(),
        "5G": reusable_workflows.status(),
        "5H": observability.status(),
    }
    checks: list[dict] = []

    for phase, expected in _PHASE_MODES.items():
        checks.append(_check(
            f"{phase}_mode",
            phase_states[phase].get("mode") == expected,
            f"{phase} uses its accepted Phase 5 mode.",
        ))

    checks.extend([
        _check(
            "goals_do_not_auto_execute",
            phase_states["5A"].get("automatic_execution") is False,
            "Durable goals never start execution merely because they exist.",
        ),
        _check(
            "agent_loop_owner_started",
            phase_states["5B"].get("automatic_start") is False
            and phase_states["5B"].get("restart_auto_replay") is False,
            "Agent runs require an owner start and restart never auto-replays work.",
        ),
        _check(
            "workflow_handoff_verified_only",
            phase_states["5C"].get("handoff") == "verified_scalar_only"
            and phase_states["5C"].get("mutation_approval") == "fully_resolved_exact_scope",
            "Cross-step values are verified scalars and mutations are approved only after resolution.",
        ),
        _check(
            "approval_scope_exact",
            phase_states["5D"].get("approval_scope") == "existing_sha256_exact_arguments"
            and phase_states["5D"].get("policy_changes") is False,
            "Phase 5D preserves the exact-argument approval scope and existing policy.",
        ),
        _check(
            "mutation_replay_protected",
            phase_states["5E"].get("mutation_replay_protection") is True
            and phase_states["5E"].get("ambiguous_mutation") == "reconciliation_required"
            and phase_states["5E"].get("restart_auto_mutation_replay") is False,
            "Verified mutation identity prevents duplicate replay and ambiguity fails closed.",
        ),
        _check(
            "browser_network_boundary",
            phase_states["5F"].get("private_network_access") is False
            and phase_states["5F"].get("navigation") == "public_http_https_only",
            "Browser navigation is limited to public HTTP(S) destinations.",
        ),
        _check(
            "browser_sensitive_capabilities_absent",
            phase_states["5F"].get("credential_fields") is False
            and phase_states["5F"].get("payment_fields") is False
            and phase_states["5F"].get("downloads") is False
            and phase_states["5F"].get("file_uploads") is False
            and phase_states["5F"].get("persistent_profiles") is False,
            "Credentials, payment fields, downloads, uploads and persistent browser profiles are outside 5F.",
        ),
        _check(
            "recipes_static_and_owner_started",
            phase_states["5G"].get("automatic_start") is False
            and phase_states["5G"].get("runtime_action_invention") is False
            and phase_states["5G"].get("code_evaluation") is False,
            "Reusable workflows are static compilers and cannot invent or auto-start actions.",
        ),
        _check(
            "observability_read_only",
            phase_states["5H"].get("read_only") is True
            and phase_states["5H"].get("content_policy") == "metadata_only"
            and phase_states["5H"].get("mutations") is False,
            "Agent observability is metadata-only and cannot mutate Alfred state.",
        ),
    ])

    forbidden_present = sorted(_FORBIDDEN_ACTIONS.intersection(TOOLS))
    checks.append(_check(
        "forbidden_actions_absent",
        not forbidden_present,
        "Unimplemented high-risk send/file/browser/shell actions are absent from the tool registry.",
    ))

    approval_failures = []
    for action in sorted(_EXACT_APPROVAL_ACTIONS.intersection(TOOLS)):
        policy = decide(action)
        if policy.decision != "confirm":
            approval_failures.append(action)
    checks.append(_check(
        "consequential_actions_require_confirmation",
        not approval_failures,
        "Destructive, communication and consequential mutations remain behind deterministic owner confirmation; explicitly routine reversible actions may be automatic.",
    ))

    recipe_actions = {
        action
        for item in reusable_workflows.catalog()
        for action in item.get("actions", [])
    }
    checks.append(_check(
        "recipes_cannot_submit_or_send",
        "browser.submit" not in recipe_actions and "email.send" not in recipe_actions,
        "First-party recipes cannot submit browser actions or send email.",
    ))

    checks.extend([
        _check(
            "executor_wrapper_order_preserved",
            execution.execute_tool.__name__ == "execute_tool_with_workflow_bindings"
            and getattr(execution, "_phase5e_reliability_enabled", False) is True
            and getattr(execution, "_phase5f_browser_guard_enabled", False) is True
            and getattr(execution._pending_or_new_approval, "_phase5d_wrapped", False) is True,
            "5C remains outermost while 5D, 5E and 5F retain their accepted hooks.",
        ),
        _check(
            "phase5_cloud_independent",
            all(state.get("cloud_models") is False for state in phase_states.values()),
            "Phase 5 policy, execution, recovery, recipes and observability require no cloud model.",
        ),
    ])

    accepted = all(item["passed"] for item in checks)
    failed = [item["name"] for item in checks if not item["passed"]]
    return {
        "mode": MODE,
        "accepted": accepted,
        "phase_modes": {phase: state.get("mode") for phase, state in phase_states.items()},
        "checks": checks,
        "check_count": len(checks),
        "failed_checks": failed,
        "adversarial_suite": "phase5i_test_and_live_smoke_required",
        "content_policy": "metadata_only",
        "raw_arguments_exposed": False,
        "tool_results_exposed": False,
        "connected_content_exposed": False,
        "secret_values_exposed": False,
        "mutations": False,
        "executor_hooks_added": False,
        "cloud_models": False,
    }


@router.get("/v1/core/hardening/status")
async def hardening_status():
    return acceptance_status()
