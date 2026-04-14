from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from context_profile import normalize_context
from utils.logger import get_logger

logger = get_logger()


def blank_pipeline_timings() -> dict[str, Optional[str]]:
    return {
        "button_down": None,
        "capture_started": None,
        "first_partial": None,
        "stop_pressed": None,
        "record_start": None,
        "stt_done": None,
        "route_done": None,
        "transform_done": None,
        "paste_ack_done": None,
    }


@dataclass
class EngineSessionState:
    phase: str = "ready"
    active_mode: Optional[str] = None
    last_error: Optional[str] = None
    pending_paste: Optional[dict[str, Any]] = None
    pending_paste_text: Optional[str] = None
    pending_notification: Optional[dict[str, Optional[str]]] = None
    context_warning: Optional[str] = None
    captured_context: dict[str, Any] = field(default_factory=normalize_context)
    captured_context_at: Optional[str] = None
    captured_context_quality: str = "empty"
    target_type: Optional[str] = None
    last_smart_run: Optional[dict[str, Any]] = None
    smart_preview: Optional[dict[str, Any]] = None
    pending_action_review: Optional[dict[str, Any]] = None
    pipeline_timings: dict[str, Optional[str]] = field(default_factory=blank_pipeline_timings)

    def clone(self) -> "EngineSessionState":
        return deepcopy(self)


@dataclass(frozen=True)
class RewriteContextPayload:
    transcript: str
    skill_id: str
    resolved_skill_id: Optional[str] = None
    processing_context: Optional[dict[str, Any]] = None
    stt_latency_ms: Optional[int] = None
    requested_skill_source: str = "global_default"
    requested_app_override_id: Optional[str] = None
    requested_app_override_label: Optional[str] = None
    domain_skill_id: Optional[str] = None
    note_routing_suppressed: bool = False
    suppressed_requested_skill_source: Optional[str] = None
    suppressed_requested_app_override_id: Optional[str] = None
    suppressed_requested_app_override_label: Optional[str] = None
    selection_text: Optional[str] = None
    selection_truncated: bool = False
    clipboard_text: Optional[str] = None
    clipboard_truncated: bool = False
    action_route: str = "transform_then_paste"
    action_resolver: str = "none"
    force_external_context: bool = False
    domain_id: Optional[str] = None
    domain_source: str = "none"
    domain_rule_id: Optional[str] = None
    domain_rule_label: Optional[str] = None
    domain_intent: Optional[str] = None
    domain_template_id: Optional[str] = None
    domain_example_id: Optional[str] = None
    domain_glossary_hits: Optional[list[str]] = None
    domain_context_block: Optional[str] = None
    command_operations_applied: Optional[list[str]] = None
    format_contract: Optional[str] = None
    code_format_hint: Optional[str] = None
    actions_enabled: bool = True
    skill_router_resolver: str = "none"
    skill_router_model_attempted: bool = False
    skill_router_model_error: Optional[str] = None
    skill_router_provider: Optional[str] = None
    skill_router_model: Optional[str] = None
    auto_selected_skill_id: Optional[str] = None
    auto_selected_skill_name: Optional[str] = None
    auto_selected_skill_reason: Optional[str] = None

    def to_processor_kwargs(self) -> dict[str, Any]:
        return {
            "resolved_skill_id": self.resolved_skill_id,
            "stt_latency_ms": self.stt_latency_ms,
            "requested_skill_source": self.requested_skill_source,
            "requested_app_override_id": self.requested_app_override_id,
            "requested_app_override_label": self.requested_app_override_label,
            "domain_skill_id": self.domain_skill_id,
            "note_routing_suppressed": self.note_routing_suppressed,
            "suppressed_requested_skill_source": self.suppressed_requested_skill_source,
            "suppressed_requested_app_override_id": self.suppressed_requested_app_override_id,
            "suppressed_requested_app_override_label": self.suppressed_requested_app_override_label,
            "selection_text": self.selection_text,
            "selection_truncated": self.selection_truncated,
            "clipboard_text": self.clipboard_text,
            "clipboard_truncated": self.clipboard_truncated,
            "action_route": self.action_route,
            "action_resolver": self.action_resolver,
            "force_external_context": self.force_external_context,
            "domain_id": self.domain_id,
            "domain_source": self.domain_source,
            "domain_rule_id": self.domain_rule_id,
            "domain_rule_label": self.domain_rule_label,
            "domain_intent": self.domain_intent,
            "domain_template_id": self.domain_template_id,
            "domain_example_id": self.domain_example_id,
            "domain_glossary_hits": self.domain_glossary_hits,
            "domain_context_block": self.domain_context_block,
            "command_operations_applied": self.command_operations_applied,
            "format_contract": self.format_contract,
            "code_format_hint": self.code_format_hint,
            "actions_enabled": self.actions_enabled,
            "skill_router_resolver": self.skill_router_resolver,
            "skill_router_model_attempted": self.skill_router_model_attempted,
            "skill_router_model_error": self.skill_router_model_error,
            "skill_router_provider": self.skill_router_provider,
            "skill_router_model": self.skill_router_model,
            "auto_selected_skill_id": self.auto_selected_skill_id,
            "auto_selected_skill_name": self.auto_selected_skill_name,
            "auto_selected_skill_reason": self.auto_selected_skill_reason,
        }


