from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException

from api.schemas import HistoryReprocessPayload
from api.state import BackendAppState
from writing_memory import (
    DictionaryEntryPayload,
    ReplacementEntryPayload,
    SnippetEntryPayload,
)


def build_writing_tools_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.get("/writing-tools")
    def get_writing_tools():
        return state.writing_tools_store.get_tools().model_dump(mode="json")

    @router.post("/writing-tools/dictionary")
    def create_dictionary_entry(payload: DictionaryEntryPayload):
        try:
            entry = state.writing_tools_store.create_dictionary_entry(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success", "entry": entry.model_dump(mode="json")}

    @router.put("/writing-tools/dictionary/{entry_id}")
    def update_dictionary_entry(entry_id: int, payload: DictionaryEntryPayload):
        try:
            entry = state.writing_tools_store.update_dictionary_entry(entry_id, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success", "entry": entry.model_dump(mode="json")}

    @router.delete("/writing-tools/dictionary/{entry_id}")
    def delete_dictionary_entry(entry_id: int):
        try:
            state.writing_tools_store.delete_dictionary_entry(entry_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success"}

    @router.post("/writing-tools/replacements")
    def create_replacement_entry(payload: ReplacementEntryPayload):
        try:
            entry = state.writing_tools_store.create_replacement_entry(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success", "entry": entry.model_dump(mode="json")}

    @router.put("/writing-tools/replacements/{entry_id}")
    def update_replacement_entry(entry_id: int, payload: ReplacementEntryPayload):
        try:
            entry = state.writing_tools_store.update_replacement_entry(entry_id, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success", "entry": entry.model_dump(mode="json")}

    @router.delete("/writing-tools/replacements/{entry_id}")
    def delete_replacement_entry(entry_id: int):
        try:
            state.writing_tools_store.delete_replacement_entry(entry_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success"}

    @router.post("/writing-tools/snippets")
    def create_snippet_entry(payload: SnippetEntryPayload):
        try:
            entry = state.writing_tools_store.create_snippet_entry(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success", "entry": entry.model_dump(mode="json")}

    @router.put("/writing-tools/snippets/{entry_id}")
    def update_snippet_entry(entry_id: int, payload: SnippetEntryPayload):
        try:
            entry = state.writing_tools_store.update_snippet_entry(entry_id, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success", "entry": entry.model_dump(mode="json")}

    @router.delete("/writing-tools/snippets/{entry_id}")
    def delete_snippet_entry(entry_id: int):
        try:
            state.writing_tools_store.delete_snippet_entry(entry_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("writing_tools")
        state.emit_runtime_event("writing_tools_invalidated", {"revision": revision})
        return {"status": "success"}

    @router.get("/history")
    def get_history():
        try:
            items = state.writing_tools_store.list_history()
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"items": [item.model_dump(mode="json") for item in items]}

    @router.post("/history/{item_id}/reprocess")
    def reprocess_history(item_id: int, payload: Optional[HistoryReprocessPayload] = None):
        if state.engine.is_processing:
            raise HTTPException(
                status_code=409,
                detail="The local engine is busy. Finish the current request before reprocessing history.",
            )
        try:
            item = state.engine.reprocess_history_item(
                item_id,
                skill_id=payload.skill_id if payload else None,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("history")
        state.emit_runtime_event(
            "history_invalidated",
            {"revision": revision, "item_id": item.id},
        )
        return {"status": "success", "item": item.model_dump(mode="json")}

    @router.delete("/history/{item_id}")
    def delete_history_item(item_id: int):
        try:
            state.writing_tools_store.delete_history_item(item_id)
            state.rebuild_library_memory(reset_tombstones=False)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("history")
        state.emit_runtime_event(
            "history_invalidated",
            {"revision": revision, "item_id": item_id},
        )
        return {"status": "success"}

    @router.delete("/history")
    def clear_history():
        try:
            state.writing_tools_store.clear_history()
            state.rebuild_library_memory(reset_tombstones=False)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("history")
        state.emit_runtime_event("history_invalidated", {"revision": revision})
        return {"status": "success"}

    return router
