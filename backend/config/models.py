from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import List, Literal, Optional

from domains.models import AppDomainDefault, DomainsConfig

class STTConfig(BaseModel):
    provider: str = Field(default="mlx-whisper", description="The default STT provider (e.g., mlx-whisper, groq, deepgram, openai, nvidia, sarvam)")
    model: str = Field(default="mlx-community/whisper-large-v3-turbo", description="The specific model used for STT")
    language: str = Field(default="en", description="Default language code")
    language_mode: Literal["fixed", "auto"] = Field(
        default="fixed",
        description="Use a fixed STT language or let supported providers auto-detect it.",
    )
    preferred_languages: List[str] = Field(
        default_factory=lambda: ["en"],
        description="Preferred language codes used as fallback ordering when auto-detect is unavailable.",
    )

    @field_validator("preferred_languages", mode="before")
    @classmethod
    def normalize_preferred_languages(cls, value: object) -> List[str]:
        if value is None:
            return ["en"]
        if isinstance(value, str):
            items = [segment.strip() for segment in value.split(",")]
        elif isinstance(value, list):
            items = [str(segment).strip() for segment in value]
        else:
            raise ValueError("preferred_languages must be a list or comma-separated string.")

        normalized: List[str] = []
        seen: set[str] = set()
        for item in items:
            if not item:
                continue
            lowered = item.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            normalized.append(lowered)
        return normalized or ["en"]

class RoutingModelConfig(BaseModel):
    enabled: bool = Field(default=True, description="Enable the optional Smart router fallback model for ambiguous Smart Mode requests.")
    provider: str = Field(default="lmstudio", description="The provider used by the Smart router fallback model.")
    model: str = Field(default="local-model", description="The specific model used by the Smart router fallback.")
    temperature: float = Field(default=0.0, description="Temperature for the Smart router model.")


class LLMConfig(BaseModel):
    provider: str = Field(default="lmstudio", description="The default LLM provider (e.g., lmstudio, groq, anthropic, openai, gemini, nvidia, sarvam)")
    model: str = Field(default="local-model", description="The specific model used for the Supervisor Agent")
    temperature: float = Field(default=0.0, description="Temperature for generation (lower is generally better for reliable code/formatting)")
    routing: RoutingModelConfig = Field(default_factory=RoutingModelConfig)


class VisionConfig(BaseModel):
    enabled: bool = Field(default=True, description="Capture the primary display during Smart Mode and ask a local vision-capable LM Studio model for extra context.")
    model: Optional[str] = Field(default=None, description="Optional explicit LM Studio vision model id. When empty, Smart Mode reuses the selected LM Studio text model if it supports vision.")
    timeout_ms: int = Field(default=2500, ge=500, le=10000, description="Timeout for local vision context extraction.")


class LocalTaskShellConfig(BaseModel):
    enabled: bool = Field(
        default=True,
        description="Enable the SteerVox-native local task shell for reviewed, local-only command execution.",
    )
    safety_mode: Literal["strict"] = Field(
        default="strict",
        description="The local task shell currently runs only in strict local-only mode.",
    )
    allowed_directories: List[str] = Field(
        default_factory=list,
        description="Optional extra local directories that the reviewed task shell may use as working roots.",
    )

    @field_validator("allowed_directories", mode="before")
    @classmethod
    def normalize_allowed_directories(cls, value: object) -> List[str]:
        if value is None:
            return []
        if isinstance(value, str):
            items = [segment.strip() for segment in value.split("\n")]
        elif isinstance(value, list):
            items = [str(segment).strip() for segment in value]
        else:
            raise ValueError("allowed_directories must be a list or newline-delimited string.")

        normalized: List[str] = []
        seen: set[str] = set()
        for item in items:
            if not item:
                continue
            if item in seen:
                continue
            seen.add(item)
            normalized.append(item)
        return normalized


class ActionsConfig(BaseModel):
    enabled: bool = Field(
        default=True,
        description="Enable desktop actions inside Smart Mode. When disabled, explicit action requests return a controlled error instead of running.",
    )
    auto_approve_reviewed: bool = Field(
        default=False,
        description="Automatically execute reviewed actions without showing the approval step. Low-risk auto UI actions are unaffected because they already auto-run.",
    )
    experimental_media_controls: bool = Field(
        default=False,
        description="Enable beta system-wide media transport controls such as global play/pause and track navigation.",
    )
    local_task_shell: LocalTaskShellConfig = Field(
        default_factory=LocalTaskShellConfig,
        description="Settings for the SteerVox-native reviewed local task shell.",
    )

