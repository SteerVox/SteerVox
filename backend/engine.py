import os
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from uuid import uuid4

from action_execution import PendingActionReview, execute_auto_action, execute_reviewed_action, validate_reviewed_action
from action_routing import (
    ActionRoute,
    InboxSourceKind,
    LocalActionRouter,
    infer_inbox_source_kind,
    resolve_external_text,
)
from agent.processor import SmartModeProcessor
from agent.smart_router_agent import SmartRouterAgent
from agent.skills.manager import SkillManager
from command_control import apply_command_control, apply_format_contract, apply_minimal_command_control, enforce_surface_contract
from config.manager import ConfigManager
from config.models import AppConfig
from context_profile import derive_context_quality, derive_target_type, normalize_context
from domains import DomainMemoryStore, apply_glossary_corrections, build_domain_retrieval_block, resolve_domain, resolve_domain_intent
from engine_runtime_state import EngineRuntimeCoordinator, EngineSessionState, RewriteContextPayload
from inbox import InboxStore, build_inbox_note
from local_memory import LocalMemoryStore
from local_task_shell.models import LocalTaskCreateRequest, LocalTaskStep, TaskRetryMode
from local_task_shell.service import LocalTaskShellService
from privacy_rules import minimize_context_fields, resolve_sensitive_targets, suppress_external_text
from providers.model_discovery import ModelDiscovery
from providers.stt_factory import STTFactory, STTHintPayload, STTTransientError
from skill_selection import resolve_active_skill_selection
from usage_stats import UsageStatsStore
from utils.logger import get_logger
from utils.paths import get_recordings_dir, safe_chmod
from vision_agent import VisionAgent
from writing_memory import (
    HistoryItem,
    WritingToolsStore,
    apply_dictionary_entries,
    apply_replacement_entries,
    apply_snippet_entries,
)

logger = get_logger()
MAX_STT_HINT_KEYWORDS = 12
MAX_STT_HINT_PROMPT_CHARS = 240
MEDICAL_DOMAIN_MODEL_PATTERN = "medgemma"
REMOTE_SMART_VISION_TIMEOUT_MS = 1000


