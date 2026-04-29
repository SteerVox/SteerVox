from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


KEYLESS_MODEL_PROVIDERS = {"local", "lmstudio", "mlx-whisper"}
LibrarySourceType = Literal["note", "history"]
LibraryLane = Literal["note", "dictate", "smart", "local_task", "computer_use"]


class InboxNote(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    text: str
    created_at: str
    app_name: str = "Unknown"
    bundle_id: Optional[str] = None
    window_title: Optional[str] = None
    page_title: Optional[str] = None
    url_host: Optional[str] = None
    url_path: Optional[str] = None
    surface_kind: Optional[str] = None
    source_mode: str = "dictation"
    source_kind: str = "spoken_text"
    output_mode: Optional[str] = None


class LibraryItemMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source_mode: str
    source_kind: str
    output_mode: Optional[str] = None
    app_name: str = "Unknown app"
    bundle_id: Optional[str] = None
    window_title: Optional[str] = None
    page_title: Optional[str] = None
    url_host: Optional[str] = None
    url_path: Optional[str] = None
    surface_kind: Optional[str] = None
    stt_provider: Optional[str] = None
    stt_model: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    skill_id: Optional[str] = None
    skill_label: Optional[str] = None
    domain_id: Optional[str] = None
    intent: Optional[str] = None
    local_only: bool = False
    model_backed: bool = False
    transcript_chars: int = 0
    output_chars: int = 0
    duration_ms: Optional[int] = None
    step_count: Optional[int] = None
    completed_steps: Optional[int] = None
    failed_step_id: Optional[str] = None
    failed_step_title: Optional[str] = None
    memory_eligible: bool = False
    memory_state: Optional[Literal["eligible", "ignored"]] = None


class LibraryItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    source_type: LibrarySourceType
    source_id: str
    lane: LibraryLane
    title: str
    label: str
    preview: str
    created_at: str
    primary_text: str
    secondary_text: Optional[str] = None
    metadata: LibraryItemMetadata
    search_text: str = ""


class LibraryMemorySource(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source_type: LibrarySourceType
    source_id: str
    primary_text: str
    secondary_text: str = ""
    source_mode: str
    source_kind: str
    output_mode: Optional[str] = None
    app_name: Optional[str] = None
    url_host: Optional[str] = None
    domain_id: Optional[str] = None
    stt_provider: Optional[str] = None
    stt_model: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    created_at: str
    memory_eligible: bool = True
    memory_weight: float = Field(default=1.0, ge=0.1, le=2.0)

    @property
    def source_key(self) -> str:
        return f"{self.source_type}:{self.source_id}"
