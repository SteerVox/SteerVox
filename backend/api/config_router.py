from __future__ import annotations

from fastapi import APIRouter, HTTPException

from api.schemas import APIKeyPayload, RefreshProviderModelsPayload
from api.state import BackendAppState
from providers.model_discovery import ModelDiscovery
from security.secrets_manager import SecretsManager
from utils.logger import get_logger

logger = get_logger()


def build_config_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.get("/config")
    def get_config():
        return state.config_manager.get_config().model_dump()

    @router.post("/config")
    def update_config(updates: dict):
        if state.engine.is_processing:
            raise HTTPException(
                status_code=409,
                detail="Cannot update configuration while processing a recording. Please wait.",
            )

        previous_config = state.config_manager.get_config()
        updated_config = state.config_manager.update_config(updates)
        if not updated_config:
            raise HTTPException(status_code=400, detail="Failed to update configuration.")

        requires_engine_restart = (
            previous_config.stt.provider != updated_config.stt.provider
            or previous_config.llm.model_dump() != updated_config.llm.model_dump()
        )
        if requires_engine_restart:
            logger.info(
                "Config change requires engine restart. previous_smart=%s/%s previous_router=%s/%s next_smart=%s/%s next_router=%s/%s",
                previous_config.llm.provider,
                previous_config.llm.model,
                previous_config.llm.routing.provider,
                previous_config.llm.routing.model,
                updated_config.llm.provider,
                updated_config.llm.model,
                updated_config.llm.routing.provider,
                updated_config.llm.routing.model,
            )
            state.restart_engine()

        revision = state.bump_runtime_revision("config")
        state.emit_runtime_event(
            "config_changed",
            {
                "config": updated_config.model_dump(),
                "revision": revision,
            },
        )
        state.emit_runtime_event("status")
        return {"status": "success", "config": updated_config.model_dump()}

    @router.post("/secrets")
    def update_secret(payload: APIKeyPayload):
        logger.info("Updating API Key for provider: %s", payload.provider)
        if not SecretsManager.set_api_key(payload.provider, payload.key):
            raise HTTPException(status_code=500, detail="Failed to save API key.")
        ModelDiscovery.clear_cache(payload.provider)
        revision = state.bump_runtime_revision("providers")
        state.emit_runtime_event(
            "providers_changed",
            {
                "provider": payload.provider,
                "keys_set": state.build_key_status_map(),
                "revision": revision,
            },
        )
        return {
            "status": "success",
            "message": f"API key for {payload.provider} saved securely.",
        }

    @router.delete("/secrets/{provider}")
    def delete_secret(provider: str):
        logger.info("Deleting API Key for provider: %s", provider)
        if not SecretsManager.delete_api_key(provider):
            raise HTTPException(status_code=500, detail="Failed to clear API key.")
        ModelDiscovery.clear_cache(provider)
        revision = state.bump_runtime_revision("providers")
        state.emit_runtime_event(
            "providers_changed",
            {
                "provider": provider,
                "keys_set": state.build_key_status_map(),
                "revision": revision,
            },
        )
        return {"status": "success", "message": f"API key for {provider} cleared."}

    @router.get("/secrets/check")
    def check_secrets():
        return state.build_key_status_map()

    @router.get("/providers/models")
    def get_provider_models():
        return ModelDiscovery.get_all_models()

    @router.post("/providers/models/refresh")
    def refresh_provider_models(payload: RefreshProviderModelsPayload):
        ModelDiscovery.clear_cache(payload.provider)
        revision = state.bump_runtime_revision("providers")
        state.emit_runtime_event(
            "providers_changed",
            {
                "provider": payload.provider,
                "keys_set": state.build_key_status_map(),
                "revision": revision,
            },
        )
        return {
            "status": "success",
            "provider": payload.provider,
            "revision": revision,
        }

    return router
