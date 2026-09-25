"""Alfred Core application package bootstrap."""

from . import proactive as proactive
from . import proactive_brief as proactive_brief
from . import proactive_schedule as proactive_schedule
from . import proactive_preferences as proactive_preferences
from . import proactive_delivery as proactive_delivery
from . import proactive_feedback as proactive_feedback
from . import proactive_acceptance as proactive_acceptance
from . import goals as goals
from . import goal_hooks as goal_hooks
from . import workflows as workflows
from . import workflow_hooks as workflow_hooks
from . import agent_loop as agent_loop
from . import approval_engine as approval_engine
from . import browser_actions as browser_actions
from . import execution_reliability as execution_reliability
from . import reusable_workflows as reusable_workflows
from . import observability as observability
from . import hardening_acceptance as hardening_acceptance
from . import daily_operations as daily_operations
from . import phase6_acceptance as phase6_acceptance
from . import experience as experience
from . import phase7_acceptance as phase7_acceptance
from . import authenticated_web as authenticated_web
from . import phase8_acceptance as phase8_acceptance
from . import knowledge as knowledge
from . import phase9_acceptance as phase9_acceptance
from . import proactive_intelligence as proactive_intelligence
from . import phase10_acceptance as phase10_acceptance
from . import operations as operations
from . import phase11_acceptance as phase11_acceptance
from . import projects as projects
from . import phase12_acceptance as phase12_acceptance
from . import specialist_orchestration as specialist_orchestration
from . import phase13_acceptance as phase13_acceptance

proactive_preferences.register_routes()
proactive_brief.register_routes()
proactive_schedule.register_routes()
proactive_delivery.register_routes()
proactive_feedback.register_routes()
proactive_acceptance.register_routes()

for extra_router in (
    goals.router, agent_loop.router, workflows.router, approval_engine.router,
    execution_reliability.router, browser_actions.router, reusable_workflows.router,
    observability.router, hardening_acceptance.router, daily_operations.router,
    phase6_acceptance.router, experience.router, phase7_acceptance.router,
    authenticated_web.router, phase8_acceptance.router, knowledge.router,
    phase9_acceptance.router, proactive_intelligence.router, phase10_acceptance.router,
    operations.router, phase11_acceptance.router, projects.router, phase12_acceptance.router,
    specialist_orchestration.router, phase13_acceptance.router,
):
    proactive.router.routes.extend(extra_router.routes)

# Phase 13 centralises provider planning but provider execution/privacy remains in
# cloud_execution. It adds no executor hook or second provider-call path.
goal_hooks.install()
browser_actions.install()
authenticated_web.install()
execution_reliability.install()
workflow_hooks.install()
approval_engine.install_hook()
agent_loop.install_hooks()

proactive_schedule.install_background_loop()
proactive_preferences.install_runtime_hooks()
proactive_feedback.install_hooks()
