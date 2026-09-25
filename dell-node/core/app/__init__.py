"""Alfred Core application package bootstrap."""

# Phase 4 extensions share the existing authenticated proactive router. The
# preference hooks apply durable overrides during normal Core startup, after the
# database path is available, and wrap the final schedule-aware background loop.
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

proactive_preferences.register_routes()
proactive_brief.register_routes()
proactive_schedule.register_routes()
proactive_delivery.register_routes()
proactive_feedback.register_routes()
proactive_acceptance.register_routes()

# main.py already mounts proactive.router behind Alfred owner authentication.
# Phase 5A-I and Phases 6-8 contribute absolute /v1/core/* routes to that same
# authenticated route collection without adding a second owner-auth boundary.
proactive.router.routes.extend(goals.router.routes)
proactive.router.routes.extend(agent_loop.router.routes)
proactive.router.routes.extend(workflows.router.routes)
proactive.router.routes.extend(approval_engine.router.routes)
proactive.router.routes.extend(execution_reliability.router.routes)
proactive.router.routes.extend(browser_actions.router.routes)
proactive.router.routes.extend(reusable_workflows.router.routes)
proactive.router.routes.extend(observability.router.routes)
proactive.router.routes.extend(hardening_acceptance.router.routes)
proactive.router.routes.extend(daily_operations.router.routes)
proactive.router.routes.extend(phase6_acceptance.router.routes)
proactive.router.routes.extend(experience.router.routes)
proactive.router.routes.extend(phase7_acceptance.router.routes)
proactive.router.routes.extend(authenticated_web.router.routes)
proactive.router.routes.extend(phase8_acceptance.router.routes)

# Install the goal guard first. 5F adds a browser preflight guard to the base
# executor. Phase 8 extends that same browser/executor boundary with one read-only
# authenticated-profile open action; it does not create a second executor or a
# second submit path. Phase 5E then wraps the guarded executor, 5C remains
# outermost for workflow binding, 5D owns approval context and 5B continuation.
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
