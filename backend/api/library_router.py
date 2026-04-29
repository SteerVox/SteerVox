from __future__ import annotations

from fastapi import APIRouter, Query

from api.state import BackendAppState


def build_library_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.get("/library")
    def get_library(
        filter_value: str = Query(default="all", alias="filter"),
        q: str = Query(default=""),
        limit: int = Query(default=250, ge=1, le=1500),
    ):
        items = state.writing_tools_store.list_library_items(
            filter_value=filter_value,
            query=q,
            limit=limit,
        )
        return {
            "items": [item.model_dump(mode="json", exclude={"search_text"}) for item in items],
        }

    return router
