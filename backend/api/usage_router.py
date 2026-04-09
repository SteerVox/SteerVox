from __future__ import annotations

from fastapi import APIRouter

from api.state import BackendAppState


def build_usage_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.get("/usage")
    def get_usage():
        return state.usage_stats_store.get_stats().model_dump()

    @router.delete("/usage")
    def reset_usage():
        stats = state.usage_stats_store.reset()
        revision = state.bump_runtime_revision("usage")
        state.emit_runtime_event(
            "usage",
            {"usage": stats.model_dump(), "revision": revision},
        )
        return {"status": "success", "usage": stats.model_dump()}

    return router
