from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class APIKeyPayload(BaseModel):
    provider: str
    key: str


class SmartContextPayload(BaseModel):
    app_name: str = "Unknown"
    bundle_id: Optional[str] = None
    window_title: Optional[str] = None
    page_title: Optional[str] = None
    url_host: Optional[str] = None
    url_path: Optional[str] = None
    focused_field_role: Optional[str] = None
    focused_field_subrole: Optional[str] = None
    focused_field_label: Optional[str] = None
    focused_field_placeholder: Optional[str] = None


class CaptureStatsPayload(BaseModel):
    duration_ms: int = 0
    peak: float = 0.0
    rms: float = 0.0
    used_device_id: Optional[str] = None
    used_device_label: Optional[str] = None
    fallback_to_default: bool = False
    fallback_notice: Optional[str] = None


class ProcessAudioPayload(BaseModel):
    audio_base64: str
    mode: str = "dictation"
    context: Optional[SmartContextPayload] = None
    context_warning: Optional[str] = None
    capture_stats: Optional[CaptureStatsPayload] = None
    capture_timeline: Optional[dict] = None
    selection_text: Optional[str] = None
    selection_truncated: bool = False
    clipboard_text: Optional[str] = None
    clipboard_truncated: bool = False
    screen_capture: Optional[dict] = None
    streaming_transcript: Optional[str] = None
    streaming_source: Optional[str] = None
    live_transcription_session_id: Optional[str] = None


class TestAudioPayload(BaseModel):
    audio_base64: str
    capture_stats: Optional[CaptureStatsPayload] = None


class HistoryReprocessPayload(BaseModel):
    skill_id: Optional[str] = None


class PasteAckPayload(BaseModel):
    id: str
    result: str = "pasted"


class ActionReviewDecisionPayload(BaseModel):
    run_id: str


class RefreshProviderModelsPayload(BaseModel):
    provider: Optional[str] = None


class LiveTranscriptionStartPayload(BaseModel):
    session_id: str
    mode: str = "dictation"


class LiveTranscriptionChunkPayload(BaseModel):
    session_id: str
    pcm_s16le_base64: str
    sample_rate: int = 16000


class LiveTranscriptionFinishPayload(BaseModel):
    session_id: str