class SteerVoxEngine:
    def __init__(
        self,
        *,
        usage_stats_store: Optional[UsageStatsStore] = None,
        domain_memory_store: Optional[DomainMemoryStore] = None,
        writing_tools_store: Optional[WritingToolsStore] = None,
        memory_store: Optional[LocalMemoryStore] = None,
        runtime_event_emitter: Optional[Callable[[str, Optional[dict[str, Any]]], None]] = None,
    ):
        self.config_manager = ConfigManager()

        config = self.config_manager.get_config()
        self.stt_client = STTFactory.get_client(config.stt.provider)
        self.skill_manager = SkillManager()
        self.smart_processor = SmartModeProcessor(
            provider=config.llm.provider,
            model=config.llm.model,
            temperature=config.llm.temperature,
            skill_manager=self.skill_manager,
            smart_router_agent=(
                SmartRouterAgent(
                    provider=config.llm.routing.provider,
                    model=config.llm.routing.model,
                    temperature=config.llm.routing.temperature,
                )
                if config.llm.routing.enabled
                else None
            ),
        )
        self.action_router = LocalActionRouter()
        self.inbox_store = InboxStore()
        self.usage_stats_store = usage_stats_store or UsageStatsStore()
        self.domain_memory_store = domain_memory_store or DomainMemoryStore()
        self.writing_tools_store = writing_tools_store or WritingToolsStore()
        self.memory_store = memory_store or LocalMemoryStore()
        self.vision_agent = VisionAgent()

        self._is_processing = False
        self._processing_lock = threading.Lock()
        self.runtime = EngineRuntimeCoordinator(runtime_event_emitter=runtime_event_emitter)
        self.local_task_shell = LocalTaskShellService(
            config_manager=self.config_manager,
            runtime_event_emitter=self._emit_runtime_event,
            on_run_finished=self._handle_local_task_finished,
        )
        self._action_error_clear_timer: Optional[threading.Timer] = None
        self._action_error_clear_token: Optional[str] = None

        logger.info(
            "[Engine] Initialized — source=%s cwd=%s app_root=%s STT=%s/%s LLM=%s/%s router=%s/%s",
            Path(__file__).resolve(),
            Path.cwd(),
            os.environ.get("APP_ROOT") or "dev",
            config.stt.provider,
            config.stt.model,
            config.llm.provider,
            config.llm.model,
            config.llm.routing.provider,
            config.llm.routing.model,
        )

    @property
    def is_recording(self) -> bool:
        return False

    @property
    def is_processing(self) -> bool:
        return self._is_processing

    @property
    def _session_state(self) -> EngineSessionState:
        return self.runtime.state

    @_session_state.setter
    def _session_state(self, value: EngineSessionState) -> None:
        self.runtime.state = value

    @property
    def _phase(self) -> str:
        return self._session_state.phase

    @_phase.setter
    def _phase(self, value: str) -> None:
        self._session_state.phase = value

    @property
    def _active_mode(self) -> Optional[str]:
        return self._session_state.active_mode

    @_active_mode.setter
    def _active_mode(self, value: Optional[str]) -> None:
        self._session_state.active_mode = value

    @property
    def active_mode(self) -> Optional[str]:
        return self._active_mode

    @property
    def last_error(self) -> Optional[str]:
        return self._session_state.last_error

    @last_error.setter
    def last_error(self, value: Optional[str]) -> None:
        self._session_state.last_error = value

    @property
    def pending_paste(self) -> Optional[Dict[str, Any]]:
        return self._session_state.pending_paste

    @pending_paste.setter
    def pending_paste(self, value: Optional[Dict[str, Any]]) -> None:
        self._session_state.pending_paste = value

    @property
    def pending_paste_text(self) -> Optional[str]:
        return self._session_state.pending_paste_text

    @pending_paste_text.setter
    def pending_paste_text(self, value: Optional[str]) -> None:
        self._session_state.pending_paste_text = value

    @property
    def pending_notification(self) -> Optional[Dict[str, Optional[str]]]:
        return self._session_state.pending_notification

    @pending_notification.setter
    def pending_notification(self, value: Optional[Dict[str, Optional[str]]]) -> None:
        self._session_state.pending_notification = value

    @property
    def context_warning(self) -> Optional[str]:
        return self._session_state.context_warning

    @context_warning.setter
    def context_warning(self, value: Optional[str]) -> None:
        self._session_state.context_warning = value

    @property
    def captured_context(self) -> Dict[str, Any]:
        return self._session_state.captured_context

    @captured_context.setter
    def captured_context(self, value: Optional[Dict[str, Any]]) -> None:
        self._session_state.captured_context = normalize_context(value)

    @property
    def captured_context_at(self) -> Optional[str]:
        return self._session_state.captured_context_at

    @captured_context_at.setter
    def captured_context_at(self, value: Optional[str]) -> None:
        self._session_state.captured_context_at = value

    @property
    def captured_context_quality(self) -> str:
        return self._session_state.captured_context_quality

    @captured_context_quality.setter
    def captured_context_quality(self, value: str) -> None:
        self._session_state.captured_context_quality = value

    @property
    def target_type(self) -> Optional[str]:
        return self._session_state.target_type

    @target_type.setter
    def target_type(self, value: Optional[str]) -> None:
        self._session_state.target_type = value

    @property
    def last_smart_run(self) -> Optional[Dict[str, Any]]:
        return self._session_state.last_smart_run

    @last_smart_run.setter
    def last_smart_run(self, value: Optional[Dict[str, Any]]) -> None:
        self._session_state.last_smart_run = value

    @property
    def smart_preview(self) -> Optional[Dict[str, Any]]:
        return self._session_state.smart_preview

    @smart_preview.setter
    def smart_preview(self, value: Optional[Dict[str, Any]]) -> None:
        self._session_state.smart_preview = value

    @property
    def pending_action_review(self) -> Optional[Dict[str, Any]]:
        return self._session_state.pending_action_review

    @pending_action_review.setter
    def pending_action_review(self, value: Optional[Dict[str, Any]]) -> None:
        self._session_state.pending_action_review = value

    @property
    def active_task_run(self) -> Optional[Dict[str, Any]]:
        return self.local_task_shell.active_run

    @property
    def task_result_summary(self) -> Optional[Dict[str, Any]]:
        return self.local_task_shell.last_result_summary

    @property
    def pending_review(self) -> Optional[Dict[str, Any]]:
        task_review = self.local_task_shell.pending_review
        if task_review is not None:
            return task_review
        current = self.pending_action_review
        if not current:
            return None
        run_id = str(current.get("run_id") or "")
        return {
            "id": f"desktop-action:{run_id}",
            "run_id": run_id,
            "scope": "desktop_action",
            "kind": "desktop_action",
            "title": current.get("title"),
            "summary": current.get("summary"),
            "detail": None,
            "command": None,
            "cwd": None,
            "risk_level": "medium",
            "status": current.get("status"),
            "error": current.get("error"),
            "language": current.get("language"),
            "script": current.get("script"),
        }

    @property
    def pipeline_timings(self) -> Dict[str, Optional[str]]:
        return self._session_state.pipeline_timings

    @pipeline_timings.setter
    def pipeline_timings(self, value: Dict[str, Optional[str]]) -> None:
        self._session_state.pipeline_timings = dict(value)

    @property
    def phase(self) -> str:
        return self._phase

    @property
    def phase_label(self) -> str:
        return self.runtime.phase_label()

    def _set_phase(self, phase: str):
        self.runtime.set_phase(phase)

    def _has_pending_delivery(self) -> bool:
        return self.runtime.has_pending_delivery()

    def reconcile_runtime_state(self) -> bool:
        return self.runtime.reconcile_runtime_state(is_processing=self._is_processing)

    def _settle_phase_after_processing(self) -> None:
        self.runtime.settle_phase_after_processing(is_processing=self._is_processing)

    def _emit_runtime_event(self, event_type: str, payload: Optional[dict[str, Any]] = None) -> None:
        self.runtime.emit_runtime_event(event_type, payload)

    def _now_iso(self) -> str:
        return self.runtime.now_iso()

    def _reset_pipeline_timings(self) -> None:
        self.runtime.reset_pipeline_timings()

    def _apply_capture_timeline(self, capture_timeline: Optional[Dict[str, Any]]) -> None:
        self.runtime.apply_capture_timeline(capture_timeline)

    def _mark_pipeline_timing(self, key: str) -> None:
        self.runtime.mark_pipeline_timing(key)

    def _current_smart_preview_text(self, run_id: Optional[str] = None) -> str:
        return self.runtime.current_smart_preview_text(run_id)

    def _emit_smart_preview(
        self,
        *,
        run_id: str,
        state: str,
        text: str = "",
        final_text: Optional[str] = None,
        error: Optional[str] = None,
        smart_profile: Optional[str] = None,
        smart_profile_label: Optional[str] = None,
    ) -> None:
        self.runtime.emit_smart_preview(
            run_id=run_id,
            state=state,
            text=text,
            final_text=final_text,
            error=error,
            smart_profile=smart_profile,
            smart_profile_label=smart_profile_label,
        )

    def create_local_task_run(
        self,
        *,
        request_text: str,
        command: Optional[str],
        cwd: Optional[str] = None,
        title: Optional[str] = None,
        source_intent: str = "local_task",
        run_kind: str = "single_step",
        plan_summary: Optional[str] = None,
        steps: Optional[list[LocalTaskStep]] = None,
    ) -> dict[str, Any]:
        if self._is_processing:
            raise RuntimeError("SteerVox is already busy with a voice pipeline.")
        return self.local_task_shell.create_run(
            LocalTaskCreateRequest(
                request_text=request_text,
                command=command,
                cwd=cwd,
                title=title,
                source_intent=source_intent,
                run_kind=run_kind,
                plan_summary=plan_summary,
                steps=list(steps or []),
            )
        )

    def approve_local_task_review(
        self,
        *,
        run_id: str,
        review_id: str,
        retry_mode: Optional[TaskRetryMode] = None,
    ) -> dict[str, Any]:
        return self.local_task_shell.approve_review(run_id=run_id, review_id=review_id, retry_mode=retry_mode)

    def reject_local_task_review(self, *, run_id: str, review_id: str) -> dict[str, Any]:
        return self.local_task_shell.reject_review(run_id=run_id, review_id=review_id)

    def cancel_local_task_run(self, *, run_id: str) -> dict[str, Any]:
        return self.local_task_shell.cancel_run(run_id=run_id)

    def get_local_task_run(self, run_id: str) -> Optional[dict[str, Any]]:
        return self.local_task_shell.get_run(run_id)

    def list_local_task_runs(self, *, limit: int = 20) -> list[dict[str, Any]]:
        return self.local_task_shell.list_runs(limit=limit)

    def _handle_local_task_finished(self, run, result_summary) -> None:
        saved_to_history = False
        saved_to_inbox = False
        try:
            history_plan_kind = None
            if run.source_intent == "computer_use":
                history_plan_kind = "multi_step" if run.run_kind == "multi_step" else "local_task"
            self.writing_tools_store.record_history(
                mode="local_task",
                transcript=run.request_text,
                final_output=result_summary.output_excerpt or result_summary.summary,
                telemetry={
                    "intent": run.source_intent,
                    "computer_use_plan_kind": history_plan_kind,
                    "status": result_summary.status,
                    "command": run.command,
                    "cwd": run.cwd,
                    "exit_code": result_summary.exit_code,
                    "plan_summary": result_summary.plan_summary,
                    "step_count": result_summary.step_count,
                    "completed_steps": result_summary.completed_steps,
                    "failed_step_id": result_summary.failed_step_id,
                    "failed_step_title": result_summary.failed_step_title,
                },
                context=self.captured_context,
                stt_provider=None,
                stt_model=None,
                llm_provider=None,
                llm_model=None,
            )
            saved_to_history = True
            self._emit_runtime_event("history_invalidated")
        except Exception as exc:
            logger.warning("[Engine] Failed to record local task history for %s: %s", run.run_id, exc)

        try:
            excerpt = result_summary.output_excerpt or result_summary.summary
            if excerpt:
                self.inbox_store.append_note(
                    build_inbox_note(
                        f"{run.title}\n\n{excerpt}".strip(),
                        context=self.captured_context,
                        source_mode="local_task",
                        source_kind="task_result",
                        output_mode="code",
                    )
                )
                saved_to_inbox = True
                self._emit_runtime_event("inbox_invalidated")
        except Exception as exc:
            logger.warning("[Engine] Failed to save local task note for %s: %s", run.run_id, exc)

        summary_payload = self.local_task_shell.last_result_summary or {}
        if summary_payload:
            summary_payload["saved_to_history"] = saved_to_history
            summary_payload["saved_to_inbox"] = saved_to_inbox

        if result_summary.status == "completed":
            self.last_error = None
            self.pending_notification = {
                "title": "Local task completed",
                "body": result_summary.summary,
            }
            self._emit_runtime_event("notification")
        else:
            self.last_error = result_summary.summary
        self._emit_runtime_event("status")

    def _has_usable_text(self, text: Optional[str]) -> bool:
        stripped = (text or "").strip()
        if not stripped:
            return False
        return any(char.isalnum() for char in stripped)

    def _record_usage_success(
        self,
        *,
        mode: str,
        output_text: str,
        stt_latency_ms: Optional[int],
        recording_duration_ms: int,
        pipeline_duration_ms: int,
    ) -> None:
        if mode not in {"dictation", "smart_transform"} or not self._has_usable_text(output_text):
            return

        try:
            self.usage_stats_store.record_success(
                mode=mode,
                output_text=output_text,
                stt_latency_ms=stt_latency_ms,
                recording_duration_ms=recording_duration_ms,
                pipeline_duration_ms=pipeline_duration_ms,
            )
            self._emit_runtime_event("usage")
        except Exception as exc:
            logger.warning("[Engine] Failed to record local usage stats: %s", exc)

    def _record_history_success(
        self,
        *,
        mode: str,
        transcript: str,
        final_output: str,
        telemetry: Optional[Dict[str, Any]],
        context_snapshot: Dict[str, Any],
        config: AppConfig,
    ) -> None:
        if mode not in {"dictation", "smart_transform"} or not self._has_usable_text(final_output):
            return

        try:
            telemetry_map = telemetry if isinstance(telemetry, dict) else {}
            self._record_history_entry(
                mode=mode,
                transcript=transcript,
                final_output=final_output,
                telemetry=telemetry_map if mode == "smart_transform" else {},
                context=context_snapshot,
                stt_provider=config.stt.provider,
                stt_model=config.stt.model,
                llm_provider=(telemetry_map.get("provider") or config.llm.provider) if mode == "smart_transform" else None,
                llm_model=(telemetry_map.get("model") or config.llm.model) if mode == "smart_transform" else None,
            )
            self._emit_runtime_event("history_invalidated")
        except Exception as exc:
            logger.warning("[Engine] Failed to record local history: %s", exc)

    def _record_history_entry(
        self,
        *,
        mode: str,
        transcript: str,
        final_output: str,
        telemetry: Optional[Dict[str, Any]],
        context: Dict[str, Any],
        stt_provider: Optional[str],
        stt_model: Optional[str],
        llm_provider: Optional[str],
        llm_model: Optional[str],
    ) -> HistoryItem:
        item = self.writing_tools_store.record_history(
            mode=mode,
            transcript=transcript,
            final_output=final_output,
            telemetry=telemetry or {},
            context=context,
            stt_provider=stt_provider,
            stt_model=stt_model,
            llm_provider=llm_provider,
            llm_model=llm_model,
        )
        self._refresh_local_memory(item)
        return item

    def _refresh_local_memory(self, history_item: Optional[HistoryItem] = None) -> None:
        config = self.config_manager.get_config()
        if not getattr(config, "memory", None) or not config.memory.auto_learn_from_history:
            return
        try:
            if history_item is not None:
                self.memory_store.learn_from_history_item(history_item)
            else:
                self.memory_store.rebuild_from_history(
                    self.writing_tools_store.list_history(limit=500),
                    reset_tombstones=False,
                )
        except Exception as exc:
            logger.warning("[Engine] Failed to refresh local memory from history: %s", exc)

    def _complete_with_notification(self, *, title: str, body: Optional[str]) -> None:
        self.pending_notification = {
            "title": title,
            "body": body,
        }
        self._set_phase("preparing_paste")
        self._emit_runtime_event("notification")
        self._emit_runtime_event("status")

    def _cancel_scheduled_action_error_clear(self) -> None:
        timer = self._action_error_clear_timer
        self._action_error_clear_timer = None
        self._action_error_clear_token = None
        if timer is not None:
            timer.cancel()

    def _complete_transient_action_error(self, message: str) -> None:
        self.last_error = message
        self._set_phase("error")
        self._emit_runtime_event("status")
        self._schedule_action_error_clear(error_message=message)

    def _complete_transient_smart_error(self, message: str) -> None:
        self._complete_transient_action_error(message)

    def _schedule_action_error_clear(
        self,
        *,
        delay_sec: float = 8.0,
        review_run_id: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> None:
        self._cancel_scheduled_action_error_clear()
        token = str(uuid4())
        self._action_error_clear_token = token

        def _clear() -> None:
            with self._processing_lock:
                if self._action_error_clear_token != token:
                    return
                self._action_error_clear_timer = None
                self._action_error_clear_token = None
                review_cleared = False
                if review_run_id:
                    current = self.pending_action_review
                    if current and current.get("run_id") == review_run_id and current.get("status") == "error":
                        self.pending_action_review = None
                        review_cleared = True
                        self._emit_runtime_event("pending_action_review")
                if error_message and self.last_error == error_message:
                    self.last_error = None
                if review_cleared or error_message:
                    if not self._is_processing:
                        self._set_phase("ready")
                    else:
                        self._emit_runtime_event("status")

        timer = threading.Timer(max(delay_sec, 0.5), _clear)
        timer.daemon = True
        self._action_error_clear_timer = timer
        timer.start()

    def _resolve_stt_language(self, config: AppConfig) -> Optional[str]:
        if config.stt.language_mode == "auto":
            if config.stt.provider in {"groq", "openai", "deepgram", "sarvam", "mlx-whisper", "nvidia"}:
                return None
            if config.stt.preferred_languages:
                return config.stt.preferred_languages[0]
            return config.stt.language or "en"
        return config.stt.language or (config.stt.preferred_languages[0] if config.stt.preferred_languages else "en")

    def _build_effective_vision_config(self, config: AppConfig) -> AppConfig:
        if config.llm.provider.lower() == "lmstudio":
            return config

        next_timeout_ms = min(config.vision.timeout_ms, REMOTE_SMART_VISION_TIMEOUT_MS)
        if next_timeout_ms == config.vision.timeout_ms:
            return config

        logger.info(
            "[Engine] Using reduced local vision timeout %d ms for remote Smart provider %s.",
            next_timeout_ms,
            config.llm.provider,
        )
        return config.model_copy(update={
            "vision": config.vision.model_copy(update={"timeout_ms": next_timeout_ms}),
        })

    def _uses_whisper_style_stt(self, config: AppConfig) -> bool:
        provider = str(config.stt.provider or "").strip().lower()
        model = str(config.stt.model or "").strip().lower()
        return provider == "mlx-whisper" or "whisper" in model

    def _apply_writing_tools(self, transcript: str) -> str:
        if not transcript.strip():
            return transcript
        return self._apply_writing_tools_for_context(transcript, None)

    def _apply_writing_tools_for_context(self, transcript: str, context: Optional[Dict[str, Any]]) -> str:
        if not transcript.strip():
            return transcript

        try:
            snapshot = self.writing_tools_store.get_runtime_tools()
        except Exception as exc:
            logger.warning("[Engine] Failed to load writing tools runtime cache: %s", exc)
            return transcript

        normalized_context = normalize_context(context or {})
        code_surface = derive_target_type(normalized_context) == "ide" or bool(normalized_context.get("code_file_name"))

        working = transcript
        if not code_surface:
            working = apply_dictionary_entries(working, snapshot.dictionary)
            working = apply_replacement_entries(working, snapshot.replacements)
            working = apply_snippet_entries(working, snapshot.snippets)
        else:
            exact_replacements = [entry for entry in snapshot.replacements if entry.enabled and entry.match_type == "exact"]
            exact_snippets = [entry for entry in snapshot.snippets if entry.enabled and entry.match_type == "exact"]
            working = apply_replacement_entries(working, exact_replacements)
            working = apply_snippet_entries(working, exact_snippets)
        return working.strip()

    def _build_stt_hints(self, domain_pack) -> Optional[STTHintPayload]:
        if domain_pack is None:
            return None

        terms: list[str] = []
        seen: set[str] = set()
        glossary_entries = sorted(
            domain_pack.glossary,
            key=lambda entry: (-entry.priority, entry.term.lower()),
        )
        for entry in glossary_entries:
            for candidate in [entry.term, *entry.aliases]:
                cleaned = " ".join(str(candidate).split()).strip()
                if not cleaned:
                    continue
                lowered = cleaned.lower()
                if lowered in seen:
                    continue
                seen.add(lowered)
                terms.append(cleaned)
                if len(terms) >= MAX_STT_HINT_KEYWORDS:
                    break
            if len(terms) >= MAX_STT_HINT_KEYWORDS:
                break

        if not terms:
            return None

        prompt = f"Prefer these domain terms when they appear in speech: {', '.join(terms)}"
        prompt = prompt[:MAX_STT_HINT_PROMPT_CHARS].rstrip(", ")
        return STTHintPayload(
            keywords=tuple(terms),
            prompt=prompt or None,
        )

    def _build_runtime_context(
        self,
        *,
        config: AppConfig,
        domain_pack,
        selection_text: Optional[str],
        selection_truncated: bool,
        clipboard_text: Optional[str],
        clipboard_truncated: bool,
    ) -> Dict[str, Any]:
        runtime_context = normalize_context(self.captured_context)
        sensitive_resolution = resolve_sensitive_targets(runtime_context, config.privacy)
        minimize_context = sensitive_resolution.minimize_context or bool(domain_pack and domain_pack.controls.minimize_context_capture)
        block_external = sensitive_resolution.block_external_text or bool(domain_pack and domain_pack.controls.suppress_external_text)

        if minimize_context:
            runtime_context = normalize_context(minimize_context_fields(runtime_context))

        external_policy = suppress_external_text(
            selection_text=selection_text,
            selection_truncated=selection_truncated,
            clipboard_text=clipboard_text,
            clipboard_truncated=clipboard_truncated,
            suppress=block_external,
        )

        runtime_context["sensitive_target_modes"] = [rule.mode for rule in sensitive_resolution.matched_rules]
        runtime_context["sensitive_rule_count"] = len(sensitive_resolution.matched_rules)

        return {
            "context": runtime_context,
            "selection_text": external_policy["selection_text"],
            "selection_truncated": external_policy["selection_truncated"],
            "clipboard_text": external_policy["clipboard_text"],
            "clipboard_truncated": external_policy["clipboard_truncated"],
        }

    def _should_log_sensitive_transcripts(self) -> bool:
        config = self.config_manager.get_config()
        return bool(getattr(config, "debug", None) and config.debug.log_sensitive_transcripts)

    def _should_persist_recordings(self) -> bool:
        config = self.config_manager.get_config()
        return bool(getattr(config, "debug", None) and config.debug.persist_recordings)

    def _persist_debug_copy(self, wav_path: str) -> Optional[str]:
        if not self._should_persist_recordings():
            return None

        recordings_dir = get_recordings_dir()

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        destination = recordings_dir / f"recording_{timestamp}.wav"
        shutil.copy2(wav_path, destination)
        safe_chmod(destination, 0o600)
        logger.info("[Engine] ✓ Saved debug WAV: %s", destination)
        return str(destination)

    def _resolve_domain_llm_override(
        self,
        *,
        config: AppConfig,
        domain_id: Optional[str],
        domain_pack: Optional[Any] = None,
    ) -> Optional[dict[str, str]]:
        if domain_id != "medical":
            return None

        styles = getattr(domain_pack, "styles", {}) if domain_pack is not None else {}
        preferred_provider = str(styles.get("preferred_llm_provider") or "lmstudio").strip().lower()
        if preferred_provider != "lmstudio":
            return None

        preferred_pattern = str(styles.get("preferred_llm_model_pattern") or MEDICAL_DOMAIN_MODEL_PATTERN).strip()
        model_id = (
            ModelDiscovery.resolve_lmstudio_model_by_pattern(preferred_pattern, require_loaded=True)
            or ModelDiscovery.resolve_lmstudio_model_by_pattern(preferred_pattern, require_loaded=False)
        )
        if not model_id:
            logger.warning(
                "[Engine] Medical domain was active but no LM Studio MedGemma model matched pattern %r. Falling back to %s/%s.",
                preferred_pattern,
                config.llm.provider,
                config.llm.model,
            )
            return None

        return {
            "provider": "lmstudio",
            "model": model_id,
        }

    def _rewrite_transcript(self, payload: RewriteContextPayload):
        self._set_phase("transforming")
        logger.info(
            "[Engine] Mode=SMART_TRANSFORM — routing transcript (requested skill: %s, resolved skill: %s)...",
            payload.skill_id,
            payload.resolved_skill_id or payload.skill_id,
        )
        config = self.config_manager.get_config()
        raw_context = payload.processing_context or self.captured_context or {}
        active_context = {
            **raw_context,
            **normalize_context(raw_context),
        }
        retrieval_context = {
            **active_context,
            "domain_id": payload.domain_id,
        }
        memory_context_block = ""
        if getattr(config, "memory", None) and config.memory.enabled:
            try:
                memory_context_block = self.memory_store.build_context_block(
                    transcript=payload.transcript,
                    context=retrieval_context,
                    semantic_retrieval_enabled=getattr(config.memory, "semantic_retrieval_enabled", True),
                )
            except Exception as exc:
                logger.warning("[Engine] Failed to build local memory context: %s", exc)
        domain_pack = self.domain_memory_store.get_runtime_pack(payload.domain_id) if payload.domain_id else None
        run_processor = self.smart_processor
        domain_llm_override = self._resolve_domain_llm_override(
            config=config,
            domain_id=payload.domain_id,
            domain_pack=domain_pack,
        )
        if domain_llm_override is not None:
            router_agent = None
            if config.llm.routing.enabled:
                router_agent = SmartRouterAgent(
                    provider=domain_llm_override["provider"],
                    model=domain_llm_override["model"],
                    temperature=config.llm.routing.temperature,
                )
            run_processor = SmartModeProcessor(
                provider=domain_llm_override["provider"],
                model=domain_llm_override["model"],
                temperature=config.llm.temperature,
                skill_manager=self.skill_manager,
                smart_router_agent=router_agent,
            )
            logger.info(
                "[Engine] Medical domain override active — Smart Mode will use %s/%s for this run.",
                domain_llm_override["provider"],
                domain_llm_override["model"],
            )
        preview_run_id = str(uuid4())
        preview_provider = str(
            getattr(run_processor, "provider", None)
            or (domain_llm_override or {}).get("provider")
            or config.llm.provider
        ).strip().lower()
        preview_smart_profile = "local_compact" if preview_provider == "lmstudio" else "default"
        preview_smart_profile_label = "Local Smart profile" if preview_smart_profile == "local_compact" else None
        self._emit_smart_preview(
            run_id=preview_run_id,
            state="started",
            smart_profile=preview_smart_profile,
            smart_profile_label=preview_smart_profile_label,
        )
        try:
            result = run_processor.process(
                payload.transcript,
                {
                    **active_context,
                    "context_quality": derive_context_quality(active_context, self.context_warning),
                    "target_type": derive_target_type(active_context),
                },
                payload.skill_id,
                preview_callback=lambda text: self._emit_smart_preview(
                    run_id=preview_run_id,
                    state="streaming",
                    text=text,
                    smart_profile=preview_smart_profile,
                    smart_profile_label=preview_smart_profile_label,
                ),
                experimental_media_controls_enabled=config.actions.experimental_media_controls,
                memory_context_block=memory_context_block or None,
                **payload.to_processor_kwargs(),
            )
        except Exception as exc:
            self._emit_smart_preview(
                run_id=preview_run_id,
                state="error",
                text=self._current_smart_preview_text(preview_run_id),
                error=str(exc),
                smart_profile=preview_smart_profile,
                smart_profile_label=preview_smart_profile_label,
            )
            raise
        self.last_smart_run = result.telemetry.model_dump(mode="json")

        if result.pending_action_review is not None:
            preview_text = result.pending_action_review.summary
            self._emit_smart_preview(
                run_id=preview_run_id,
                state="done",
                text=preview_text,
                final_text=preview_text,
                smart_profile=preview_smart_profile,
                smart_profile_label=preview_smart_profile_label,
            )
            logger.info("[Engine] ✓ Reviewed action prepared (%s).", result.pending_action_review.action_type)
            return result

        if result.auto_action is not None:
            preview_text = result.auto_action.summary
            self._emit_smart_preview(
                run_id=preview_run_id,
                state="done",
                text=preview_text,
                final_text=preview_text,
                smart_profile=preview_smart_profile,
                smart_profile_label=preview_smart_profile_label,
            )
            logger.info("[Engine] ✓ Auto action prepared (%s).", result.auto_action.action_type)
            return result

        if result.action_error:
            self._emit_smart_preview(
                run_id=preview_run_id,
                state="error",
                text=self._current_smart_preview_text(preview_run_id),
                error=result.action_error,
                smart_profile=preview_smart_profile,
                smart_profile_label=preview_smart_profile_label,
            )
            logger.warning("[Engine] Smart processor returned a transient action error: %s", result.action_error)
            return result

        if result.refusal_message:
            self._emit_smart_preview(
                run_id=preview_run_id,
                state="error",
                text=self._current_smart_preview_text(preview_run_id),
                error=result.refusal_message,
                smart_profile=preview_smart_profile,
                smart_profile_label=preview_smart_profile_label,
            )
            logger.warning("[Engine] Smart processor refused the request under the local compact profile: %s", result.refusal_message)
            return result

        if not result.final_text:
            logger.error("[Engine] ✗ Smart processor returned empty result.")
            self._emit_smart_preview(
                run_id=preview_run_id,
                state="error",
                text=self._current_smart_preview_text(preview_run_id),
                error="Smart Mode did not produce usable output.",
                smart_profile=preview_smart_profile,
                smart_profile_label=preview_smart_profile_label,
            )
            raise RuntimeError("Smart Mode did not produce usable output.")

        self._emit_smart_preview(
            run_id=preview_run_id,
            state="done",
            text=result.final_text,
            final_text=result.final_text,
            smart_profile=preview_smart_profile,
            smart_profile_label=preview_smart_profile_label,
        )

        if self._should_log_sensitive_transcripts():
            logger.info("[Engine] ✓ Smart Mode output: %r", result.final_text)
        else:
            logger.info(
                "[Engine] ✓ Smart Mode output prepared (%d chars) via %s/%s.",
                len(result.final_text),
                result.intent,
                result.lane,
            )

        return result

    def _prepare_context(
        self,
        mode: str,
        context: Optional[Dict[str, Any]],
        context_warning: Optional[str],
    ):
        normalized_context = normalize_context(context)
        has_context = any(
            [
                normalized_context.get("app_name") and normalized_context.get("app_name") != "Unknown",
                normalized_context.get("window_title"),
                normalized_context.get("page_title"),
                normalized_context.get("url_host"),
                normalized_context.get("url_path"),
            ]
        )
        if mode == "smart_transform":
            self.context_warning = context_warning
            self.captured_context = normalized_context
            self.captured_context_quality = derive_context_quality(self.captured_context, context_warning)
            self.target_type = derive_target_type(self.captured_context)
            self.captured_context_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            logger.info(
                "[Engine] Smart context captured. app=%r bundle=%r window=%r host=%r quality=%s target_type=%s",
                self.captured_context.get("app_name"),
                self.captured_context.get("bundle_id"),
                self.captured_context.get("window_title"),
                self.captured_context.get("url_host"),
                self.captured_context_quality,
                self.target_type,
            )
        else:
            self.context_warning = None
            self.captured_context = normalized_context
            self.captured_context_quality = derive_context_quality(self.captured_context)
            self.target_type = derive_target_type(self.captured_context)
            self.captured_context_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if has_context else None

    def start_processing(
        self,
        wav_path: str,
        mode: str = "dictation",
        context: Optional[Dict[str, Any]] = None,
        context_warning: Optional[str] = None,
        capture_stats: Optional[Dict[str, Any]] = None,
        capture_timeline: Optional[Dict[str, Any]] = None,
        selection_text: Optional[str] = None,
        selection_truncated: bool = False,
        clipboard_text: Optional[str] = None,
        clipboard_truncated: bool = False,
        screen_capture: Optional[Dict[str, Any]] = None,
        streaming_transcript: Optional[str] = None,
        streaming_source: Optional[str] = None,
    ):
        with self._processing_lock:
            if self._is_processing:
                raise RuntimeError("The backend is already processing another recording.")
            self._is_processing = True

        normalized_mode = mode if mode in {"dictation", "smart_transform"} else "dictation"
        if normalized_mode != mode:
            logger.warning("[Engine] Unsupported processing mode %r. Falling back to dictation.", mode)

        self._cancel_scheduled_action_error_clear()
        self._session_state = EngineSessionState()
        self._reset_pipeline_timings()
        self._apply_capture_timeline(capture_timeline)
        self._active_mode = normalized_mode
        self._prepare_context(normalized_mode, context, context_warning)
        self._emit_runtime_event("pending_paste")
        self._emit_runtime_event("notification")
        self._emit_runtime_event("status")

        logger.info("[Engine] ▶ Starting uploaded-audio processing — Mode: %s", normalized_mode.upper())
        threading.Thread(
            target=self._pipeline_task,
            args=(
                wav_path,
                normalized_mode,
                capture_stats or {},
                selection_text,
                selection_truncated,
                clipboard_text,
                clipboard_truncated,
                screen_capture,
                streaming_transcript,
                streaming_source,
            ),
            daemon=True,
        ).start()

    def _pipeline_task(
        self,
        wav_path: str,
        mode: str,
        capture_stats: Dict[str, Any],
        selection_text: Optional[str],
        selection_truncated: bool,
        clipboard_text: Optional[str],
        clipboard_truncated: bool,
        screen_capture: Optional[Dict[str, Any]] = None,
        streaming_transcript: Optional[str] = None,
        streaming_source: Optional[str] = None,
    ):
        import time

        pipeline_start = time.time()
        pipeline_started_at = time.perf_counter()
        transcription_started_at = time.perf_counter()
        stt_latency_ms: Optional[int] = None
        recording_duration_ms = int(capture_stats.get("duration_ms") or 0)
        try:
            config = self.config_manager.get_config()
            domain_selection = resolve_domain(context=self.captured_context, domains=config.domains)
            domain_pack = self.domain_memory_store.get_runtime_pack(domain_selection.domain_id) if domain_selection.domain_id else None
            runtime_inputs = self._build_runtime_context(
                config=config,
                domain_pack=domain_pack,
                selection_text=selection_text,
                selection_truncated=selection_truncated,
                clipboard_text=clipboard_text,
                clipboard_truncated=clipboard_truncated,
            )
            processing_context = runtime_inputs["context"]
            selection_text = runtime_inputs["selection_text"]
            selection_truncated = runtime_inputs["selection_truncated"]
            clipboard_text = runtime_inputs["clipboard_text"]
            clipboard_truncated = runtime_inputs["clipboard_truncated"]
            stt_hints = self._build_stt_hints(domain_pack)
            self._persist_debug_copy(wav_path)
            streaming_candidate = str(streaming_transcript or "").strip()
            if streaming_candidate:
                transcript = streaming_candidate
                stt_latency_ms = 0
                logger.info(
                    "[Engine] Using finalized live transcript from %s (%d chars).",
                    streaming_source or "live_session",
                    len(transcript),
                )
                if self.pipeline_timings.get("stt_done") is None:
                    self._mark_pipeline_timing("stt_done")
            else:
                self._set_phase("transcribing")
                logger.info("[Engine] Transcribing via %s/%s...", config.stt.provider, config.stt.model)
                try:
                    transcript = self.stt_client.transcribe(
                        wav_path,
                        model=config.stt.model,
                        language=self._resolve_stt_language(config),
                        hints=stt_hints,
                    )
                except STTTransientError as transient:
                    logger.error("[Engine] ✗ Transient STT failure: %s", transient)
                    self.last_error = f"Transcription failed: {transient}"
                    self._set_phase("error")
                    self._emit_runtime_event("status")
                    return
                stt_latency_ms = int((time.perf_counter() - transcription_started_at) * 1000)
                self._mark_pipeline_timing("stt_done")

            if not transcript:
                logger.error("[Engine] ✗ Transcription returned empty result.")
                self.last_error = "Transcription failed: Empty result."
                self._set_phase("error")
                return

            if self._should_log_sensitive_transcripts():
                logger.info("[Engine] ✓ Transcript ready in %d ms: %r", stt_latency_ms, transcript)
            else:
                logger.info("[Engine] ✓ Transcript ready (%d chars, %d ms).", len(transcript), stt_latency_ms)

            glossary_result = apply_glossary_corrections(transcript, domain_pack)
            if glossary_result.text and glossary_result.text != transcript:
                logger.info(
                    "[Engine] Applied %d domain glossary correction(s) for %s.",
                    len(glossary_result.hits),
                    domain_selection.domain_id,
                )
                transcript = glossary_result.text

            if mode == "smart_transform":
                command_result = apply_command_control("")
            elif self._uses_whisper_style_stt(config):
                command_result = apply_minimal_command_control(transcript, allow_format_contract=False)
                if command_result.text != transcript:
                    logger.info(
                        "[Engine] Applied minimal local formatting for whisper-style STT: %s",
                        ", ".join(command_result.operations),
                    )
                    transcript = command_result.text
            else:
                command_result = apply_command_control(transcript, allow_format_contract=False)
                if command_result.text != transcript:
                    logger.info("[Engine] Applied local command control operations: %s", ", ".join(command_result.operations))
                    transcript = command_result.text

            transformed_transcript = self._apply_writing_tools_for_context(transcript, processing_context)
            if transformed_transcript != transcript:
                logger.info("[Engine] Applied global writing tools to transcript.")
                transcript = transformed_transcript

            screen_context = ""
            if mode == "smart_transform" and screen_capture:
                effective_vision_config = self._build_effective_vision_config(config)
                screen_context = self.vision_agent.summarize_screen(
                    transcript=transcript,
                    screen_capture=screen_capture,
                    config=effective_vision_config,
                )
                if screen_context:
                    logger.info("[Engine] Added local vision screen context (%d chars).", len(screen_context))
                    processing_context = {
                        **processing_context,
                        "screen_context": screen_context,
                    }

            try:
                external_text = resolve_external_text(selection_text, clipboard_text)
                action_result = self.action_router.route(
                    transcript,
                    mode=mode,
                    external_text=external_text,
                    allow_note_capture=not bool(domain_selection.domain_id),
                )
                self._mark_pipeline_timing("route_done")

                if mode == "smart_transform" and action_result.action == ActionRoute.PASS_THROUGH:
                    action_result = action_result.model_copy(update={
                        "action": ActionRoute.TRANSFORM_THEN_PASTE,
                    })

                if action_result.action == ActionRoute.SAVE_NOTE:
                    note_text = action_result.note_text
                    source_kind = action_result.note_source or InboxSourceKind.SPOKEN_TEXT
                    if action_result.requires_external_text:
                        if external_text.source.value == "none" or not external_text.text:
                            note_text = (note_text or action_result.transcript_for_transform or transcript).strip()
                            source_kind = InboxSourceKind.SPOKEN_TEXT
                            logger.info("[Engine] No external text was available for inbox capture. Falling back to spoken transcript.")
                        else:
                            note_text = external_text.text
                            source_kind = infer_inbox_source_kind(external_text.source)
                    if not note_text:
                        raise ValueError("Inbox note was empty after parsing the command. Speak the note text or select text first.")
                    self._save_inbox_note(note_text, mode=mode, source_kind=source_kind)
                    self._record_usage_success(
                        mode=mode,
                        output_text=note_text,
                        stt_latency_ms=stt_latency_ms,
                        recording_duration_ms=recording_duration_ms,
                        pipeline_duration_ms=int((time.perf_counter() - pipeline_started_at) * 1000),
                    )
                    self._record_history_success(
                        mode=mode,
                        transcript=transcript,
                        final_output=note_text,
                        telemetry=self.last_smart_run,
                        context_snapshot=processing_context,
                        config=config,
                    )
                    self._mark_pipeline_timing("transform_done")
                    return
            except ValueError as exc:
                self.last_error = str(exc)
                self._set_phase("error")
                logger.warning("[Engine] Inbox interception failed: %s", exc)
                return

            if mode == "dictation":
                logger.info("[Engine] Mode=DICTATION — storing raw transcript for pasting.")
                final_text = transcript
                final_text, _ = enforce_surface_contract(final_text, processing_context)
            else:
                domain_intent_resolution = resolve_domain_intent(
                    domain_pack=domain_pack,
                    transcript=action_result.transcript_for_transform or transcript,
                    context={
                        **processing_context,
                        "target_type": derive_target_type(processing_context),
                    },
                )
                skill_router_agent = self.smart_processor.smart_router_agent
                allow_skill_router_model = not (
                    config.llm.provider.lower() == "lmstudio"
                    and skill_router_agent is not None
                    and skill_router_agent.provider.lower() != "lmstudio"
                )
                selected_skill = resolve_active_skill_selection(
                    context=processing_context,
                    hotkeys=config.hotkeys,
                    skill_manager=self.skill_manager,
                    transcript=action_result.transcript_for_transform or transcript,
                    domain_id=domain_selection.domain_id,
                    domain_skill_id=domain_intent_resolution.preferred_skill_id,
                    smart_router_agent=skill_router_agent,
                    allow_model_routing=allow_skill_router_model,
                )
                requested_skill_id = selected_skill.requested_skill_id
                selected_skill_id = selected_skill.skill_id
                if selected_skill.source == "domain_forced":
                    logger.info(
                        "[Engine] Domain %s forced skill %s for intent %s.",
                        domain_selection.domain_id,
                        selected_skill_id,
                        domain_intent_resolution.domain_intent,
                    )
                elif selected_skill.source == "app_override":
                    logger.info(
                        "[Engine] Using app override %r (%s) -> skill %s.",
                        selected_skill.app_override_label,
                        selected_skill.app_override_id,
                        selected_skill.skill_id,
                    )
                elif selected_skill.source == "system_rule":
                    logger.info(
                        "[Engine] Using starter rule %r (%s) -> skill %s.",
                        selected_skill.app_override_label,
                        selected_skill.app_override_id,
                        selected_skill.skill_id,
                    )
                if selected_skill.auto_selected_skill_id:
                    logger.info(
                        "[Engine] Auto-selected Smart skill %s from requested %s via %s skill router. reason=%s",
                        selected_skill.auto_selected_skill_id,
                        requested_skill_id,
                        selected_skill.skill_router_resolver,
                        selected_skill.auto_selected_skill_reason or "none",
                    )
                if selected_skill.suppressed_requested_skill_source:
                    logger.info(
                        "[Engine] Active domain %s bypassed %s route %r (%s).",
                        domain_selection.domain_id,
                        selected_skill.suppressed_requested_skill_source,
                        selected_skill.suppressed_requested_app_override_label,
                        selected_skill.suppressed_requested_app_override_id,
                    )

                domain_context = build_domain_retrieval_block(
                    domain_pack=domain_pack,
                    domain_intent=domain_intent_resolution.domain_intent if domain_pack else None,
                    glossary_hits=glossary_result.hits,
                )
                rewrite_context = {
                    **processing_context,
                    "domain_default_format": domain_pack.controls.default_format if domain_pack else "auto",
                    "domain_default_surface_behavior": domain_pack.controls.default_surface_behavior if domain_pack else "auto",
                    "domain_tone": domain_pack.controls.tone if domain_pack else None,
                    "domain_audience": domain_pack.controls.audience if domain_pack else None,
                    "code_format_hint": command_result.code_format_hint,
                }
                smart_result = self._rewrite_transcript(
                    RewriteContextPayload(
                        transcript=action_result.transcript_for_transform or transcript,
                        skill_id=requested_skill_id,
                        resolved_skill_id=selected_skill_id,
                        processing_context=rewrite_context,
                        stt_latency_ms=stt_latency_ms,
                        requested_skill_source=selected_skill.source,
                        requested_app_override_id=selected_skill.app_override_id,
                        requested_app_override_label=selected_skill.app_override_label,
                        domain_skill_id=selected_skill.domain_skill_id,
                        note_routing_suppressed=action_result.note_routing_suppressed,
                        suppressed_requested_skill_source=selected_skill.suppressed_requested_skill_source,
                        suppressed_requested_app_override_id=selected_skill.suppressed_requested_app_override_id,
                        suppressed_requested_app_override_label=selected_skill.suppressed_requested_app_override_label,
                        selection_text=selection_text,
                        selection_truncated=selection_truncated,
                        clipboard_text=clipboard_text,
                        clipboard_truncated=clipboard_truncated,
                        action_route=action_result.action.value,
                        action_resolver=action_result.resolver,
                        force_external_context=action_result.requires_external_text,
                        domain_id=domain_selection.domain_id,
                        domain_source=domain_selection.source,
                        domain_rule_id=domain_selection.rule_id,
                        domain_rule_label=domain_selection.rule_label,
                        domain_intent=domain_intent_resolution.domain_intent if domain_pack else None,
                        domain_template_id=domain_context.template_id,
                        domain_example_id=domain_context.example_id,
                        domain_glossary_hits=domain_context.glossary_hits,
                        domain_context_block=domain_context.block,
                        command_operations_applied=command_result.operations,
                        format_contract=command_result.format_contract,
                        code_format_hint=command_result.code_format_hint,
                        actions_enabled=config.actions.enabled,
                        skill_router_resolver=selected_skill.skill_router_resolver,
                        skill_router_model_attempted=selected_skill.skill_router_model_attempted,
                        skill_router_model_error=selected_skill.skill_router_model_error,
                        skill_router_provider=selected_skill.skill_router_provider,
                        skill_router_model=selected_skill.skill_router_model,
                        auto_selected_skill_id=selected_skill.auto_selected_skill_id,
                        auto_selected_skill_name=selected_skill.auto_selected_skill_name,
                        auto_selected_skill_reason=selected_skill.auto_selected_skill_reason,
                    )
                )
                if smart_result.pending_action_review is not None:
                    if config.actions.auto_approve_reviewed:
                        try:
                            self._execute_reviewed_action_from_payload(smart_result.pending_action_review)
                        except RuntimeError as exc:
                            logger.warning(
                                "[Engine] Auto-approved reviewed action failed type=%s error=%s",
                                smart_result.pending_action_review.action_type,
                                str(exc).strip() or exc,
                            )
                        else:
                            self._record_usage_success(
                                mode=mode,
                                output_text=smart_result.pending_action_review.summary,
                                stt_latency_ms=stt_latency_ms,
                                recording_duration_ms=recording_duration_ms,
                                pipeline_duration_ms=int((time.perf_counter() - pipeline_started_at) * 1000),
                            )
                            self._record_history_success(
                                mode=mode,
                                transcript=transcript,
                                final_output=smart_result.pending_action_review.summary,
                                telemetry=self.last_smart_run,
                                context_snapshot=processing_context,
                                config=config,
                            )
                            self._mark_pipeline_timing("transform_done")
                        return
                    else:
                        self.pending_action_review = smart_result.pending_action_review.model_dump(mode="json")
                        self._mark_pipeline_timing("transform_done")
                        self._emit_runtime_event("pending_action_review")
                        self._emit_runtime_event("status")
                    return
                if smart_result.local_task_request is not None:
                    self.create_local_task_run(
                        request_text=smart_result.local_task_request.request_text,
                        command=smart_result.local_task_request.command,
                        cwd=smart_result.local_task_request.cwd,
                        title=smart_result.local_task_request.title or "Local task",
                        source_intent=smart_result.local_task_request.source_intent,
                        run_kind=smart_result.local_task_request.run_kind,
                        plan_summary=smart_result.local_task_request.plan_summary,
                        steps=smart_result.local_task_request.steps,
                    )
                    self._mark_pipeline_timing("transform_done")
                    return
                if smart_result.action_error:
                    logger.warning(
                        "[Engine] Smart action resolution failed kind=%s error=%s",
                        smart_result.action_error_kind or "resolution",
                        smart_result.action_error,
                    )
                    self._complete_transient_action_error(smart_result.action_error)
                    return
                if smart_result.refusal_message:
                    logger.warning(
                        "[Engine] Smart request refused under profile=%s reason=%s",
                        (self.last_smart_run or {}).get("smart_profile"),
                        smart_result.refusal_message,
                    )
                    self._complete_transient_smart_error(smart_result.refusal_message)
                    return
                if smart_result.auto_action is not None:
                    try:
                        execute_auto_action(smart_result.auto_action)
                    except Exception as exc:
                        detail = str(exc).strip() or "The requested UI action could not be completed."
                        logger.warning(
                            "[Engine] Auto action failed type=%s target=%s error=%s",
                            smart_result.auto_action.action_type,
                            smart_result.auto_action.target_label,
                            detail,
                        )
                        self._complete_transient_action_error(detail)
                        return

                    action_summary = smart_result.auto_action.summary
                    logger.info(
                        "[Engine] ✓ Auto action completed type=%s target=%s.",
                        smart_result.auto_action.action_type,
                        smart_result.auto_action.target_label,
                    )
                    self._record_usage_success(
                        mode=mode,
                        output_text=action_summary,
                        stt_latency_ms=stt_latency_ms,
                        recording_duration_ms=recording_duration_ms,
                        pipeline_duration_ms=int((time.perf_counter() - pipeline_started_at) * 1000),
                    )
                    self._record_history_success(
                        mode=mode,
                        transcript=transcript,
                        final_output=action_summary,
                        telemetry=self.last_smart_run,
                        context_snapshot=processing_context,
                        config=config,
                    )
                    self._mark_pipeline_timing("transform_done")
                    self._complete_with_notification(
                        title=smart_result.auto_action.title,
                        body=action_summary,
                    )
                    return
                final_text = smart_result.final_text
                if self.last_smart_run is not None:
                    logger.info(
                        "[Engine] Stage timings — STT=%s ms, planner=%s ms, LLM=%s ms, total=%s ms.",
                        self.last_smart_run.get("stt_latency_ms"),
                        self.last_smart_run.get("planner_latency_ms"),
                        self.last_smart_run.get("llm_latency_ms"),
                        self.last_smart_run.get("total_latency_ms"),
                    )

            if mode == "smart_transform" and action_result.action == ActionRoute.TRANSFORM_THEN_SAVE_NOTE:
                self._save_inbox_note(
                    final_text,
                    mode=mode,
                    source_kind=InboxSourceKind.TRANSFORMED_OUTPUT,
                    output_mode=self.last_smart_run.get("output_mode") if self.last_smart_run else None,
                )
                self._record_usage_success(
                    mode=mode,
                    output_text=final_text,
                    stt_latency_ms=stt_latency_ms,
                    recording_duration_ms=recording_duration_ms,
                    pipeline_duration_ms=int((time.perf_counter() - pipeline_started_at) * 1000),
                )
                self._record_history_success(
                    mode=mode,
                    transcript=transcript,
                    final_output=final_text,
                    telemetry=self.last_smart_run,
                    context_snapshot=processing_context,
                    config=config,
                )
                self._mark_pipeline_timing("transform_done")
                return

            if final_text:
                if not final_text.strip():
                    logger.error("[Engine] ✗ Final output was whitespace-only. Refusing to create pending paste.")
                    raise RuntimeError("The generated output was empty after formatting. Retry or adjust the active mode.")
                self.pending_paste = {
                    "id": str(uuid4()),
                    "text": final_text,
                }
                self.pending_paste_text = final_text
                self._set_phase("preparing_paste")
                self._mark_pipeline_timing("transform_done")
                self._emit_runtime_event("pending_paste")
                self._emit_runtime_event("status")
                self._record_usage_success(
                    mode=mode,
                    output_text=final_text,
                    stt_latency_ms=stt_latency_ms,
                    recording_duration_ms=recording_duration_ms,
                    pipeline_duration_ms=int((time.perf_counter() - pipeline_started_at) * 1000),
                )
                self._record_history_success(
                    mode=mode,
                    transcript=transcript,
                    final_output=final_text,
                    telemetry=self.last_smart_run,
                    context_snapshot=processing_context,
                    config=config,
                )
                logger.info(
                    "[Engine] ✓ Pending paste prepared (id=%s, chars=%d).",
                    self.pending_paste["id"],
                    len(final_text),
                )

        except Exception as exc:
            logger.error("[Engine] ✗ Pipeline error: %s", exc, exc_info=True)
            self.last_error = f"Pipeline Error: {str(exc)}"
            self._set_phase("error")
            self._emit_runtime_event("status")
        finally:
            try:
                if wav_path:
                    Path(wav_path).unlink(missing_ok=True)
            except Exception as exc:
                logger.warning("[Engine] Failed to clean up uploaded audio %s: %s", wav_path, exc)

            elapsed = time.time() - pipeline_start
            self._is_processing = False
            self._active_mode = None
            self._settle_phase_after_processing()
            logger.info("[Engine] ✓ Pipeline complete in %.2fs. Ready for next request.", elapsed)

    def process_test_audio(self, wav_path: str) -> dict[str, Any]:
        import time

        start_time = time.time()
        debug_copy: Optional[str] = None
        try:
            config = self.config_manager.get_config()
            debug_copy = self._persist_debug_copy(wav_path)
            logger.info("[Debug STT] Processing uploaded mic test via %s/%s", config.stt.provider, config.stt.model)
            transcript = self.stt_client.transcribe(
                wav_path,
                model=config.stt.model,
                language=self._resolve_stt_language(config),
            )
            if transcript:
                logger.info("[Debug STT] Transcript ready (%d chars).", len(transcript))
            return {
                "status": "success",
                "transcript": transcript or "",
                "audio_file": debug_copy,
                "processing_time": round(time.time() - start_time, 2),
            }
        except STTTransientError as transient:
            logger.error("[Debug STT] Transient voice preview failure: %s", transient)
            return {
                "status": "error",
                "message": str(transient),
                "audio_file": debug_copy,
                "processing_time": round(time.time() - start_time, 2),
            }
        except Exception as exc:
            logger.error("[Debug STT] Voice preview failed: %s", exc)
            return {
                "status": "error",
                "message": str(exc),
                "audio_file": debug_copy,
                "processing_time": round(time.time() - start_time, 2),
            }
        finally:
            try:
                Path(wav_path).unlink(missing_ok=True)
            except Exception as exc:
                logger.warning("[Engine] Failed to clean up mic test audio %s: %s", wav_path, exc)

    def clear_pending_paste(self):
        self._cancel_scheduled_action_error_clear()
        self.pending_paste = None
        self.pending_paste_text = None
        self.pending_notification = None
        self.pending_action_review = None
        self.last_error = None
        self._mark_pipeline_timing("paste_ack_done")
        if not self._is_processing:
            self._set_phase("ready")
        else:
            self._emit_runtime_event("status")
        self._emit_runtime_event("pending_paste")
        self._emit_runtime_event("notification")

    def acknowledge_pending_paste(self, paste_id: str) -> bool:
        if not self.pending_paste:
            return False
        if self.pending_paste.get("id") != paste_id:
            return False
        self.pending_paste = None
        self.pending_paste_text = None
        self.pending_action_review = None
        self._mark_pipeline_timing("paste_ack_done")
        if not self._is_processing:
            self._set_phase("ready")
        else:
            self._emit_runtime_event("status")
        self._emit_runtime_event("pending_paste")
        return True

    def reject_pending_action_review(self, run_id: str) -> bool:
        current = self.pending_action_review
        if not current or current.get("run_id") != run_id:
            return False
        self._cancel_scheduled_action_error_clear()
        was_error = current.get("status") == "error"
        self.pending_action_review = None
        if was_error and self.last_error:
            self.last_error = None
        if not was_error:
            self.pending_notification = {
                "title": "Action dismissed",
                "body": None,
            }
        self._set_phase("ready")
        self._emit_runtime_event("pending_action_review")
        if not was_error:
            self._emit_runtime_event("notification")
        self._emit_runtime_event("status")
        return True

    def approve_pending_action_review(self, run_id: str) -> dict[str, Any]:
        current = self.pending_action_review
        if not current or current.get("run_id") != run_id:
            raise RuntimeError("The reviewed action no longer matches the current backend state.")

        review = PendingActionReview.model_validate(current)
        self._execute_reviewed_action_from_payload(review, update_pending_state=True)
        return {
            "status": "approved",
            "run_id": run_id,
            "action_type": review.action_type,
        }

    def _execute_reviewed_action_from_payload(
        self,
        review_payload: PendingActionReview,
        *,
        update_pending_state: bool = False,
    ) -> None:
        review = PendingActionReview.model_validate(review_payload.model_dump(mode="json"))
        if not self.config_manager.get_config().actions.enabled:
            detail = "Desktop actions are disabled in Advanced settings."
            review.status = "error"
            review.error = detail
            if update_pending_state:
                self.pending_action_review = review.model_dump(mode="json")
                self._emit_runtime_event("pending_action_review")
            self.last_error = detail
            self._set_phase("error")
            self._emit_runtime_event("status")
            self._schedule_action_error_clear(review_run_id=review.run_id if update_pending_state else None, error_message=detail)
            raise RuntimeError(detail)

        validation_error = validate_reviewed_action(review)
        if validation_error:
            review.status = "error"
            review.error = validation_error
            if update_pending_state:
                self.pending_action_review = review.model_dump(mode="json")
                self._emit_runtime_event("pending_action_review")
            self.last_error = validation_error
            self._set_phase("error")
            self._emit_runtime_event("status")
            self._schedule_action_error_clear(review_run_id=review.run_id if update_pending_state else None, error_message=validation_error)
            raise RuntimeError(validation_error)

        try:
            execute_reviewed_action(review)
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
            review.status = "error"
            review.error = detail
            if update_pending_state:
                self.pending_action_review = review.model_dump(mode="json")
                self._emit_runtime_event("pending_action_review")
            self.last_error = detail
            self._set_phase("error")
            self._emit_runtime_event("status")
            self._schedule_action_error_clear(review_run_id=review.run_id if update_pending_state else None, error_message=detail)
            raise RuntimeError(detail) from exc

        self._cancel_scheduled_action_error_clear()
        if update_pending_state:
            self.pending_action_review = None
            self._emit_runtime_event("pending_action_review")
        self.pending_notification = {
            "title": review.title,
            "body": "Desktop action completed.",
        }
        self._set_phase("ready")
        self._emit_runtime_event("notification")
        self._emit_runtime_event("status")

    def _save_inbox_note(self, text: str, *, mode: str, source_kind: InboxSourceKind, output_mode: Optional[str] = None):
        note = build_inbox_note(
            text,
            context=self.captured_context,
            source_mode=mode,
            source_kind=source_kind.value,
            output_mode=output_mode,
        )
        self.inbox_store.append_note(note)
        self.pending_notification = {
            "title": "Saved to Inbox",
            "body": None,
        }
        self._set_phase("preparing_paste")
        self._emit_runtime_event("inbox_invalidated")
        self._emit_runtime_event("notification")
        self._emit_runtime_event("status")
        logger.info("[Engine] Saved transcript to inbox (%s).", note.id)

    def shutdown(self):
        logger.info("[Engine] Shutting down orchestrator...")
        self.local_task_shell.shutdown()
        close_client = getattr(self.stt_client, "close", None)
        if callable(close_client):
            close_client()

    def reprocess_history_item(self, item_id: int, *, skill_id: Optional[str] = None) -> HistoryItem:
        with self._processing_lock:
            if self._is_processing:
                raise RuntimeError("The local engine is busy. Finish the current request before reprocessing history.")
            self._is_processing = True

        try:
            history_item = self.writing_tools_store.get_history_item(item_id)
        except Exception:
            with self._processing_lock:
                self._is_processing = False
            raise
        if history_item is None:
            with self._processing_lock:
                self._is_processing = False
            raise RuntimeError("The selected history item no longer exists.")

        previous_session_state = self._session_state.clone()

        try:
            self._session_state = EngineSessionState()
            self._active_mode = history_item.mode
            self._set_phase("transforming")

            config = self.config_manager.get_config()
            processing_context = normalize_context(history_item.context)
            transcript = history_item.transcript.strip()
            domain_selection = resolve_domain(context=processing_context, domains=config.domains)
            domain_pack = self.domain_memory_store.get_runtime_pack(domain_selection.domain_id) if domain_selection.domain_id else None
            glossary_result = apply_glossary_corrections(transcript, domain_pack)
            transcript = glossary_result.text

            final_mode = "smart_transform" if skill_id else history_item.mode
            self._active_mode = final_mode

            if final_mode == "dictation":
                final_text = transcript
                telemetry = history_item.telemetry
            else:
                domain_intent_resolution = resolve_domain_intent(
                    domain_pack=domain_pack,
                    transcript=transcript,
                    context={
                        **processing_context,
                        "target_type": derive_target_type(processing_context),
                    },
                )
                if skill_id:
                    requested_skill = self.skill_manager.get_skill(skill_id)
                    if requested_skill is None:
                        raise RuntimeError("The selected skill is no longer available.")
                    selected_skill_id = requested_skill.id
                    selected_skill_source = "history_override"
                    selected_app_override_id = None
                    selected_app_override_label = None
                    selected_domain_skill_id = requested_skill.id if requested_skill.id.startswith("system_domain_") else None
                    suppressed_skill_source = None
                    suppressed_app_override_id = None
                    suppressed_app_override_label = None
                else:
                    skill_router_agent = self.smart_processor.smart_router_agent
                    allow_skill_router_model = not (
                        config.llm.provider.lower() == "lmstudio"
                        and skill_router_agent is not None
                        and skill_router_agent.provider.lower() != "lmstudio"
                    )
                    selected_skill = resolve_active_skill_selection(
                        context=processing_context,
                        hotkeys=config.hotkeys,
                        skill_manager=self.skill_manager,
                        transcript=transcript,
                        domain_id=domain_selection.domain_id,
                        domain_skill_id=domain_intent_resolution.preferred_skill_id,
                        smart_router_agent=skill_router_agent,
                        allow_model_routing=allow_skill_router_model,
                    )
                    selected_skill_id = selected_skill.skill_id
                    requested_skill_id = selected_skill.requested_skill_id
                    selected_skill_source = selected_skill.source
                    selected_app_override_id = selected_skill.app_override_id
                    selected_app_override_label = selected_skill.app_override_label
                    selected_domain_skill_id = selected_skill.domain_skill_id
                    suppressed_skill_source = selected_skill.suppressed_requested_skill_source
                    suppressed_app_override_id = selected_skill.suppressed_requested_app_override_id
                    suppressed_app_override_label = selected_skill.suppressed_requested_app_override_label
                    skill_router_resolver = selected_skill.skill_router_resolver
                    skill_router_model_attempted = selected_skill.skill_router_model_attempted
                    skill_router_model_error = selected_skill.skill_router_model_error
                    skill_router_provider = selected_skill.skill_router_provider
                    skill_router_model = selected_skill.skill_router_model
                    auto_selected_skill_id = selected_skill.auto_selected_skill_id
                    auto_selected_skill_name = selected_skill.auto_selected_skill_name
                    auto_selected_skill_reason = selected_skill.auto_selected_skill_reason

                domain_context = build_domain_retrieval_block(
                    domain_pack=domain_pack,
                    domain_intent=domain_intent_resolution.domain_intent if domain_pack else None,
                    glossary_hits=glossary_result.hits,
                )
                rewrite_context = {
                    **processing_context,
                    "domain_default_format": domain_pack.controls.default_format if domain_pack else "auto",
                    "domain_default_surface_behavior": domain_pack.controls.default_surface_behavior if domain_pack else "auto",
                    "domain_tone": domain_pack.controls.tone if domain_pack else None,
                    "domain_audience": domain_pack.controls.audience if domain_pack else None,
                }
                smart_result = self._rewrite_transcript(
                    RewriteContextPayload(
                        transcript=transcript,
                        skill_id=(requested_skill_id if not skill_id else selected_skill_id),
                        resolved_skill_id=selected_skill_id,
                        processing_context=rewrite_context,
                        requested_skill_source=selected_skill_source,
                        requested_app_override_id=selected_app_override_id,
                        requested_app_override_label=selected_app_override_label,
                        domain_skill_id=selected_domain_skill_id,
                        note_routing_suppressed=bool(domain_selection.domain_id),
                        suppressed_requested_skill_source=suppressed_skill_source,
                        suppressed_requested_app_override_id=suppressed_app_override_id,
                        suppressed_requested_app_override_label=suppressed_app_override_label,
                        action_route=ActionRoute.TRANSFORM_THEN_PASTE.value,
                        action_resolver="none",
                        domain_id=domain_selection.domain_id,
                        domain_source=domain_selection.source,
                        domain_rule_id=domain_selection.rule_id,
                        domain_rule_label=domain_selection.rule_label,
                        domain_intent=domain_intent_resolution.domain_intent if domain_pack else None,
                        domain_template_id=domain_context.template_id,
                        domain_example_id=domain_context.example_id,
                        domain_glossary_hits=domain_context.glossary_hits,
                        domain_context_block=domain_context.block,
                        skill_router_resolver=(skill_router_resolver if not skill_id else "none"),
                        skill_router_model_attempted=(skill_router_model_attempted if not skill_id else False),
                        skill_router_model_error=(skill_router_model_error if not skill_id else None),
                        skill_router_provider=(skill_router_provider if not skill_id else None),
                        skill_router_model=(skill_router_model if not skill_id else None),
                        auto_selected_skill_id=(auto_selected_skill_id if not skill_id else None),
                        auto_selected_skill_name=(auto_selected_skill_name if not skill_id else None),
                        auto_selected_skill_reason=(auto_selected_skill_reason if not skill_id else None),
                    )
                )
                if smart_result.pending_action_review is not None:
                    raise RuntimeError("History reprocessing does not support reviewed desktop actions.")
                if smart_result.auto_action is not None:
                    raise RuntimeError("History reprocessing does not support UI automation actions.")
                final_text = smart_result.final_text
                telemetry = dict(self.last_smart_run or {})

            return self._record_history_entry(
                mode=final_mode,
                transcript=transcript,
                final_output=final_text,
                telemetry=telemetry or {},
                context=processing_context,
                stt_provider=config.stt.provider,
                stt_model=config.stt.model,
                llm_provider=(telemetry or {}).get("provider") or (config.llm.provider if final_mode == "smart_transform" else None),
                llm_model=(telemetry or {}).get("model") or (config.llm.model if final_mode == "smart_transform" else None),
            )
        finally:
            self._session_state = previous_session_state
            self._emit_runtime_event("status")
            with self._processing_lock:
                self._is_processing = False