class AppSkillDefault(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    app_label: str
    bundle_id: Optional[str] = None
    url_host: Optional[str] = None
    app_name: str
    skill_id: str
    enabled: bool = True

    @field_validator("id", "app_label", "app_name", "skill_id")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Field cannot be empty.")
        return value.strip()

    @field_validator("bundle_id")
    @classmethod
    def normalize_bundle_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("url_host")
    @classmethod
    def normalize_url_host(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip().lower().removeprefix("https://").removeprefix("http://").strip("/")
        return cleaned or None

class HotkeyConfig(BaseModel):
    default_skill_id: str = Field(default="system_dictation", description="The default skill to use for smart transform")
    app_skill_defaults: List[AppSkillDefault] = Field(
        default_factory=list,
        description="Optional app-specific Smart Mode skill overrides.",
    )

class AudioConfig(BaseModel):
    input_device: Optional[str] = Field(default=None, description="The specific microphone device name to use. None = system default.")
    input_device_id: Optional[str] = Field(default=None, description="The Electron media device id to use for capture. None = system default.")
    input_device_label: Optional[str] = Field(default=None, description="The last-known label for the selected Electron media device.")
    enable_recording_cues: bool = Field(default=False, description="Play short start and stop cues for dictation and Smart Mode recording.")
    live_transcription_mode: Literal["off", "auto", "local_only", "provider_only"] = Field(
        default="auto",
        description="Choose how live transcription previews are generated while recording.",
    )


class SensitiveTargetRule(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    app_label: str
    bundle_id: Optional[str] = None
    url_host: Optional[str] = None
    app_name: str
    mode: Literal["minimize_context", "block_external_text"]
    enabled: bool = True

    @field_validator("id", "app_label", "app_name")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Field cannot be empty.")
        return value.strip()

    @field_validator("bundle_id")
    @classmethod
    def normalize_bundle_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("url_host")
    @classmethod
    def normalize_url_host(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip().lower().removeprefix("https://").removeprefix("http://").strip("/")
        if "/" in cleaned:
            cleaned = cleaned.split("/", 1)[0]
        return cleaned or None


class PrivacyConfig(BaseModel):
    restore_clipboard_after_paste: bool = Field(
        default=True,
        description="Restore the previous clipboard contents after pasting transformed text.",
    )
    minimize_sensitive_context: bool = Field(
        default=False,
        description="Trim app and browser metadata further when a sensitive target rule matches.",
    )
    sensitive_targets: List[SensitiveTargetRule] = Field(
        default_factory=list,
        description="Optional app or site rules that reduce Smart Mode context or suppress external text.",
    )

class DebugConfig(BaseModel):
    log_sensitive_transcripts: bool = Field(
        default=False,
        description="When enabled, raw transcripts and rewritten output may be written to logs for debugging."
    )
    persist_recordings: bool = Field(
        default=False,
        description="When enabled, timestamped WAV debug recordings are kept on disk."
    )


class MemoryConfig(BaseModel):
    enabled: bool = Field(
        default=True,
        description="Allow Smart Mode to use local long-term memory context when it is relevant.",
    )
    auto_learn_from_history: bool = Field(
        default=True,
        description="Learn recurring preferences and user facts from local history entries only.",
    )
    semantic_retrieval_enabled: bool = Field(
        default=True,
        description="Use optional local semantic retrieval when the semantic memory runtime is installed; otherwise fall back to lexical local memory.",
    )

class AppConfig(BaseModel):
    stt: STTConfig = Field(default_factory=STTConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    vision: VisionConfig = Field(default_factory=VisionConfig)
    actions: ActionsConfig = Field(default_factory=ActionsConfig)
    hotkeys: HotkeyConfig = Field(default_factory=HotkeyConfig)
    domains: DomainsConfig = Field(default_factory=DomainsConfig)
    audio: AudioConfig = Field(default_factory=AudioConfig)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    debug: DebugConfig = Field(default_factory=DebugConfig)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
