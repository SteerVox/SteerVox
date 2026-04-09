import argparse
import logging
import multiprocessing
import os

import uvicorn

from api.factory import LOCAL_UI_ORIGIN_REGEX, LOCAL_UI_ORIGINS, create_app
from api.state import BackendAppState
from providers.model_discovery import ModelDiscovery
from security.local_api_auth import (
    LOCAL_API_TOKEN_HEADER,
    build_local_api_auth_headers,
    resolve_local_api_token,
)
from utils.branding import BACKEND_PORT_ENV_VAR, DISPLAY_NAME
from utils.logger import get_logger

logger = get_logger()

LOCAL_API_TOKEN = resolve_local_api_token()
app_state = BackendAppState()
app = create_app(app_state, local_api_token=LOCAL_API_TOKEN)


def bump_runtime_revision(scope: str) -> int:
    return app_state.bump_runtime_revision(scope)


def build_key_status_map() -> dict[str, bool]:
    return app_state.build_key_status_map()


def build_active_domain_payload():
    return app_state.build_active_domain_payload()


def build_status_payload() -> dict:
    return app_state.build_status_payload()


def build_runtime_snapshot() -> dict:
    return app_state.build_runtime_snapshot()


def emit_runtime_event(event_type: str, payload: dict | None = None) -> None:
    app_state.emit_runtime_event(event_type, payload)


def _write_uploaded_wav(audio_base64: str) -> str:
    return app_state.write_uploaded_wav(audio_base64)


def get_local_api_test_headers() -> dict[str, str]:
    return build_local_api_auth_headers(LOCAL_API_TOKEN)


def __getattr__(name: str):
    state_exports = {
        "config_manager": app_state.config_manager,
        "skill_manager": app_state.skill_manager,
        "usage_stats_store": app_state.usage_stats_store,
        "domain_memory_store": app_state.domain_memory_store,
        "writing_tools_store": app_state.writing_tools_store,
        "memory_store": app_state.memory_store,
        "inbox_store": app_state.inbox_store,
        "runtime_revisions": app_state.runtime_revisions,
        "engine": app_state.engine,
        "live_transcription_manager": app_state.live_transcription_manager,
        "runtime_event_broker": app_state.runtime_event_broker,
    }
    if name in state_exports:
        return state_exports[name]
    raise AttributeError(name)


class EndpointFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return (
            message.find("GET /status") == -1
            and message.find("GET /events/runtime") == -1
        )


def resolve_server_port(default: int = 8055) -> int:
    raw_value = os.environ.get(BACKEND_PORT_ENV_VAR)
    if raw_value:
        try:
            return int(raw_value)
        except ValueError:
            logger.warning(
                "Invalid %s=%r. Falling back to %s.",
                BACKEND_PORT_ENV_VAR,
                raw_value,
                default,
            )
    return default


def run_server(port: int = 8055):
    logging.getLogger("uvicorn.access").addFilter(EndpointFilter())
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser(description=f"Run the {DISPLAY_NAME} local backend.")
    parser.add_argument("--port", type=int, default=resolve_server_port())
    args = parser.parse_args()
    run_server(port=args.port)
