from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from api.schemas import (
    ActionReviewDecisionPayload,
    LocalTaskCancelPayload,
    LocalTaskCreatePayload,
    LocalTaskReviewDecisionPayload,
    PasteAckPayload,
)
from api.state import BackendAppState
from runtime_events import build_heartbeat_event, encode_sse_event
from utils.logger import get_logger

logger = get_logger()


def build_runtime_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.get("/status")
    def get_status():
        return state.build_status_payload()

    @router.get("/events/runtime")
    async def get_runtime_events(request: Request, max_events: Optional[int] = None):
        subscriber_id, queue = await state.runtime_event_broker.subscribe()

        async def event_stream():
            heartbeat_interval_seconds = 15.0
            disconnect_poll_seconds = 0.75
            last_heartbeat_at = asyncio.get_running_loop().time()
            sent_events = 0
            try:
                while True:
                    if await request.is_disconnected():
                        break

                    try:
                        envelope = await asyncio.wait_for(
                            queue.get(),
                            timeout=disconnect_poll_seconds,
                        )
                    except asyncio.TimeoutError:
                        now = asyncio.get_running_loop().time()
                        if (now - last_heartbeat_at) < heartbeat_interval_seconds:
                            continue
                        envelope = build_heartbeat_event()
                        last_heartbeat_at = now

                    if envelope.get("type") != "heartbeat":
                        last_heartbeat_at = asyncio.get_running_loop().time()
                    yield encode_sse_event(envelope)
                    sent_events += 1
                    if max_events is not None and sent_events >= max_events:
                        break
            finally:
                state.runtime_event_broker.unsubscribe(subscriber_id)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @router.post("/status/clear_paste")
    def clear_paste():
        logger.info("[API] Clearing pending delivery state.")
        state.engine.clear_pending_paste()
        return {"status": "cleared"}

    @router.post("/status/paste/ack")
    def acknowledge_paste(payload: PasteAckPayload):
        if not state.engine.acknowledge_pending_paste(payload.id):
            logger.warning(
                "[API] Paste acknowledgement mismatch id=%s result=%s",
                payload.id,
                payload.result,
            )
            raise HTTPException(
                status_code=409,
                detail="The pending paste no longer matches the current backend state.",
            )
        logger.info(
            "[API] Paste acknowledgement accepted id=%s result=%s",
            payload.id,
            payload.result,
        )
        return {"status": "success", "result": payload.result}

    @router.post("/actions/review/approve")
    def approve_action_review(payload: ActionReviewDecisionPayload):
        try:
            return state.engine.approve_pending_action_review(payload.run_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/actions/review/reject")
    def reject_action_review(payload: ActionReviewDecisionPayload):
        if not state.engine.reject_pending_action_review(payload.run_id):
            raise HTTPException(
                status_code=409,
                detail="The reviewed action no longer matches the current backend state.",
            )
        return {"status": "rejected", "run_id": payload.run_id}

    @router.post("/tasks/local")
    def create_local_task(payload: LocalTaskCreatePayload):
        create_kwargs = {
            "request_text": payload.request_text,
            "command": payload.command,
            "cwd": payload.cwd,
            "title": payload.title,
        }
        if payload.run_kind != "single_step":
            create_kwargs["run_kind"] = payload.run_kind
        if payload.plan_summary is not None:
            create_kwargs["plan_summary"] = payload.plan_summary
        if payload.steps:
            create_kwargs["steps"] = payload.steps
        try:
            return state.engine.create_local_task_run(**create_kwargs)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/tasks/local/review/approve")
    def approve_local_task_review(payload: LocalTaskReviewDecisionPayload):
        approve_kwargs = {
            "run_id": payload.run_id,
            "review_id": payload.review_id,
        }
        if payload.retry_mode is not None:
            approve_kwargs["retry_mode"] = payload.retry_mode
        try:
            return state.engine.approve_local_task_review(**approve_kwargs)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/tasks/local/review/reject")
    def reject_local_task_review(payload: LocalTaskReviewDecisionPayload):
        try:
            return state.engine.reject_local_task_review(
                run_id=payload.run_id,
                review_id=payload.review_id,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/tasks/local/cancel")
    def cancel_local_task(payload: LocalTaskCancelPayload):
        try:
            return state.engine.cancel_local_task_run(run_id=payload.run_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/tasks/local")
    def list_local_tasks(limit: int = 20):
        return {"runs": state.engine.list_local_task_runs(limit=limit)}

    @router.get("/tasks/local/{run_id}")
    def get_local_task(run_id: str):
        run = state.engine.get_local_task_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="The requested local task run could not be found.")
        return run

    return router
