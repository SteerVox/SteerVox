from __future__ import annotations

from fastapi import APIRouter, HTTPException

from api.state import BackendAppState
from domains.models import DomainImportPayload


def build_domains_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.get("/domains")
    def list_domains():
        details = state.domain_memory_store.list_pack_details()
        return {
            "packs": [
                pack.model_dump(mode="json")
                for pack in state.domain_memory_store.list_packs()
            ],
            "details": [detail.model_dump(mode="json") for detail in details],
        }

    @router.post("/domains/import")
    def import_domain_overlay(payload: DomainImportPayload):
        try:
            summary = state.domain_memory_store.import_overlay(
                payload.domain_id,
                payload.overlay,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("domains")
        state.emit_runtime_event(
            "domains_invalidated",
            {"revision": revision, "domain_id": payload.domain_id},
        )
        return {"status": "success", "pack": summary.model_dump(mode="json")}

    @router.get("/domains/export/{domain_id}")
    def export_domain_overlay(domain_id: str):
        if domain_id not in {"shipping", "medical"}:
            raise HTTPException(status_code=404, detail="Unknown domain.")

        try:
            payload = state.domain_memory_store.export_overlay(domain_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        return payload.model_dump(mode="json")

    return router
