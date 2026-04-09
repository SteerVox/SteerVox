from __future__ import annotations

from fastapi import APIRouter, HTTPException

from api.state import BackendAppState
from local_memory import MemoryTogglePayload


def build_memory_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.get("/memories")
    def list_memories():
        try:
            items = state.memory_store.list_memories()
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"items": [item.model_dump(mode="json") for item in items]}

    @router.put("/memories/{memory_id}")
    def update_memory(memory_id: int, payload: MemoryTogglePayload):
        try:
            item = state.memory_store.update_memory_enabled(memory_id, payload.enabled)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"status": "success", "item": item.model_dump(mode="json")}

    @router.delete("/memories/{memory_id}")
    def delete_memory(memory_id: int):
        try:
            state.memory_store.delete_memory(memory_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"status": "success"}

    @router.delete("/memories")
    def clear_memories():
        try:
            state.memory_store.clear_memories()
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"status": "success"}

    @router.post("/memories/rebuild")
    def rebuild_memories():
        try:
            items = state.memory_store.rebuild_from_history(
                state.writing_tools_store.list_history(limit=500),
                reset_tombstones=True,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"status": "success", "items": [item.model_dump(mode="json") for item in items]}

    return router
