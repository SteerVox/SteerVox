from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.config_router import build_config_router
from api.domains_router import build_domains_router
from api.health_router import build_health_router
from api.library_router import build_library_router
from api.memory_router import build_memory_router
from api.recording_router import build_recording_router
from api.runtime_router import build_runtime_router
from api.skills_router import build_skills_router
from api.state import BackendAppState
from api.usage_router import build_usage_router
from api.writing_tools_router import build_writing_tools_router
from security.local_api_auth import require_local_api_token, resolve_local_api_token
from utils.branding import BACKEND_TITLE
from utils.logger import get_logger

logger = get_logger()

# Local backend trust model:
# - the server only binds to 127.0.0.1
# - CORS is limited to file/null origins and localhost loopback origins used by
#   the Electron renderer in development and production
# - Electron-issued local API auth protects every privileged route except /health
LOCAL_UI_ORIGINS = ["null", "file://"]
LOCAL_UI_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("FastAPI Server starting up...")

    def _watch_parent():
        import time

        while True:
            try:
                if os.getppid() == 1:
                    logger.warning(
                        "Parent Electron process died unexpectedly. Auto-terminating backend."
                    )
                    os._exit(0)
            except AttributeError:
                pass
            time.sleep(2)

    threading.Thread(target=_watch_parent, daemon=True, name="ParentWatcher").start()
    try:
        yield
    finally:
        logger.info("FastAPI Server shutting down...")


def create_app(state: BackendAppState | None = None, *, local_api_token: str | None = None) -> FastAPI:
    backend_state = state or BackendAppState()
    app = FastAPI(title=BACKEND_TITLE, lifespan=lifespan)
    app.state.backend_state = backend_state
    app.state.local_api_token = local_api_token or resolve_local_api_token()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=LOCAL_UI_ORIGINS,
        allow_origin_regex=LOCAL_UI_ORIGIN_REGEX,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
    protected = [Depends(require_local_api_token)]
    app.include_router(build_health_router())
    app.include_router(build_config_router(backend_state), dependencies=protected)
    app.include_router(build_runtime_router(backend_state), dependencies=protected)
    app.include_router(build_domains_router(backend_state), dependencies=protected)
    app.include_router(build_recording_router(backend_state), dependencies=protected)
    app.include_router(build_usage_router(backend_state), dependencies=protected)
    app.include_router(build_writing_tools_router(backend_state), dependencies=protected)
    app.include_router(build_library_router(backend_state), dependencies=protected)
    app.include_router(build_memory_router(backend_state), dependencies=protected)
    app.include_router(build_skills_router(backend_state), dependencies=protected)
    return app
