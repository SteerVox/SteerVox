from __future__ import annotations

import re
import time
from difflib import SequenceMatcher
from typing import Any, Callable, Dict, Literal, Optional

from action_execution import ActionResolutionError, ReviewedActionBuilder
from action_routing import ExternalTextSource, resolve_external_text
from agent.computer_use_planner import ComputerUsePlanner, detect_computer_use_trigger
from agent.local_smart_profile import (
    LOCAL_SMART_PROFILE_ID,
    LOCAL_SMART_PROFILE_LABEL,
    classify_local_compact_request,
    extract_inline_source_request,
)
from agent.router import (
    LocalIntentRouter,
    apply_deterministic_transform,
    cleanup_sentence_punctuation,
    cleanup_plain_text,
    evaluate_skill_applicability,
    infer_format_preference,
    infer_spoken_list_format,
    normalize_list_item,
    normalize_whitespace,
    spoken_points_to_bullets,
)
from agent.skills.manager import SkillManager
from agent.skills.models import SkillDefinition
from agent.smart_models import (
    AutoActionPayload,
    LocalTaskRequestPayload,
    PendingActionReviewPayload,
    SkillReference,
    SmartIntent,
    SmartLane,
    SmartModeResult,
    SmartRunTelemetry,
)
from agent.smart_router_agent import SmartRouterAgent, should_use_smart_router_model
from agent.supervisor import SupervisorAgent
from command_control import apply_format_contract, enforce_surface_contract
from local_task_shell import evaluate_local_command_policy, normalize_task_command_request
from local_task_shell.models import LocalTaskStep
from utils.logger import get_logger

logger = get_logger()

