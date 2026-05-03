from __future__ import annotations

from enum import Enum
from typing import List, Literal, Optional

from pydantic import BaseModel, Field
from local_task_shell.models import LocalTaskStep, TaskRunKind


class SmartLane(str, Enum):
    PASSTHROUGH = "passthrough"
    DETERMINISTIC = "deterministic"
    LLM = "llm"
    REFUSED = "refused"


class SmartIntent(str, Enum):
    RAW_DICTATION = "raw_dictation"
    ACTION_EXECUTION = "action_execution"
    LOCAL_TASK = "local_task"
    COMPUTER_USE = "computer_use"
    GRAMMAR_CLEANUP = "grammar_cleanup"
    CHAT_REPLY = "chat_reply"
    EMAIL_REWRITE = "email_rewrite"
    BULLETIZE = "bulletize"
    TERMINAL_COMMAND = "terminal_command"
    CODE_SNIPPET = "code_snippet"
    CODE_REFACTOR = "code_refactor"
    JIRA_TICKET = "jira_ticket"
    PROMPT_CRAFTING = "prompt_crafting"
    TRANSLATE = "translate"
    WORKFLOW_DESIGN = "workflow_design"
    GENERIC = "generic"


class SkillReference(BaseModel):
    id: str
    name: str


class RoutingDecision(BaseModel):
    intent: SmartIntent
    lane: SmartLane
    confidence: float
    ambiguity: float
    reason: str
    requested_skill: SkillReference
    skill_used: SkillReference
    fallback_applied: bool = False
    fallback_reason: Optional[str] = None
    deterministic_operations: List[str] = Field(default_factory=list)
    output_mode: str = "plain_text"


class SmartRunTelemetry(BaseModel):
    intent: SmartIntent
    lane: SmartLane
    confidence: float
    ambiguity: float
    reason: str
    requested_skill: SkillReference
    skill_used: SkillReference
    requested_skill_source: Literal["global_default", "app_override", "system_rule", "domain_forced", "history_override"] = "global_default"
    requested_app_override_id: Optional[str] = None
    requested_app_override_label: Optional[str] = None
    domain_skill_id: Optional[str] = None
    note_routing_suppressed: bool = False
    suppressed_requested_skill_source: Optional[Literal["global_default", "app_override", "system_rule"]] = None
    suppressed_requested_app_override_id: Optional[str] = None
    suppressed_requested_app_override_label: Optional[str] = None
    fallback_applied: bool = False
    fallback_reason: Optional[str] = None
    output_mode: str = "plain_text"
    deterministic_operations: List[str] = Field(default_factory=list)
    command_operations_applied: List[str] = Field(default_factory=list)
    format_contract: Optional[str] = None
    surface_contract_applied: bool = False
    smart_profile: Literal["default"] = "default"
    profile_limit_reason: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    domain_id: Optional[str] = None
    domain_source: Literal["none", "app_override", "global_pin", "system_rule"] = "none"
    domain_rule_id: Optional[str] = None
    domain_rule_label: Optional[str] = None
    domain_intent: Optional[str] = None
    domain_template_id: Optional[str] = None
    domain_example_id: Optional[str] = None
    domain_glossary_hits: List[str] = Field(default_factory=list)
    surface_kind: Optional[str] = None
    transcript_chars: int = 0
    output_chars: int = 0
    context_quality: str = "empty"
    target_type: Optional[str] = None
    context_fields_sent: List[str] = Field(default_factory=list)
    browser_enrichment_used: bool = False
    external_request_made: bool = False
    payload_estimated_bytes: int = 0
    llm_timeout_budget_ms: Optional[int] = None
    llm_timeout_triggered: bool = False
    llm_fallback_applied: bool = False
    llm_fallback_reason: Optional[str] = None
    structured_output_mode: Literal["none", "json_schema"] = "none"
    structured_output_schema: Optional[str] = None
    structured_output_failure_kind: Literal["none", "grammar_truncation_error", "schema_validation_error", "transport_error"] = "none"
    skill_router_resolver: Literal["none", "local", "model"] = "none"
    skill_router_model_attempted: bool = False
    skill_router_model_error: Optional[str] = None
    skill_router_provider: Optional[str] = None
    skill_router_model: Optional[str] = None
    auto_selected_skill_id: Optional[str] = None
    auto_selected_skill_name: Optional[str] = None
    auto_selected_skill_reason: Optional[str] = None
    planner_resolver: Literal["local", "model"] = "local"
    planner_model_attempted: bool = False
    planner_model_error: Optional[str] = None
    planner_provider: Optional[str] = None
    planner_model: Optional[str] = None
    action_route: Literal["pass_through", "save_note", "transform_then_paste", "transform_then_save_note"] = "transform_then_paste"
    action_resolver: Literal["none", "local", "groq"] = "none"
    computer_use_trigger: Optional[Literal["explicit_mode", "action_phrase"]] = None
    computer_use_plan_kind: Optional[Literal["desktop_action", "local_task", "multi_step", "refusal"]] = None
    external_context_source: Literal["selection", "clipboard", "none"] = "none"
    selection_available: bool = False
    selection_used: bool = False
    selection_chars: int = 0
    selection_truncated: bool = False
    clipboard_available: bool = False
    clipboard_used: bool = False
    clipboard_chars: int = 0
    clipboard_truncated: bool = False
    planner_latency_ms: int = 0
    stt_latency_ms: Optional[int] = None
    llm_latency_ms: Optional[int] = None
    total_latency_ms: Optional[int] = None
    alternatives_available: int = 0
    action_review_required: bool = False
    action_execution_mode: Literal["none", "reviewed", "auto"] = "none"


