from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from api.schemas import (
    LiveTranscriptionChunkPayload,
    LiveTranscriptionFinishPayload,
    LiveTranscriptionStartPayload,
    ProcessAudioPayload,
    TestAudioPayload,
)
from api.state import BackendAppState
from utils.logger import get_logger

logger = get_logger()


def build_recording_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.post("/recording/process")
    def process_recording(payload: ProcessAudioPayload):
        if state.engine.is_processing:
            raise HTTPException(
                status_code=409,
                detail="The local engine is still processing the previous recording.",
            )

        try:
            wav_path = state.write_uploaded_wav(payload.audio_base64)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        capture_stats = payload.capture_stats.model_dump() if payload.capture_stats else {}
        logger.info(
            "[API] Uploaded recording accepted — mode=%s device=%r duration_ms=%s peak=%.4f rms=%.6f fallback=%s",
            payload.mode,
            capture_stats.get("used_device_label"),
            capture_stats.get("duration_ms"),
            capture_stats.get("peak", 0.0),
            capture_stats.get("rms", 0.0),
            capture_stats.get("fallback_to_default", False),
        )

        try:
            state.engine.start_processing(
                wav_path=wav_path,
                mode=payload.mode,
                context=payload.context.model_dump() if payload.context else None,
                context_warning=payload.context_warning,
                capture_stats=capture_stats,
                capture_timeline=payload.capture_timeline,
                selection_text=payload.selection_text,
                selection_truncated=payload.selection_truncated,
                clipboard_text=payload.clipboard_text,
                clipboard_truncated=payload.clipboard_truncated,
                screen_capture=payload.screen_capture,
                streaming_transcript=payload.streaming_transcript,
                streaming_source=payload.streaming_source,
            )
        except RuntimeError as exc:
            Path(wav_path).unlink(missing_ok=True)
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        state.live_transcription_manager.clear_session(
            session_id=payload.live_transcription_session_id
        )
        return {"status": "accepted", "message": f"Started {payload.mode} processing"}

    @router.post("/live_transcription/start")
    def start_live_transcription(payload: LiveTranscriptionStartPayload):
        state_payload = state.live_transcription_manager.start_session(
            session_id=payload.session_id,
            mode=payload.mode,
        )
        return {
            "status": "started",
            "live_transcription": state_payload,
        }

    @router.post("/live_transcription/chunk")
    def ingest_live_transcription_chunk(payload: LiveTranscriptionChunkPayload):
        accepted = state.live_transcription_manager.append_chunk(
            session_id=payload.session_id,
            pcm_s16le_base64=payload.pcm_s16le_base64,
            sample_rate=payload.sample_rate,
        )
        return {"status": "accepted" if accepted else "ignored"}

    @router.post("/live_transcription/finish")
    def finish_live_transcription(payload: LiveTranscriptionFinishPayload):
        result = state.live_transcription_manager.finish_session(
            session_id=payload.session_id
        )
        return {"status": "finished", **result}

    @router.post("/audio/test/process")
    def process_audio_test(payload: TestAudioPayload):
        if state.engine.is_processing:
            raise HTTPException(
                status_code=409,
                detail="The local engine is busy. Finish the current request before running a mic test.",
            )

        try:
            wav_path = state.write_uploaded_wav(payload.audio_base64)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        capture_stats = payload.capture_stats.model_dump() if payload.capture_stats else {}
        logger.info(
            "[API] Uploaded mic test accepted — device=%r duration_ms=%s peak=%.4f rms=%.6f fallback=%s",
            capture_stats.get("used_device_label"),
            capture_stats.get("duration_ms"),
            capture_stats.get("peak", 0.0),
            capture_stats.get("rms", 0.0),
            capture_stats.get("fallback_to_default", False),
        )
        return state.engine.process_test_audio(wav_path)

    return router