class EngineRuntimeCoordinator:
    def __init__(
        self,
        runtime_event_emitter: Optional[Callable[[str, Optional[dict[str, Any]]], None]] = None,
    ) -> None:
        self.state = EngineSessionState()
        self._runtime_event_emitter = runtime_event_emitter

    @property
    def phase(self) -> str:
        return self.state.phase

    @phase.setter
    def phase(self, value: str) -> None:
        self.state.phase = value

    def phase_label(self) -> str:
        if self.phase == "transforming":
            app_name = self.state.captured_context.get("app_name") or "Unknown"
            url_host = self.state.captured_context.get("url_host")
            if url_host:
                return f"Transforming for {app_name} • {url_host}"
            if app_name and app_name != "Unknown":
                return f"Transforming for {app_name}"

        labels = {
            "booting_backend": "Booting backend",
            "ready": "Ready",
            "transcribing": "Transcribing speech",
            "transforming": "Transforming transcript",
            "preparing_paste": "Preparing paste",
            "error": "Attention needed",
        }
        return labels.get(self.phase, "Ready")

    def set_phase(self, phase: str) -> None:
        if self.phase == phase:
            return
        self.phase = phase
        self.emit_runtime_event("status")

    def has_pending_delivery(self) -> bool:
        return bool(
            self.state.pending_paste
            or self.state.pending_notification
            or self.state.pending_action_review
        )

    def reconcile_runtime_state(self, *, is_processing: bool) -> bool:
        if self.phase == "preparing_paste" and not is_processing and not self.has_pending_delivery():
            self.phase = "ready"
            return True
        return False

    def settle_phase_after_processing(self, *, is_processing: bool) -> None:
        if self.phase == "error":
            self.emit_runtime_event("status")
            return

        if self.phase == "preparing_paste" and self.has_pending_delivery():
            self.emit_runtime_event("status")
            return

        self.set_phase("ready")

    def emit_runtime_event(self, event_type: str, payload: Optional[dict[str, Any]] = None) -> None:
        if self._runtime_event_emitter is None:
            return
        try:
            self._runtime_event_emitter(event_type, payload)
        except Exception as exc:
            logger.warning("[Engine] Failed to emit runtime event %s: %s", event_type, exc)

    def now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def reset_pipeline_timings(self) -> None:
        self.state.pipeline_timings = blank_pipeline_timings()

    def apply_capture_timeline(self, capture_timeline: Optional[dict[str, Any]]) -> None:
        if not capture_timeline:
            return
        next_timings = dict(self.state.pipeline_timings)
        for key in (
            "button_down",
            "capture_started",
            "first_partial",
            "stop_pressed",
            "record_start",
        ):
            value = capture_timeline.get(key)
            if isinstance(value, str) and value.strip():
                next_timings[key] = value.strip()
        if next_timings.get("record_start") is None and next_timings.get("capture_started") is not None:
            next_timings["record_start"] = next_timings["capture_started"]
        self.state.pipeline_timings = next_timings

    def mark_pipeline_timing(self, key: str) -> None:
        if key in self.state.pipeline_timings:
            self.state.pipeline_timings[key] = self.now_iso()
            self.emit_runtime_event("status")

    def current_smart_preview_text(self, run_id: Optional[str] = None) -> str:
        preview = self.state.smart_preview
        if not preview:
            return ""
        if run_id and preview.get("run_id") != run_id:
            return ""
        return str(preview.get("text") or "").strip()

    def emit_smart_preview(
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
        self.state.smart_preview = {
            "run_id": run_id,
            "mode": "smart_transform",
            "state": state,
            "text": text,
            "final_text": final_text,
            "error": error,
            "smart_profile": smart_profile,
            "smart_profile_label": smart_profile_label,
            "updated_at": self.now_iso(),
        }
        self.emit_runtime_event("smart_preview")
