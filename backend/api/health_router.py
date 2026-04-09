from __future__ import annotations

from fastapi import APIRouter

from utils.branding import HEALTH_MESSAGE


def build_health_router() -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    def health_check():
        return {"status": "ok", "message": HEALTH_MESSAGE}

    return router
