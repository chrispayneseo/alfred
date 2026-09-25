"""Phase 8 browser-worker application wrapper.

The existing Phase 5F app remains authoritative for browser lifecycle and submit
policy. Phase 8 only mounts authenticated-profile bootstrap/open routes onto the
same worker and token boundary.
"""

from .main import app
from .auth_profiles import router as auth_profiles_router

app.include_router(auth_profiles_router)
