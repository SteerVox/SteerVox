from __future__ import annotations

import base64
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from agent.skills.manager import SkillManager
from config.manager import ConfigManager
from domains import DomainMemoryStore, resolve_domain
from engine import SteerVoxEngine
from inbox import InboxStore
from live_transcription import LiveTranscriptionManager
from local_memory import LocalMemoryStore
from providers.stt_factory import build_local_stt_status
from providers.model_discovery import ModelDiscovery
from runtime_events import RuntimeEventBroker
from security.secrets_manager import SecretsManager
from usage_stats import UsageStatsStore
from utils.logger import get_logger
from utils.paths import get_temp_dir, safe_chmod
from writing_memory import WritingToolsStore

KEYLESS_PROVIDERS = {"local", "lmstudio", "mlx-whisper"}
RUNTIME_REVISION_KEYS = (
    "config",
    "providers",
    "history",
    "tasks",
    "inbox",
    "skills",
    "domains",
    "writing_tools",
    "usage",
)
MAX_UPLOADED_WAV_BYTES = 10 * 1024 * 1024

logger = get_logger()


@dataclass
class BackendAppState:
    config_manager: ConfigManager = field(default_factory=ConfigManager)
    skill_manager: SkillManager = field(default_factory=SkillManager)
    usage_stats_store: UsageStatsStore = field(default_factory=UsageStatsStore)
    domain_memory_store: DomainMemoryStore = field(default_factory=DomainMemoryStore)
    writing_tools_store: WritingToolsStore = field(default_factory=WritingToolsStore)
    memory_store: LocalMemoryStore = field(default_factory=LocalMemoryStore)
    inbox_store: InboxStore = field(init=False)
    runtime_revisions: dict[str, int] = field(
        default_factory=lambda: {key: 0 for key in RUNTIME_REVISION_KEYS}
    )
    engine: SteerVoxEngine = field(init=False)
    live_transcription_manager: LiveTranscriptionManager = field(init=False)
    runtime_event_broker: RuntimeEventBroker = field(init=False)

    def __post_init__(self) -> None:
        self.inbox_store = InboxStore(self.writing_tools_store)
        self.runtime_event_broker = RuntimeEventBroker(self.build_runtime_snapshot)
        self.engine = self._build_engine()
        self.live_transcription_manager = LiveTranscriptionManager(
            runtime_event_emitter=self.emit_runtime_event
        )

    def _build_engine(self) -> SteerVoxEngine:
        return SteerVoxEngine(
            usage_stats_store=self.usage_stats_store,
            domain_memory_store=self.domain_memory_store,
            writing_tools_store=self.writing_tools_store,
            memory_store=self.memory_store,
            inbox_store=self.inbox_store,
            runtime_event_emitter=self.emit_runtime_event,
        )

    def restart_engine(self) -> SteerVoxEngine:
        config = self.config_manager.get_config()
        logger.info(
            "[BackendState] Restarting engine with Smart=%s/%s router=%s/%s",
            config.llm.provider,
            config.llm.model,
            config.llm.routing.provider,
            config.llm.routing.model,
        )
        self.engine.shutdown()
        self.engine = self._build_engine()
        return self.engine

    def rebuild_library_memory(self, *, reset_tombstones: bool = False):
        config = self.config_manager.get_config()
        if not getattr(config, "memory", None) or not config.memory.auto_learn_from_history:
            return self.memory_store.list_memories()
        return self.memory_store.rebuild_from_library(
            self.writing_tools_store.list_library_memory_sources(),
            reset_tombstones=reset_tombstones,
        )

    def bump_runtime_revision(self, scope: str) -> int:
        self.runtime_revisions[scope] = self.runtime_revisions.get(scope, 0) + 1
        return self.runtime_revisions[scope]

    def build_key_status_map(self) -> dict[str, bool]:
        providers = ["groq", "openai", "anthropic", "deepgram", "gemini", "nvidia", "sarvam"]
        result: dict[str, bool] = {}
        for provider in providers:
            key = SecretsManager.get_api_key(provider)
            result[provider] = bool(key and len(key) > 0)
        return result

    def build_active_domain_payload(self) -> Optional[dict]:
        config = self.config_manager.get_config()
        selection = resolve_domain(context=self.engine.captured_context, domains=config.domains)
        if not selection.domain_id:
            return None

        pack = self.domain_memory_store.get_runtime_pack(selection.domain_id)
        return {
            "id": selection.domain_id,
            "label": pack.label if pack else selection.domain_id.replace("_", " ").title(),
            "source": selection.source,
            "rule_id": selection.rule_id,
            "rule_label": selection.rule_label,
        }

    def build_status_payload(self) -> dict:
        self.engine.reconcile_runtime_state()
        config = self.config_manager.get_config()
        stt_key = (
            SecretsManager.get_api_key(config.stt.provider)
            if config.stt.provider not in KEYLESS_PROVIDERS
            else True
        )
        llm_key = (
            SecretsManager.get_api_key(config.llm.provider)
            if config.llm.provider not in KEYLESS_PROVIDERS
            else True
        )

        return {
            "backend_ready": True,
            "is_recording": False,
            "is_processing": self.engine.is_processing,
            "active_mode": self.engine.active_mode,
            "active_skill": config.hotkeys.default_skill_id,
            "audio_amplitude": 0.0,
            "last_error": self.engine.last_error,
            "pending_paste_text": self.engine.pending_paste_text,
            "pending_paste": {
                "id": self.engine.pending_paste["id"],
                "text": self.engine.pending_paste["text"],
                "restore_clipboard_after_paste": config.privacy.restore_clipboard_after_paste,
            }
            if self.engine.pending_paste
            else None,
            "pending_notification": self.engine.pending_notification,
            "missing_api_keys": not (stt_key and llm_key),
            "recording_cues_enabled": config.audio.enable_recording_cues,
            "restore_clipboard_after_paste": config.privacy.restore_clipboard_after_paste,
            "phase": self.engine.phase,
            "phase_label": self.engine.phase_label,
            "captured_context": self.engine.captured_context,
            "captured_context_at": self.engine.captured_context_at,
            "captured_context_quality": self.engine.captured_context_quality,
            "active_domain": self.build_active_domain_payload(),
            "target_type": self.engine.target_type,
            "context_warning": self.engine.context_warning,
            "last_smart_run": self.engine.last_smart_run,
            "smart_preview": self.engine.smart_preview,
            "pending_action_review": self.engine.pending_action_review,
            "pending_review": self.engine.pending_review,
            "active_task_run": self.engine.active_task_run,
            "task_result_summary": self.engine.task_result_summary,
            "live_transcription": self.live_transcription_manager.state,
            "local_stt": build_local_stt_status(
                config.stt.provider,
                config.stt.model,
            ),
            "pipeline_timings": self.engine.pipeline_timings,
        }

    def build_runtime_snapshot(self) -> dict:
        return {
            "status": self.build_status_payload(),
            "usage": self.usage_stats_store.get_stats().model_dump(),
            "config": self.config_manager.get_config().model_dump(),
            "keys_set": self.build_key_status_map(),
            "revisions": dict(self.runtime_revisions),
        }

    def emit_runtime_event(self, event_type: str, payload: Optional[dict] = None) -> None:
        if event_type == "status":
            self.runtime_event_broker.publish("status", self.build_status_payload())
            return

        if event_type == "pending_paste":
            status_payload = self.build_status_payload()
            self.runtime_event_broker.publish(
                "pending_paste",
                {
                    "pending_paste": status_payload.get("pending_paste"),
                    "pending_paste_text": status_payload.get("pending_paste_text"),
                },
            )
            return

        if event_type == "notification":
            self.runtime_event_broker.publish(
                "notification",
                self.build_status_payload().get("pending_notification"),
            )
            return

        if event_type == "smart_preview":
            self.runtime_event_broker.publish(
                "smart_preview",
                self.build_status_payload().get("smart_preview"),
            )
            return

        if event_type == "pending_action_review":
            self.runtime_event_broker.publish(
                "pending_action_review",
                self.build_status_payload().get("pending_action_review"),
            )
            self.runtime_event_broker.publish(
                "pending_review",
                self.build_status_payload().get("pending_review"),
            )
            return

        if event_type == "pending_review":
            self.runtime_event_broker.publish(
                "pending_review",
                self.build_status_payload().get("pending_review"),
            )
            return

        if event_type == "active_task_run":
            self.runtime_event_broker.publish(
                "active_task_run",
                self.build_status_payload().get("active_task_run"),
            )
            return

        if event_type == "task_result_summary":
            self.runtime_event_broker.publish(
                "task_result_summary",
                self.build_status_payload().get("task_result_summary"),
            )
            return

        if event_type == "live_transcription":
            self.runtime_event_broker.publish(
                "live_transcription",
                self.build_status_payload().get("live_transcription"),
            )
            return

        if event_type == "usage":
            revision = (
                payload.get("revision")
                if payload and "revision" in payload
                else self.bump_runtime_revision("usage")
            )
            self.runtime_event_broker.publish(
                "usage",
                {
                    "usage": payload.get("usage")
                    if payload and "usage" in payload
                    else self.usage_stats_store.get_stats().model_dump(),
                    "revision": revision,
                },
            )
            return

        if event_type in {
            "history_invalidated",
            "task_runs_invalidated",
            "inbox_invalidated",
            "skills_invalidated",
            "domains_invalidated",
            "writing_tools_invalidated",
        }:
            scope = {
                "history_invalidated": "history",
                "task_runs_invalidated": "tasks",
                "inbox_invalidated": "inbox",
                "skills_invalidated": "skills",
                "domains_invalidated": "domains",
                "writing_tools_invalidated": "writing_tools",
            }[event_type]
            revision = (
                payload.get("revision")
                if payload and "revision" in payload
                else self.bump_runtime_revision(scope)
            )
            next_payload = dict(payload or {})
            next_payload["revision"] = revision
            self.runtime_event_broker.publish(event_type, next_payload)
            return

        if event_type == "config_changed":
            self.runtime_event_broker.publish(
                "config_changed",
                payload
                or {
                    "config": self.config_manager.get_config().model_dump(),
                    "revision": self.runtime_revisions["config"],
                },
            )
            return

        if event_type == "providers_changed":
            self.runtime_event_broker.publish(
                "providers_changed",
                payload
                or {
                    "keys_set": self.build_key_status_map(),
                    "revision": self.runtime_revisions["providers"],
                },
            )
            return

        self.runtime_event_broker.publish(event_type, payload)

    def write_uploaded_wav(self, audio_base64: str) -> str:
        try:
            audio_bytes = base64.b64decode(audio_base64, validate=True)
        except Exception as exc:  # pragma: no cover - converted to HTTP errors by callers
            raise ValueError(f"Invalid audio payload: {exc}") from exc

        if not audio_bytes:
            raise ValueError("Uploaded audio was empty.")
        if len(audio_bytes) > MAX_UPLOADED_WAV_BYTES:
            raise ValueError("Uploaded audio is too large.")

        with tempfile.NamedTemporaryFile(
            suffix=".wav",
            prefix="capture_",
            dir=get_temp_dir(),
            delete=False,
        ) as handle:
            handle.write(audio_bytes)
            temp_path = Path(handle.name)

        safe_chmod(temp_path, 0o600)
        return str(temp_path)