class PendingActionReviewPayload(BaseModel):
    run_id: str
    action_type: Literal[
        "open_app",
        "open_url",
        "mail_draft",
        "youtube_open_first_result",
        "youtube_ensure_playing",
    ]
    title: str
    summary: str
    script: str
    language: Literal["applescript"] = "applescript"
    status: Literal["pending", "approved", "rejected", "error"] = "pending"
    error: Optional[str] = None


class AutoActionPayload(BaseModel):
    action_type: Literal[
        "focus_field",
        "press_button",
        "focus_browser_address_bar",
        "focus_primary_chat_input",
        "press_primary_chat_send",
        "play_pause",
        "pause_playback",
        "next_track",
        "previous_track",
        "mute_audio",
        "unmute_audio",
        "volume_up",
        "volume_down",
        "set_volume_percent",
        "brightness_up",
        "brightness_down",
        "set_brightness_percent",
        "browser_back",
        "browser_forward",
        "browser_reload",
    ]
    title: str
    summary: str
    app_name: str
    bundle_id: Optional[str] = None
    value_percent: Optional[int] = None
    target_label: Optional[str] = None
    target_role: Optional[str] = None
    ui_index: Optional[int] = None


class LocalTaskRequestPayload(BaseModel):
    request_text: str
    command: Optional[str] = None
    cwd: Optional[str] = None
    title: Optional[str] = None
    source_intent: Literal["local_task", "computer_use"] = "local_task"
    run_kind: TaskRunKind = "single_step"
    plan_summary: Optional[str] = None
    steps: List[LocalTaskStep] = Field(default_factory=list)


class SmartModeResult(BaseModel):
    intent: SmartIntent
    lane: SmartLane
    confidence: float
    ambiguity: float
    final_text: str
    requested_skill: SkillReference
    skill_used: SkillReference
    fallback_applied: bool = False
    fallback_reason: Optional[str] = None
    deterministic_operations: List[str] = Field(default_factory=list)
    alternatives: List[str] = Field(default_factory=list)
    pending_action_review: Optional[PendingActionReviewPayload] = None
    local_task_request: Optional[LocalTaskRequestPayload] = None
    auto_action: Optional[AutoActionPayload] = None
    action_error: Optional[str] = None
    action_error_kind: Optional[Literal["resolution", "execution"]] = None
    refusal_message: Optional[str] = None
    telemetry: SmartRunTelemetry