EXTERNAL_TEXT_ELIGIBLE_INTENTS = {
    "translate",
    "grammar_cleanup",
    "email_rewrite",
    "bulletize",
    "jira_ticket",
    "prompt_crafting",
    "workflow_design",
    "code_refactor",
    "generic",
}
CLIPBOARD_REFERENCE_PATTERN = re.compile(
    r"\b(?:this|that|it|selection|selected text|selected code|highlighted text|highlighted code|clipboard|clipboard text|this format|this json|this schema|this response|these logs|this log)\b",
    re.IGNORECASE,
)
BULLET_LINE_PATTERN = re.compile(r"^\s*[-*]\s+", re.MULTILINE)
CHECKLIST_LINE_PATTERN = re.compile(r"^\s*\[(?: |x|X)\]\s+", re.MULTILINE)
LOCAL_LABELED_SEGMENT_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9 /_-]{0,24}:\s+\S")
MEDICAL_SECTION_BREAK_PATTERN = re.compile(
    r"(?<!^)(?:(?<=[.!?])\s+|(?<=;)\s+)(?=(?:HPI|ROS|Assessment(?: details)?|Plan|Follow-?up|Exam|Physical exam|Visit reason|Current status|Referral summary|Major events|Instructions):)",
    re.IGNORECASE,
)
SCREEN_SUMMARY_REQUEST_PATTERN = re.compile(
    r"\b(?:summari[sz]e|describe|explain|what(?:'s| is) on)\b.*\b(?:screen|page|window|site|this)\b",
    re.IGNORECASE,
)
INLINE_SOURCE_REQUEST_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(make this(?: sound)?(?: more)? professional)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? polite)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? clear(?:er)?)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? concise)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? short(?:er)?)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(rewrite this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(rephrase this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(polish this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(clean this up)\s+(.+)$", re.IGNORECASE),
)
DOMAIN_LOCAL_MODEL_SKILL_IDS = {
    "system_domain_email",
    "system_domain_structured_note",
}


class SmartModeProcessor:
    def __init__(
        self,
        *,
        provider: str,
        model: str,
        temperature: float,
        skill_manager: Optional[SkillManager] = None,
        agent: Optional[SupervisorAgent] = None,
        router: Optional[LocalIntentRouter] = None,
        smart_router_agent: Optional[SmartRouterAgent] = None,
    ):
        self.provider = provider
        self.model = model
        self.temperature = temperature
        self.skill_manager = skill_manager or SkillManager()
        self.agent = agent or SupervisorAgent(provider=provider, model=model, temperature=temperature)
        self.router = router or LocalIntentRouter()
        self.smart_router_agent = smart_router_agent
        self.reviewed_action_builder = ReviewedActionBuilder(provider=provider, model=model, temperature=temperature)
        self.computer_use_planner = ComputerUsePlanner(
            provider=provider,
            model=model,
            temperature=temperature,
        )

    def process(
        self,
        transcript: str,
        context: Dict[str, Any],
        skill_id: str,
        *,
        resolved_skill_id: Optional[str] = None,
        stt_latency_ms: Optional[int] = None,
        requested_skill_source: str = "global_default",
        requested_app_override_id: Optional[str] = None,
        requested_app_override_label: Optional[str] = None,
        domain_skill_id: Optional[str] = None,
        note_routing_suppressed: bool = False,
        suppressed_requested_skill_source: Optional[str] = None,
        suppressed_requested_app_override_id: Optional[str] = None,
        suppressed_requested_app_override_label: Optional[str] = None,
        selection_text: Optional[str] = None,
        selection_truncated: bool = False,
        clipboard_text: Optional[str] = None,
        clipboard_truncated: bool = False,
        action_route: str = "transform_then_paste",
        action_resolver: str = "none",
        force_external_context: bool = False,
        domain_id: Optional[str] = None,
        domain_source: str = "none",
        domain_rule_id: Optional[str] = None,
        domain_rule_label: Optional[str] = None,
        domain_intent: Optional[str] = None,
        domain_template_id: Optional[str] = None,
        domain_example_id: Optional[str] = None,
        domain_glossary_hits: Optional[list[str]] = None,
        domain_context_block: Optional[str] = None,
        command_operations_applied: Optional[list[str]] = None,
        format_contract: Optional[str] = None,
        code_format_hint: Optional[str] = None,
        actions_enabled: bool = True,
        experimental_media_controls_enabled: bool = True,
        memory_context_block: Optional[str] = None,
        preview_callback: Optional[Callable[[str], None]] = None,
        skill_router_resolver: str = "none",
        skill_router_model_attempted: bool = False,
        skill_router_model_error: Optional[str] = None,
        skill_router_provider: Optional[str] = None,
        skill_router_model: Optional[str] = None,
        auto_selected_skill_id: Optional[str] = None,
        auto_selected_skill_name: Optional[str] = None,
        auto_selected_skill_reason: Optional[str] = None,
    ) -> SmartModeResult:
        started_at = time.perf_counter()
        requested_skill = self.skill_manager.get_skill(skill_id) or self.skill_manager.get_skill("system_dictation")
        if requested_skill is None:
            raise RuntimeError("System dictation skill is unavailable.")

        route_skill = (
            self.skill_manager.get_skill(resolved_skill_id)
            if resolved_skill_id and resolved_skill_id != skill_id
            else requested_skill
        ) or requested_skill

        effective_skill, fallback_applied, fallback_reason, raw_fallback = self._resolve_effective_skill(
            requested_skill=route_skill,
            context=context,
        )

        selection_available = bool(selection_text and selection_text.strip())
        clipboard_available = bool(clipboard_text and clipboard_text.strip())
        external_text = resolve_external_text(selection_text, clipboard_text)
        computer_use_trigger = detect_computer_use_trigger(
            transcript=transcript,
            requested_skill_id=requested_skill.id,
            effective_skill_id=effective_skill.id,
        )
        local_compact_classification = None
        smart_profile = "default"
        profile_limit_reason: Optional[str] = None
        structured_output_mode = "none"
        structured_output_schema: Optional[str] = None
        structured_output_failure_kind = "none"

        if (
            self.provider.lower() == "lmstudio"
            and not raw_fallback
            and effective_skill.id != "system_local_task"
            and computer_use_trigger is None
            and not self._should_bypass_local_compact_profile(
                requested_skill=requested_skill,
                effective_skill=effective_skill,
                domain_skill_id=domain_skill_id,
            )
        ):
            local_compact_classification = classify_local_compact_request(
                transcript=transcript,
                context=context,
                requested_skill=requested_skill,
                effective_skill=effective_skill,
                selection_text=selection_text,
                clipboard_text=clipboard_text,
            )
            smart_profile = LOCAL_SMART_PROFILE_ID
            profile_limit_reason = local_compact_classification.profile_limit_reason
            if local_compact_classification.response_format is not None:
                structured_output_mode = "json_schema"
                structured_output_schema = local_compact_classification.response_schema_name
            if not local_compact_classification.is_supported:
                return self._build_local_compact_refusal_result(
                    transcript=transcript,
                    context=context,
                    requested_skill=SkillReference(id=requested_skill.id, name=requested_skill.name),
                    skill_used=SkillReference(id=effective_skill.id, name=effective_skill.name),
                    reason=local_compact_classification.reason,
                    refusal_message=local_compact_classification.refusal_message or "",
                    profile_limit_reason=local_compact_classification.profile_limit_reason,
                    stt_latency_ms=stt_latency_ms,
                    smart_profile=smart_profile,
                    structured_output_mode=structured_output_mode,
                    structured_output_schema=structured_output_schema,
                    requested_skill_source=requested_skill_source,
                    requested_app_override_id=requested_app_override_id,
                    requested_app_override_label=requested_app_override_label,
                    domain_skill_id=domain_skill_id,
                    note_routing_suppressed=note_routing_suppressed,
                    suppressed_requested_skill_source=suppressed_requested_skill_source,
                    suppressed_requested_app_override_id=suppressed_requested_app_override_id,
                    suppressed_requested_app_override_label=suppressed_requested_app_override_label,
                    action_route=action_route,
                    action_resolver=action_resolver,
                )

        decision = self.router.plan(
            transcript,
            context,
            requested_skill=requested_skill,
            effective_skill=effective_skill,
            fallback_applied=fallback_applied,
            fallback_reason=fallback_reason,
            raw_fallback=raw_fallback,
        )
        if local_compact_classification is not None:
            decision = decision.model_copy(update={
                "intent": local_compact_classification.intent,
                "lane": local_compact_classification.lane,
                "confidence": max(decision.confidence, 0.82),
                "ambiguity": round(1.0 - max(decision.confidence, 0.82), 3),
                "reason": local_compact_classification.reason,
                "output_mode": local_compact_classification.output_mode,
            })
        planner_resolver = "local"
        planner_model_attempted = False
        planner_model_error: Optional[str] = None
        planner_provider: Optional[str] = None
        planner_model: Optional[str] = None

        if self._should_attempt_smart_router(decision) and self.smart_router_agent is not None:
            planner_model_attempted = True
            planner_provider = self.smart_router_agent.provider
            planner_model = self.smart_router_agent.model
            model_result, model_error = self.smart_router_agent.resolve(
                transcript=transcript,
                context=context,
                requested_skill_id=requested_skill.id,
                requested_skill_name=requested_skill.name,
                effective_skill_id=effective_skill.id,
                effective_skill_name=effective_skill.name,
                local_decision=decision,
                selection_available=selection_available,
                clipboard_available=clipboard_available,
                available_skills=self.skill_manager.get_router_skill_catalog(),
            )
            if model_result is not None and self._is_router_decision_safe(model_result.intent, model_result.lane):
                decision = decision.model_copy(update={
                    "intent": model_result.intent,
                    "lane": model_result.lane,
                    "confidence": model_result.confidence,
                    "ambiguity": round(1.0 - model_result.confidence, 3),
                    "reason": model_result.reason,
                    "output_mode": self._resolve_output_mode(model_result.intent, effective_skill),
                })
                planner_resolver = "model"
            else:
                planner_model_error = model_error or "Smart router model returned an unsafe routing decision."

        if decision.intent == SmartIntent.ACTION_EXECUTION:
            action_skill = self.skill_manager.get_skill("system_action_execution")
            if action_skill is not None:
                effective_skill = action_skill
        elif decision.intent == SmartIntent.COMPUTER_USE:
            computer_use_skill = self.skill_manager.get_skill("system_computer_use")
            if computer_use_skill is not None:
                effective_skill = computer_use_skill
                decision = decision.model_copy(update={
                    "skill_used": SkillReference(id=computer_use_skill.id, name=computer_use_skill.name),
                })

        final_text = transcript.strip()
        context_fields_sent: list[str] = []
        payload_estimated_bytes = 0
        llm_latency_ms: Optional[int] = None
        llm_timeout_budget_ms: Optional[int] = None
        llm_timeout_triggered = False
        llm_fallback_applied = False
        llm_fallback_reason: Optional[str] = None
        deterministic_operations = list(decision.deterministic_operations)
        selection_used = False
        clipboard_used = False
        external_context_source = ExternalTextSource.NONE
        effective_context = dict(context)
        if domain_context_block:
            effective_context["domain_context_block"] = domain_context_block
        if domain_id:
            effective_context["domain_id"] = domain_id
        if domain_intent:
            effective_context["domain_intent"] = domain_intent
        if domain_glossary_hits:
            effective_context["domain_glossary_hits"] = list(domain_glossary_hits)
        if domain_template_id:
            effective_context["domain_template_id"] = domain_template_id
        if domain_example_id:
            effective_context["domain_example_id"] = domain_example_id
        if format_contract:
            effective_context["command_format_contract"] = format_contract
        if code_format_hint:
            effective_context["code_format_hint"] = code_format_hint
        if local_compact_classification is not None:
            effective_context["smart_profile"] = LOCAL_SMART_PROFILE_ID
            effective_context["smart_profile_label"] = LOCAL_SMART_PROFILE_LABEL
            effective_context["local_compact_contract_id"] = local_compact_classification.contract_id
            effective_context["local_compact_streaming_allowed"] = local_compact_classification.streaming_allowed
            if local_compact_classification.response_format is not None:
                effective_context["local_compact_response_format"] = local_compact_classification.response_format
                effective_context["local_compact_response_schema_name"] = local_compact_classification.response_schema_name

        if force_external_context and external_text.source != ExternalTextSource.NONE and decision.lane.value != "llm":
            decision = decision.model_copy(update={
                "lane": SmartLane.LLM,
                "confidence": max(decision.confidence, 0.72),
                "ambiguity": round(1.0 - max(decision.confidence, 0.72), 3),
                "reason": f"{decision.reason} External selected text was available, so Smart Mode promoted this request to the LLM lane.",
            })

        pending_action_review: PendingActionReviewPayload | None = None
        local_task_request: LocalTaskRequestPayload | None = None
        auto_action: AutoActionPayload | None = None
        action_error: str | None = None
        action_error_kind: Literal["resolution", "execution"] | None = None
        refusal_message: str | None = None
        computer_use_plan_kind: Literal["desktop_action", "local_task", "multi_step", "refusal"] | None = None
        llm_transcript = transcript
        if decision.intent == SmartIntent.ACTION_EXECUTION:
            if not actions_enabled:
                action_error = "Desktop actions are disabled in Advanced settings."
                action_error_kind = "resolution"
            else:
                try:
                    built_action = self.reviewed_action_builder.build(
                        transcript=transcript,
                        context=effective_context,
                        skill=effective_skill,
                    )
                except ActionResolutionError as exc:
                    action_error = str(exc).strip() or "The requested desktop action could not be resolved safely."
                    action_error_kind = "resolution"
                except RuntimeError as exc:
                    action_error = str(exc).strip() or "Smart Mode could not convert that request into a safe desktop action."
                    action_error_kind = "resolution"
                else:
                    if built_action.pending_review is not None:
                        pending_action_review = PendingActionReviewPayload.model_validate(
                            built_action.pending_review.model_dump(mode="json")
                        )
                    if built_action.auto_action is not None:
                        auto_action = AutoActionPayload.model_validate(
                            built_action.auto_action.model_dump(mode="json")
                        )
                        if (
                            auto_action.action_type in {"play_pause", "next_track", "previous_track"}
                            and not experimental_media_controls_enabled
                        ):
                            auto_action = None
                            action_error = "Experimental media controls are turned off in Advanced settings."
                            action_error_kind = "resolution"
            final_text = ""
        elif decision.intent == SmartIntent.COMPUTER_USE:
            computer_use_plan = self.computer_use_planner.plan(
                transcript=transcript,
                context=effective_context,
                trigger=computer_use_trigger or "explicit_mode",
                selection_text=selection_text,
                clipboard_text=clipboard_text,
            )
            if computer_use_plan.model_attempted:
                planner_model_attempted = True
                planner_provider = self.provider
                planner_model = self.model
                planner_resolver = "model"
            computer_use_plan_kind = computer_use_plan.kind
            decision = decision.model_copy(update={
                "reason": computer_use_plan.reason,
            })
            if computer_use_plan.kind == "desktop_action":
                if not actions_enabled:
                    action_error = "Desktop actions are disabled in Advanced settings."
                    action_error_kind = "resolution"
                else:
                    action_skill = self.skill_manager.get_skill("system_action_execution") or effective_skill
                    try:
                        built_action = self.reviewed_action_builder.build(
                            transcript=transcript,
                            context=effective_context,
                            skill=action_skill,
                        )
                    except ActionResolutionError as exc:
                        action_error = str(exc).strip() or "The requested desktop action could not be resolved safely."
                        action_error_kind = "resolution"
                    except RuntimeError as exc:
                        action_error = str(exc).strip() or "Computer Use could not convert that request into a safe desktop action."
                        action_error_kind = "resolution"
                    else:
                        if built_action.pending_review is not None:
                            pending_action_review = PendingActionReviewPayload.model_validate(
                                built_action.pending_review.model_dump(mode="json")
                            )
                        if built_action.auto_action is not None:
                            auto_action = AutoActionPayload.model_validate(
                                built_action.auto_action.model_dump(mode="json")
                            )
                            if (
                                auto_action.action_type in {"play_pause", "next_track", "previous_track"}
                                and not experimental_media_controls_enabled
                            ):
                                auto_action = None
                                action_error = "Experimental media controls are turned off in Advanced settings."
                                action_error_kind = "resolution"
            elif computer_use_plan.kind == "local_task":
                if not computer_use_plan.command:
                    action_error = "Computer Use could not resolve a runnable local task command."
                    action_error_kind = "resolution"
                else:
                    local_task_request = LocalTaskRequestPayload(
                        request_text=transcript.strip(),
                        command=computer_use_plan.command,
                        cwd=effective_context.get("workspace_root"),
                        title=effective_skill.name,
                        source_intent="computer_use",
                    )
            elif computer_use_plan.kind == "multi_step":
                try:
                    local_task_request = self._build_multi_step_local_task_request(
                        transcript=transcript,
                        context=effective_context,
                        effective_skill=effective_skill,
                        steps=computer_use_plan.steps,
                        plan_summary=computer_use_plan.plan_summary,
                        experimental_media_controls_enabled=experimental_media_controls_enabled,
                    )
                except (ActionResolutionError, RuntimeError) as exc:
                    action_error = str(exc).strip() or "Computer Use could not build a safe multi-step local plan."
                    action_error_kind = "resolution"
            else:
                refusal_message = computer_use_plan.refusal_message or computer_use_plan.reason
            final_text = ""
        elif decision.intent == SmartIntent.LOCAL_TASK:
            command_text, request_operations = normalize_task_command_request(transcript)
            if command_text != transcript:
                deterministic_operations.extend(
                    operation for operation in request_operations if operation not in deterministic_operations
                )
            command_text, applied_operations = apply_deterministic_transform(
                SmartIntent.TERMINAL_COMMAND,
                command_text,
            )
            deterministic_operations.extend(
                operation for operation in applied_operations if operation not in deterministic_operations
            )
            if not command_text.strip():
                action_error = "The local task request did not contain a runnable local command."
                action_error_kind = "resolution"
            else:
                local_task_request = LocalTaskRequestPayload(
                    request_text=transcript.strip(),
                    command=command_text.strip(),
                    cwd=effective_context.get("workspace_root"),
                    title=effective_skill.name,
                    source_intent="local_task",
                )
            final_text = ""
        elif decision.lane.value == "passthrough":
            final_text = transcript.strip()
        elif decision.lane.value == "deterministic":
            final_text, applied_operations = apply_deterministic_transform(decision.intent, transcript)
            deterministic_operations.extend(op for op in applied_operations if op not in deterministic_operations)
        else:
            external_context_source = self._resolve_external_context_source(
                decision=decision,
                transcript=transcript,
                selection_text=selection_text,
                clipboard_text=clipboard_text,
                force_external_context=force_external_context,
            )
            if external_context_source != ExternalTextSource.NONE:
                effective_context["external_text"] = external_text.text
                effective_context["external_text_source"] = external_context_source.value
                selection_used = external_context_source == ExternalTextSource.SELECTION
                clipboard_used = external_context_source == ExternalTextSource.CLIPBOARD
            llm_transcript, effective_context, source_material_operations = self._inject_local_source_material(
                decision=decision,
                transcript=transcript,
                effective_context=effective_context,
            )
            for operation in source_material_operations:
                if operation not in deterministic_operations:
                    deterministic_operations.append(operation)
            if memory_context_block:
                effective_context["memory_context_block"] = memory_context_block
            response = self.agent.process_transcript(
                llm_transcript,
                effective_context,
                effective_skill,
                preview_callback=preview_callback,
            )
            llm_timeout_budget_ms = response.timeout_budget_ms
            structured_output_mode = getattr(response, "structured_output_mode", structured_output_mode)
            structured_output_schema = getattr(response, "structured_output_schema", structured_output_schema)
            structured_output_failure_kind = getattr(response, "structured_output_failure_kind", structured_output_failure_kind)
            if response.error:
                if structured_output_mode == "json_schema" and structured_output_failure_kind == "none":
                    structured_output_failure_kind = "transport_error"
                timeout_detected = response.timeout_triggered or self._is_lmstudio_timeout_error(response.error) or self._is_remote_provider_timeout_error(response.error)
                fallback_text, fallback_operations = self._fallback_llm_error(
                    decision=decision,
                    transcript=transcript,
                    effective_context=effective_context,
                    error_message=response.error,
                    timeout_triggered=timeout_detected,
                )
                if not fallback_text:
                    raise RuntimeError(response.error)
                logger.warning(
                    "Smart Mode provider failed for intent %s. Falling back to safe local cleanup. provider=%s error=%s",
                    decision.intent.value,
                    self.provider,
                    response.error,
                )
                final_text = fallback_text
                fallback_applied = True
                llm_timeout_triggered = timeout_detected
                llm_fallback_applied = True
                llm_fallback_reason = response.error
                extra_reason = response.error.strip() if response.error else "Smart provider failed, so Smart Mode fell back to a safe local cleanup."
                fallback_reason = f"{fallback_reason} {extra_reason}".strip() if fallback_reason else extra_reason
                for operation in fallback_operations:
                    if operation not in deterministic_operations:
                        deterministic_operations.append(operation)
                context_fields_sent = response.context_fields_sent
                payload_estimated_bytes = response.payload_estimated_bytes
                llm_latency_ms = response.latency_ms
            elif not response.text:
                fallback_text, fallback_operations = self._fallback_llm_empty_output(
                    decision=decision,
                    transcript=transcript,
                    effective_context=effective_context,
                )
                if not fallback_text:
                    raise RuntimeError("Smart Mode could not produce usable output. Check your provider and try again.")
                logger.warning(
                    "Smart Mode provider returned empty output for intent %s. Falling back to safe local cleanup. provider=%s",
                    decision.intent.value,
                    self.provider,
                )
                final_text = fallback_text
                fallback_applied = True
                llm_fallback_applied = True
                llm_fallback_reason = "Provider returned empty output."
                extra_reason = "Provider returned empty output, so Smart Mode fell back to a safe local cleanup."
                fallback_reason = f"{fallback_reason} {extra_reason}".strip() if fallback_reason else extra_reason
                for operation in fallback_operations:
                    if operation not in deterministic_operations:
                        deterministic_operations.append(operation)
                context_fields_sent = response.context_fields_sent
                payload_estimated_bytes = response.payload_estimated_bytes
                llm_latency_ms = response.latency_ms
            else:
                final_text = response.text
                echo_fallback_text, echo_fallback_operations = self._fallback_local_instruction_echo(
                    decision=decision,
                    transcript=llm_transcript,
                    final_text=final_text,
                    effective_context=effective_context,
                )
                if echo_fallback_text:
                    final_text = echo_fallback_text
                    fallback_applied = True
                    extra_reason = "Local model echoed the instruction instead of transforming the source text, so Smart Mode fell back to the available source material."
                    fallback_reason = f"{fallback_reason} {extra_reason}".strip() if fallback_reason else extra_reason
                    for operation in echo_fallback_operations:
                        if operation not in deterministic_operations:
                            deterministic_operations.append(operation)
            context_fields_sent = response.context_fields_sent
            payload_estimated_bytes = response.payload_estimated_bytes
            llm_latency_ms = response.latency_ms

        if decision.lane.value == "llm" and decision.intent != SmartIntent.ACTION_EXECUTION:
            cleaned_transcript, cleaned_operations = cleanup_plain_text(transcript)
            if self._is_low_signal_text(final_text) and not self._is_low_signal_text(cleaned_transcript):
                logger.warning("Smart Mode LLM returned low-signal output for intent %s. Falling back to the cleaned transcript.", decision.intent.value)
                final_text = cleaned_transcript
                fallback_applied = True
                extra_reason = "LLM returned too little usable text, so Smart Mode fell back to the cleaned transcript."
                fallback_reason = f"{fallback_reason} {extra_reason}".strip() if fallback_reason else extra_reason
                for operation in cleaned_operations:
                    if operation not in deterministic_operations:
                        deterministic_operations.append(operation)
            final_text, local_cleanup_operations = self._normalize_local_structured_output(
                text=final_text,
                context=effective_context,
            )
            for operation in local_cleanup_operations:
                if operation not in deterministic_operations:
                    deterministic_operations.append(operation)

        surface_contract_applied = False
        if decision.intent != SmartIntent.ACTION_EXECUTION:
            final_text, formatting_operations = self._enforce_format_preference(
                text=final_text,
                transcript=transcript,
                context=effective_context,
                skill=effective_skill,
                intent=decision.intent,
                allow_list_output_formatting=not fallback_applied,
            )
            for operation in formatting_operations:
                if operation not in deterministic_operations:
                    deterministic_operations.append(operation)

            final_text, surface_contract_applied = enforce_surface_contract(final_text, context)
            final_text = self._enforce_max_chars(final_text, effective_skill)

        total_latency_ms = int((time.perf_counter() - started_at) * 1000)
        telemetry = SmartRunTelemetry(
            intent=decision.intent,
            lane=decision.lane,
            confidence=decision.confidence,
            ambiguity=decision.ambiguity,
            reason=decision.reason,
            requested_skill=decision.requested_skill,
            skill_used=decision.skill_used,
            requested_skill_source=requested_skill_source,
            requested_app_override_id=requested_app_override_id,
            requested_app_override_label=requested_app_override_label,
            domain_skill_id=domain_skill_id,
            note_routing_suppressed=note_routing_suppressed,
            suppressed_requested_skill_source=suppressed_requested_skill_source,
            suppressed_requested_app_override_id=suppressed_requested_app_override_id,
            suppressed_requested_app_override_label=suppressed_requested_app_override_label,
            fallback_applied=fallback_applied,
            fallback_reason=fallback_reason,
            output_mode=decision.output_mode,
            deterministic_operations=deterministic_operations,
            command_operations_applied=list(command_operations_applied or []),
            format_contract=format_contract,
            surface_contract_applied=surface_contract_applied,
            smart_profile=smart_profile,  # type: ignore[arg-type]
            profile_limit_reason=profile_limit_reason,
            provider=self.provider if decision.lane.value == "llm" else None,
            model=self.model if decision.lane.value == "llm" else None,
            domain_id=domain_id,
            domain_source=domain_source,
            domain_rule_id=domain_rule_id,
            domain_rule_label=domain_rule_label,
            domain_intent=domain_intent,
            domain_template_id=domain_template_id,
            domain_example_id=domain_example_id,
            domain_glossary_hits=list(domain_glossary_hits or []),
            surface_kind=context.get("surface_kind"),
            transcript_chars=len(transcript),
            output_chars=len(final_text),
            context_quality=context.get("context_quality", "empty"),
            target_type=context.get("target_type"),
            context_fields_sent=context_fields_sent,
            browser_enrichment_used=bool(context.get("page_title") or context.get("url_host") or context.get("url_path")),
            external_request_made=decision.lane.value == "llm",
            payload_estimated_bytes=payload_estimated_bytes,
            llm_timeout_budget_ms=llm_timeout_budget_ms,
            llm_timeout_triggered=llm_timeout_triggered,
            llm_fallback_applied=llm_fallback_applied,
            llm_fallback_reason=llm_fallback_reason,
            structured_output_mode=structured_output_mode,  # type: ignore[arg-type]
            structured_output_schema=structured_output_schema,
            structured_output_failure_kind=structured_output_failure_kind,  # type: ignore[arg-type]
            skill_router_resolver=skill_router_resolver,
            skill_router_model_attempted=skill_router_model_attempted,
            skill_router_model_error=skill_router_model_error,
            skill_router_provider=skill_router_provider,
            skill_router_model=skill_router_model,
            auto_selected_skill_id=auto_selected_skill_id,
            auto_selected_skill_name=auto_selected_skill_name,
            auto_selected_skill_reason=auto_selected_skill_reason,
            planner_resolver=planner_resolver,
            planner_model_attempted=planner_model_attempted,
            planner_model_error=planner_model_error,
            planner_provider=planner_provider,
            planner_model=planner_model,
            action_route=action_route,
            action_resolver=action_resolver,
            computer_use_trigger=computer_use_trigger,
            computer_use_plan_kind=computer_use_plan_kind,
            external_context_source=external_context_source.value,
            selection_available=selection_available,
            selection_used=selection_used,
            selection_chars=len((selection_text or "").strip()) if selection_available else 0,
            selection_truncated=selection_truncated if selection_available else False,
            clipboard_available=clipboard_available,
            clipboard_used=clipboard_used,
            clipboard_chars=len((clipboard_text or "").strip()) if clipboard_available else 0,
            clipboard_truncated=clipboard_truncated if clipboard_available else False,
            planner_latency_ms=max(total_latency_ms - (llm_latency_ms or 0), 0),
            stt_latency_ms=stt_latency_ms,
            llm_latency_ms=llm_latency_ms,
            total_latency_ms=(stt_latency_ms or 0) + total_latency_ms,
            alternatives_available=0,
            action_review_required=pending_action_review is not None,
            action_execution_mode=(
                "reviewed"
                if pending_action_review is not None
                else "auto"
                if auto_action is not None
                else "none"
            ),
        )

        return SmartModeResult(
            intent=decision.intent,
            lane=decision.lane,
            confidence=decision.confidence,
            ambiguity=decision.ambiguity,
            final_text=final_text,
            requested_skill=decision.requested_skill,
            skill_used=decision.skill_used,
            fallback_applied=fallback_applied,
            fallback_reason=fallback_reason,
            deterministic_operations=deterministic_operations,
            alternatives=[],
            pending_action_review=pending_action_review,
            local_task_request=local_task_request,
            auto_action=auto_action,
            action_error=action_error,
            action_error_kind=action_error_kind,
            refusal_message=refusal_message,
            telemetry=telemetry,
        )

    def _build_local_compact_refusal_result(
        self,
        *,
        transcript: str,
        context: Dict[str, Any],
        requested_skill: SkillReference,
        skill_used: SkillReference,
        reason: str,
        refusal_message: str,
        profile_limit_reason: Optional[str],
        stt_latency_ms: Optional[int],
        smart_profile: str,
        structured_output_mode: str,
        structured_output_schema: Optional[str],
        requested_skill_source: str,
        requested_app_override_id: Optional[str],
        requested_app_override_label: Optional[str],
        domain_skill_id: Optional[str],
        note_routing_suppressed: bool,
        suppressed_requested_skill_source: Optional[str],
        suppressed_requested_app_override_id: Optional[str],
        suppressed_requested_app_override_label: Optional[str],
        action_route: str,
        action_resolver: str,
    ) -> SmartModeResult:
        telemetry = SmartRunTelemetry(
            intent=SmartIntent.LOCAL_UNSUPPORTED,
            lane=SmartLane.REFUSED,
            confidence=0.98,
            ambiguity=0.02,
            reason=reason,
            requested_skill=requested_skill,
            skill_used=skill_used,
            requested_skill_source=requested_skill_source,
            requested_app_override_id=requested_app_override_id,
            requested_app_override_label=requested_app_override_label,
            domain_skill_id=domain_skill_id,
            note_routing_suppressed=note_routing_suppressed,
            suppressed_requested_skill_source=suppressed_requested_skill_source,
            suppressed_requested_app_override_id=suppressed_requested_app_override_id,
            suppressed_requested_app_override_label=suppressed_requested_app_override_label,
            output_mode="plain_text",
            smart_profile=smart_profile,  # type: ignore[arg-type]
            profile_limit_reason=profile_limit_reason,
            structured_output_mode=structured_output_mode,  # type: ignore[arg-type]
            structured_output_schema=structured_output_schema,
            structured_output_failure_kind="none",
            surface_kind=context.get("surface_kind"),
            transcript_chars=len(transcript),
            output_chars=0,
            context_quality=context.get("context_quality", "empty"),
            target_type=context.get("target_type"),
            action_route=action_route,  # type: ignore[arg-type]
            action_resolver=action_resolver,  # type: ignore[arg-type]
            stt_latency_ms=stt_latency_ms,
            planner_latency_ms=0,
            total_latency_ms=stt_latency_ms or 0,
        )
        return SmartModeResult(
            intent=SmartIntent.LOCAL_UNSUPPORTED,
            lane=SmartLane.REFUSED,
            confidence=0.98,
            ambiguity=0.02,
            final_text="",
            requested_skill=requested_skill,
            skill_used=skill_used,
            refusal_message=refusal_message,
            telemetry=telemetry,
        )

    def _is_low_signal_text(self, text: str) -> bool:
        stripped = text.strip()
        if not stripped:
            return True
        return not any(char.isalnum() for char in stripped)

    def _fallback_llm_empty_output(
        self,
        *,
        decision,
        transcript: str,
        effective_context: Dict[str, Any],
    ) -> tuple[str, list[str]]:
        source_text = self._resolve_fallback_source_text(
            transcript=transcript,
            effective_context=effective_context,
        )
        if not source_text:
            return "", []

        if decision.intent == SmartIntent.TERMINAL_COMMAND:
            transformed_text, operations = apply_deterministic_transform(decision.intent, source_text)
            return transformed_text, list(operations)

        cleaned_text, operations = cleanup_plain_text(source_text)
        operations = list(operations)
        operations.append("local_empty_output_fallback" if self.provider.lower() == "lmstudio" else "remote_empty_output_fallback")
        return cleaned_text or source_text, operations

    def _fallback_llm_error(
        self,
        *,
        decision,
        transcript: str,
        effective_context: Dict[str, Any],
        error_message: Optional[str],
        timeout_triggered: bool,
    ) -> tuple[str, list[str]]:
        detail = str(error_message or "").strip()
        if self.provider.lower() == "lmstudio" and not self._is_lmstudio_timeout_error(detail):
            return "", []
        if self.provider.lower() != "lmstudio" and not (
            timeout_triggered or self._is_remote_provider_timeout_error(detail)
        ):
            return "", []

        source_text = self._resolve_fallback_source_text(
            transcript=transcript,
            effective_context=effective_context,
        )
        if not source_text:
            return "", []

        fallback_operation = (
            "local_timeout_fallback"
            if self.provider.lower() == "lmstudio"
            else "remote_timeout_fallback"
            if timeout_triggered or self._is_remote_provider_timeout_error(detail)
            else "remote_provider_error_fallback"
        )

        if decision.intent == SmartIntent.TERMINAL_COMMAND:
            transformed_text, operations = apply_deterministic_transform(decision.intent, source_text)
            return transformed_text, list(operations) + [fallback_operation]

        cleaned_text, operations = cleanup_plain_text(source_text)
        operations = list(operations)
        operations.append(fallback_operation)
        return cleaned_text or source_text, operations

    def _inject_local_source_material(
        self,
        *,
        decision,
        transcript: str,
        effective_context: Dict[str, Any],
    ) -> tuple[str, Dict[str, Any], list[str]]:
        if self.provider.lower() != "lmstudio" or decision.lane.value != "llm":
            return transcript, effective_context, []
        if str(effective_context.get("external_text") or "").strip():
            return transcript, effective_context, []

        screen_context = str(effective_context.get("screen_context") or "").strip()
        if screen_context and SCREEN_SUMMARY_REQUEST_PATTERN.search(transcript):
            return transcript, {
                **effective_context,
                "external_text": screen_context,
                "external_text_source": "screen_context",
            }, ["screen_context_as_source_material"]

        inline_source = self._extract_inline_source_request(transcript)
        if not inline_source:
            return transcript, effective_context, []

        instruction, source_text = inline_source
        return instruction, {
            **effective_context,
            "external_text": source_text,
            "external_text_source": "transcript_inline",
        }, ["inline_spoken_source_material"]

    def _fallback_local_instruction_echo(
        self,
        *,
        decision,
        transcript: str,
        final_text: str,
        effective_context: Dict[str, Any],
    ) -> tuple[str, list[str]]:
        if self.provider.lower() != "lmstudio" or decision.lane.value != "llm":
            return "", []

        source_text = str(effective_context.get("external_text") or "").strip()
        if not source_text:
            return "", []
        if not self._looks_like_instruction_echo(final_text, transcript):
            return "", []

        cleaned_text, operations = cleanup_plain_text(source_text)
        operations = list(operations)
        operations.append("local_instruction_echo_fallback")
        return cleaned_text or source_text, operations

    def _is_lmstudio_timeout_error(self, detail: str) -> bool:
        if self.provider.lower() != "lmstudio":
            return False
        lowered = detail.lower()
        return "lm studio" in lowered and "timed out" in lowered

    def _resolve_fallback_source_text(
        self,
        *,
        transcript: str,
        effective_context: Dict[str, Any],
    ) -> str:
        external_text = str(effective_context.get("external_text") or "").strip()
        if external_text:
            return external_text

        inline_source = self._extract_inline_source_request(transcript)
        if inline_source:
            _instruction, source_text = inline_source
            return source_text.strip()

        return str(transcript or "").strip()

    def _is_remote_provider_timeout_error(self, detail: str) -> bool:
        if self.provider.lower() == "lmstudio":
            return False
        lowered = detail.lower()
        return any(
            marker in lowered
            for marker in ("timed out", "timeout", "read timeout", "readtimeout", "apitimeouterror", "deadline exceeded")
        )

    def _should_attempt_smart_router(self, decision) -> bool:
        if self.provider.lower() == "lmstudio":
            return False
        return should_use_smart_router_model(decision, mode="smart_transform")

    def _should_bypass_local_compact_profile(
        self,
        *,
        requested_skill: SkillDefinition,
        effective_skill: SkillDefinition,
        domain_skill_id: Optional[str],
    ) -> bool:
        if requested_skill.id in DOMAIN_LOCAL_MODEL_SKILL_IDS:
            return True
        if effective_skill.id in DOMAIN_LOCAL_MODEL_SKILL_IDS:
            return True
        return bool(domain_skill_id and domain_skill_id in DOMAIN_LOCAL_MODEL_SKILL_IDS)

    def _build_multi_step_local_task_request(
        self,
        *,
        transcript: str,
        context: Dict[str, Any],
        effective_skill: SkillDefinition,
        steps: list[Any],
        plan_summary: Optional[str],
        experimental_media_controls_enabled: bool,
    ) -> LocalTaskRequestPayload:
        compiled_steps: list[LocalTaskStep] = []
        cwd = context.get("workspace_root")
        action_skill = self.skill_manager.get_skill("system_action_execution") or effective_skill

        for index, planned_step in enumerate(steps, start=1):
            step_id = f"step-{index}"
            if planned_step.kind == "shell_command":
                command_text = str(planned_step.request or "").strip()
                decision = evaluate_local_command_policy(
                    command_text,
                    cwd=cwd,
                )
                if not decision.allowed or not decision.normalized_command:
                    raise RuntimeError(decision.reason or "A multi-step shell command was blocked by local policy.")
                compiled_steps.append(
                    LocalTaskStep(
                        id=step_id,
                        kind="shell_command",
                        title=planned_step.title or f"Run step {index}",
                        summary=planned_step.summary or f"Run {decision.normalized_command}",
                        status="pending",
                        command=decision.normalized_command,
                        cwd=decision.cwd,
                        language="shell",
                        script=decision.normalized_command,
                        review_required=True,
                    )
                )
                continue

            if planned_step.kind == "desktop_action":
                built_action = self.reviewed_action_builder.build_planned_step(
                    planned_step=planned_step,
                    context=context,
                    skill=action_skill,
                )
                if built_action.pending_review is not None:
                    review = PendingActionReviewPayload.model_validate(
                        built_action.pending_review.model_dump(mode="json")
                    )
                    compiled_steps.append(
                        LocalTaskStep(
                            id=step_id,
                            kind="desktop_action",
                            title=review.title,
                            summary=review.summary,
                            status="pending",
                            language="applescript",
                            script=review.script,
                            review_required=True,
                            execution_mode="reviewed",
                            action_type=review.action_type,
                        )
                    )
                    continue

                if built_action.auto_action is not None:
                    auto = AutoActionPayload.model_validate(
                        built_action.auto_action.model_dump(mode="json")
                    )
                    if (
                        auto.action_type in {"play_pause", "next_track", "previous_track"}
                        and not experimental_media_controls_enabled
                    ):
                        raise RuntimeError("Experimental media controls are turned off in Advanced settings.")
                    compiled_steps.append(
                        LocalTaskStep(
                            id=step_id,
                            kind="desktop_action",
                            title=auto.title,
                            summary=auto.summary,
                            status="pending",
                            review_required=False,
                            execution_mode="auto",
                            action_type=auto.action_type,
                            app_name=auto.app_name,
                            bundle_id=auto.bundle_id,
                            value_percent=auto.value_percent,
                            target_label=auto.target_label,
                            target_role=auto.target_role,
                            ui_index=auto.ui_index,
                        )
                    )
                    continue

                raise RuntimeError("A planned desktop action could not be compiled into a runnable step.")

            raise RuntimeError("Computer Use produced an unsupported multi-step action.")

        if not compiled_steps:
            raise RuntimeError("Computer Use could not build any runnable multi-step actions.")

        return LocalTaskRequestPayload(
            request_text=transcript.strip(),
            command=None,
            cwd=cwd,
            title=effective_skill.name,
            source_intent="computer_use",
            run_kind="multi_step",
            plan_summary=plan_summary or f"Execute {len(compiled_steps)} reviewed steps.",
            steps=compiled_steps,
        )

    def _resolve_effective_skill(
        self,
        *,
        requested_skill: SkillDefinition,
        context: Dict[str, Any],
    ) -> tuple[SkillDefinition, bool, Optional[str], bool]:
        applicable, reason = evaluate_skill_applicability(
            requested_skill,
            context,
            context.get("target_type"),
        )
        if applicable:
            return requested_skill, False, None, False

        fallback = requested_skill.fallback_behavior
        if fallback == "raw_dictation":
            return requested_skill, True, reason, True

        if fallback and fallback != "selected_skill":
            fallback_skill = self.skill_manager.get_skill(fallback)
            if fallback_skill:
                return fallback_skill, True, reason, False

        return requested_skill, False, None, False

    def _enforce_max_chars(self, text: str, skill: SkillDefinition) -> str:
        if not skill.max_chars or len(text) <= skill.max_chars:
            return text

        if skill.output_mode in {"command", "code"}:
            return text

        suffix = "..."
        cutoff = max(skill.max_chars - len(suffix), 1)
        truncated = text[:cutoff].rstrip()
        if " " in truncated:
            truncated = truncated.rsplit(" ", 1)[0].rstrip() or truncated
        return f"{truncated}{suffix}"

    def _enforce_format_preference(
        self,
        *,
        text: str,
        transcript: str,
        context: Dict[str, Any],
        skill: SkillDefinition,
        intent: SmartIntent,
        allow_list_output_formatting: bool,
    ) -> tuple[str, list[str]]:
        preference = infer_format_preference(transcript, skill, context)
        if not preference:
            return text, []

        if preference in {"bullets", "checklist", "numbered"}:
            if not allow_list_output_formatting:
                return text, []
            output_list_preference = self._infer_list_output_preference(text)
            if not output_list_preference:
                return text, []
            preference = output_list_preference

        formatted_text, operations = apply_format_contract(
            text,
            format_contract=preference,
            transcript_hint=None,
        )
        if formatted_text.strip() != text.strip():
            return formatted_text, operations

        if preference == "bullets" and BULLET_LINE_PATTERN.search(text):
            normalized_lines = []
            changed = False
            for raw_line in text.splitlines():
                stripped_line = raw_line.strip()
                if not stripped_line:
                    continue
                if stripped_line.startswith(("-", "*")):
                    item = stripped_line[1:].strip()
                    normalized_item = normalize_list_item(item) if item else item
                    normalized_lines.append(f"- {normalized_item}" if normalized_item else "-")
                    changed = changed or normalized_item != item or not stripped_line.startswith("- ")
                else:
                    normalized_lines.append(stripped_line)
            if changed and normalized_lines:
                return "\n".join(normalized_lines), operations + ["normalize_bullet_lines"]

        return text, operations

    def _infer_list_output_preference(self, text: str) -> str | None:
        stripped = str(text or "").strip()
        if not stripped:
            return None

        if CHECKLIST_LINE_PATTERN.search(stripped):
            return "checklist"

        spoken_list_format = infer_spoken_list_format(stripped)
        if spoken_list_format in {"bullets", "numbered"}:
            return spoken_list_format

        if BULLET_LINE_PATTERN.search(stripped) or spoken_points_to_bullets(stripped)[0]:
            return "bullets"

        return None

    def _resolve_external_context_source(
        self,
        *,
        decision,
        transcript: str,
        selection_text: Optional[str],
        clipboard_text: Optional[str],
        force_external_context: bool,
    ) -> ExternalTextSource:
        if decision.lane.value != "llm":
            return ExternalTextSource.NONE

        external_text = resolve_external_text(selection_text, clipboard_text)
        if external_text.source == ExternalTextSource.NONE or not external_text.text:
            return ExternalTextSource.NONE

        if decision.intent.value not in EXTERNAL_TEXT_ELIGIBLE_INTENTS and not (
            force_external_context and decision.intent.value not in {"chat_reply", "terminal_command", "code_snippet", "raw_dictation"}
        ):
            return ExternalTextSource.NONE

        if force_external_context or CLIPBOARD_REFERENCE_PATTERN.search(transcript):
            return external_text.source

        return ExternalTextSource.NONE

    def _resolve_output_mode(self, intent: SmartIntent, skill: SkillDefinition) -> str:
        if intent == SmartIntent.TERMINAL_COMMAND:
            return "command"
        if intent == SmartIntent.BULLETIZE:
            return "bullets"
        if intent in {SmartIntent.WORKFLOW_DESIGN, SmartIntent.CODE_REFACTOR, SmartIntent.CODE_SNIPPET, SmartIntent.ACTION_EXECUTION}:
            return "code"
        return skill.output_mode

    def _is_router_decision_safe(self, intent: SmartIntent, lane: SmartLane) -> bool:
        if lane == SmartLane.PASSTHROUGH:
            return intent == SmartIntent.RAW_DICTATION
        if lane == SmartLane.DETERMINISTIC:
            return intent in {
                SmartIntent.RAW_DICTATION,
                SmartIntent.GRAMMAR_CLEANUP,
                SmartIntent.TERMINAL_COMMAND,
            }
        return True

    def _normalize_local_structured_output(
        self,
        *,
        text: str,
        context: Dict[str, Any],
    ) -> tuple[str, list[str]]:
        if self.provider.lower() != "lmstudio":
            return text, []

        surface_kind = str(context.get("surface_kind") or "").strip().lower()
        if surface_kind in {"single_line_input", "search", "email_subject"}:
            return text, []

        stripped = str(text or "").strip()
        if not stripped:
            return text, []

        domain_id = str(context.get("domain_id") or "").strip().lower()
        if domain_id == "medical":
            normalized_medical = MEDICAL_SECTION_BREAK_PATTERN.sub("\n\n", stripped)
            if normalized_medical != stripped:
                return normalized_medical, ["normalize_medical_note_sections"]

        if "\n" in stripped or ";" not in stripped:
            return text, []

        segments = [segment.strip() for segment in stripped.split(";") if segment.strip()]
        if len(segments) < 2:
            return text, []
        if not all(LOCAL_LABELED_SEGMENT_PATTERN.match(segment) for segment in segments):
            return text, []
        if any(len(segment.split()) > 18 for segment in segments):
            return text, []

        rendered_segments: list[str] = []
        for segment in segments:
            label, body = segment.split(":", 1)
            normalized_label = normalize_whitespace(label)
            if normalized_label.islower():
                normalized_label = normalized_label.capitalize()
            normalized_body = normalize_whitespace(body)
            normalized_body, _ = cleanup_sentence_punctuation(normalized_body)
            normalized_body = normalized_body.rstrip(".")
            if not normalized_body:
                return text, []
            rendered_segments.append(f"- {normalized_label}: {normalized_body}")

        return "\n".join(rendered_segments), ["normalize_local_labeled_segments"]

    def _extract_inline_source_request(self, transcript: str) -> tuple[str, str] | None:
        return extract_inline_source_request(transcript)

    def _looks_like_instruction_echo(self, final_text: str, transcript: str) -> bool:
        normalized_output = normalize_whitespace(final_text).lower()
        normalized_transcript = normalize_whitespace(transcript).lower()
        if not normalized_output or not normalized_transcript:
            return False
        if normalized_output == normalized_transcript:
            return True
        if any(pattern.match(normalized_output) for pattern in INLINE_SOURCE_REQUEST_PATTERNS):
            return True
        return SequenceMatcher(None, normalized_output, normalized_transcript).ratio() >= 0.88
