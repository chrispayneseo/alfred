"""Alfred Core application package bootstrap."""

# Phase 4 extensions share the existing authenticated proactive router. Runtime
# preferences are applied before main.py imports config.settings so durable
# local overrides are effective immediately after a restart.
from . import proactive as proactive
from . import proactive_brief as proactive_brief
from . import proactive_schedule as proactive_schedule
from . import proactive_preferences as proactive_preferences

proactive_preferences.initialise()
proactive_preferences.apply_runtime_preferences()
proactive_preferences.register_routes()
proactive_brief.register_routes()
proactive_schedule.register_routes()
proactive_schedule.install_background_loop()
