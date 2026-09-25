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

proactive_preferences.register_routes()
proactive_brief.register_routes()
proactive_schedule.register_routes()
proactive_delivery.register_routes()
proactive_feedback.register_routes()
proactive_acceptance.register_routes()

# main.py already mounts proactive.router behind Alfred owner authentication.
# Phase 5A-D contribute absolute /v1/core/* routes to that same authenticated
# route collection without adding a second auth or execution boundary.
proactive.router.routes.extend(goals.router.routes)
proactive.router.routes.extend(agent_loop.router.routes)
proactive.router.routes.extend(workflows.router.routes)
proactive.router.routes.extend(approval_engine.router.routes)

# Install guards first, then verified data hand-off, then goal-aware approval
# context, then approval/restart continuation. 5D wraps only approval creation;
# the exact-scope hash, deterministic policy and one existing executor remain
# authoritative.
goal_hooks.install()
workflow_hooks.install()
approval_engine.install_hook()
agent_loop.install_hooks()

proactive_schedule.install_background_loop()
proactive_preferences.install_runtime_hooks()
proactive_feedback.install_hooks()
