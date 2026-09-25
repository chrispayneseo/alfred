"""Alfred Core application package bootstrap."""

# Phase 4B extends the existing proactive router without creating a second auth
# surface. main.py includes proactive.router with the normal Core dependency, so
# these routes inherit exactly the same authentication boundary.
from . import proactive as proactive
from . import proactive_brief as proactive_brief

proactive_brief.register_routes()
