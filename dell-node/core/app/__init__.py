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

proactive_preferences.register_routes()
proactive_brief.register_routes()
proactive_schedule.register_routes()
proactive_delivery.register_routes()
proactive_feedback.register_routes()
proactive_acceptance.register_routes()

# main.py already mounts proactive.router behind Alfred owner authentication.
# Phase 5A-I contribute absolute /v1/core/* routes to that same authenticated
# route collection without adding a second auth or execution boundary.
proactive.router.routes.extend(goals.router.routes)
proactive.router.routes.extend(agent_loop.router.routes)
proactive.router.routes.extend(workflows.router.routes)
proactive.router.routes.extend(approval_engine.router.routes)
proactive.router.routes.extend(execution_reliability.router.routes)
proactive.router.routes.extend(browser_actions.router.routes)
proactive.router.routes.extend(reusable_workflows.router.routes)
proactive.router.routes.extend(observability.router.routes)
proactive.router.routes.extend(hardening_acceptance.router.routes)

# Install the goal guard first. 5F adds a browser preflight guard to the base
# executor, then 5E wraps that guarded executor. 5C remains outermost so verified
# workflow bindings resolve before 5E computes operation identity and before the
# 5F guard sees the final browser arguments. 5D still owns approval context and
# 5B retains approval/restart continuation. 5G adds no executor hook: recipes
# compile into the already-installed 5A-5F path. 5H and 5I are read-only and add
# no execution hooks.
goal_hooks.install()
browser_actions.install()
execution_reliability.install()
workflow_hooks.install()
approval_engine.install_hook()
agent_loop.install_hooks()

proactive_schedule.install_background_loop()
proactive_preferences.install_runtime_hooks()
proactive_feedback.install_hooks()
