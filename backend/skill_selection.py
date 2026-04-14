from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Literal, Optional

from agent.skills.manager import SkillManager
from agent.computer_use_planner import detect_computer_use_trigger
from config.models import AppSkillDefault, HotkeyConfig
from context_profile import derive_surface_kind, derive_target_type, normalize_context
from utils.logger import get_logger


logger = get_logger()
WHITESPACE_PATTERN = re.compile(r"\s+")
EMAIL_HOSTS = (
    "gmail.com",
    "mail.google.com",
    "outlook.office.com",
    "outlook.live.com",
    "hey.com",
    "superhuman.com",
)
EMAIL_APP_KEYWORDS = ("mail", "outlook", "superhuman", "hey")
NOTES_APP_KEYWORDS = ("notes", "notion", "bear", "obsidian", "craft")
TERMINAL_APP_KEYWORDS = ("terminal", "iterm", "warp", "hyper")
SOCIAL_HOSTS = (
    "linkedin.com",
    "x.com",
    "twitter.com",
    "threads.net",
    "reddit.com",
    "facebook.com",
    "instagram.com",
)
SOCIAL_COMPOSE_HINTS = (
    "start a post",
    "share a post",
    "create post",
    "what's happening",
    "what is happening",
    "write something",
    "caption",
    "post",
    "share your thoughts",
)
TRANSLATE_REQUEST_PATTERN = re.compile(r"\btranslate\b|\bin (?:spanish|french|german|italian|hindi|english)\b", re.IGNORECASE)
ISSUE_TICKET_PATTERN = re.compile(r"\b(?:jira|linear|ticket|bug report|acceptance criteria|issue)\b", re.IGNORECASE)
PROMPT_ARCHITECT_PATTERN = re.compile(
    r"\b(?:system prompt|agent prompt|prompt engineer|write (?:me )?(?:a )?prompt|craft (?:a )?prompt|prompt template)\b",
    re.IGNORECASE,
)
WORKFLOW_PATTERN = re.compile(
    r"\b(?:workflow|agent action|tool definition|tool schema|input schema|json schema|yaml|automation|make\.com|n8n|flowise)\b",
    re.IGNORECASE,
)
BULLET_REQUEST_PATTERN = re.compile(
    r"\b(?:bullet(?:ed)?(?: list| points?)?|bullets?|numbered list|checklist|action items?|key points?)\b",
    re.IGNORECASE,
)
AUTO_ROUTER_SKILL_IDS = {
    "system_dictation",
    "system_chat_reply",
    "system_email_draft",
    "system_terminal",
    "system_code",
    "system_codex_prompt",
    "system_antigravity_prompt",
    "system_cloud_code_prompt",
    "system_ai_chat_prompt",
    "system_prompt_architect",
    "system_agent_action_builder",
    "system_issue_ticket",
    "system_doc_notes",
    "system_bullets",
    "system_translate",
    "system_social_post",
}


@dataclass(frozen=True)
class RequestedSkillSelection:
    skill_id: str
    source: Literal["global_default", "app_override", "system_rule"] = "global_default"
    app_override_id: Optional[str] = None
    app_override_label: Optional[str] = None


@dataclass(frozen=True)
class ActiveSkillSelection:
    skill_id: str
    requested_skill_id: str
    source: Literal["global_default", "app_override", "system_rule", "domain_forced"] = "global_default"
    app_override_id: Optional[str] = None
    app_override_label: Optional[str] = None
    domain_skill_id: Optional[str] = None
    suppressed_requested_skill_source: Optional[Literal["global_default", "app_override", "system_rule"]] = None
    suppressed_requested_app_override_id: Optional[str] = None
    suppressed_requested_app_override_label: Optional[str] = None
    skill_router_resolver: Literal["none", "local", "model"] = "none"
    skill_router_model_attempted: bool = False
    skill_router_model_error: Optional[str] = None
    skill_router_provider: Optional[str] = None
    skill_router_model: Optional[str] = None
    auto_selected_skill_id: Optional[str] = None
    auto_selected_skill_name: Optional[str] = None
    auto_selected_skill_reason: Optional[str] = None


@dataclass(frozen=True)
class StarterSkillRule:
    id: str
    label: str
    skill_id: str
    bundle_id: Optional[str] = None
    url_host: Optional[str] = None
    app_name: Optional[str] = None
    title_contains: Optional[str] = None
    browser_only: bool = False
    requires_dictation_default: bool = False


@dataclass(frozen=True)
class AutoSkillCandidate:
    skill_id: str
    confidence: float
    reason: str


STARTER_SKILL_RULES = (
    StarterSkillRule(id="prompt_chatgpt", label="ChatGPT", skill_id="system_ai_chat_prompt", url_host="chatgpt.com", requires_dictation_default=True),
    StarterSkillRule(id="prompt_claude", label="Claude", skill_id="system_ai_chat_prompt", url_host="claude.ai", requires_dictation_default=True),
    StarterSkillRule(id="prompt_gemini", label="Gemini", skill_id="system_ai_chat_prompt", url_host="gemini.google.com", requires_dictation_default=True),
    StarterSkillRule(id="prompt_chatgpt_title", label="ChatGPT", skill_id="system_ai_chat_prompt", title_contains="chatgpt", browser_only=True, requires_dictation_default=True),
    StarterSkillRule(id="prompt_claude_title", label="Claude", skill_id="system_ai_chat_prompt", title_contains="claude", browser_only=True, requires_dictation_default=True),
    StarterSkillRule(id="prompt_gemini_title", label="Gemini", skill_id="system_ai_chat_prompt", title_contains="gemini", browser_only=True, requires_dictation_default=True),
    StarterSkillRule(id="workflow_make", label="Make", skill_id="system_agent_action_builder", url_host="make.com"),
    StarterSkillRule(id="workflow_n8n_io", label="n8n", skill_id="system_agent_action_builder", url_host="n8n.io"),
    StarterSkillRule(id="workflow_n8n_cloud", label="n8n Cloud", skill_id="system_agent_action_builder", url_host="n8n.cloud"),
    StarterSkillRule(id="workflow_flowise", label="Flowise", skill_id="system_agent_action_builder", url_host="flowiseai.com"),
    StarterSkillRule(id="workflow_make_title", label="Make", skill_id="system_agent_action_builder", title_contains="make", browser_only=True),
    StarterSkillRule(id="workflow_n8n_title", label="n8n", skill_id="system_agent_action_builder", title_contains="n8n", browser_only=True),
    StarterSkillRule(id="workflow_flowise_title", label="Flowise", skill_id="system_agent_action_builder", title_contains="flowise", browser_only=True),
    StarterSkillRule(id="editor_cursor", label="Cursor", skill_id="system_code", app_name="Cursor"),
    StarterSkillRule(id="editor_vscode_bundle", label="VS Code", skill_id="system_code", bundle_id="com.microsoft.VSCode"),
    StarterSkillRule(id="editor_vscode_code", label="Code", skill_id="system_code", app_name="Code"),
    StarterSkillRule(id="editor_vscode", label="Visual Studio Code", skill_id="system_code", app_name="Visual Studio Code"),
    StarterSkillRule(id="editor_vs_code", label="VS Code", skill_id="system_code", app_name="VS Code"),
    StarterSkillRule(id="editor_windsurf", label="Windsurf", skill_id="system_code", app_name="Windsurf"),
    StarterSkillRule(id="agent_codex", label="Codex", skill_id="system_codex_prompt", app_name="Codex"),
    StarterSkillRule(id="agent_antigravity", label="Antigravity", skill_id="system_antigravity_prompt", app_name="Antigravity"),
    StarterSkillRule(id="agent_cloud_code", label="Cloud Code", skill_id="system_cloud_code_prompt", app_name="Cloud Code"),
)


def normalize_app_name(value: Optional[str]) -> str:
    if not value:
        return ""
    return WHITESPACE_PATTERN.sub(" ", value.strip()).lower()


def normalize_host(value: Optional[str]) -> str:
    if not value:
        return ""
    cleaned = value.strip().lower().removeprefix("https://").removeprefix("http://").strip("/")
    if "/" in cleaned:
        cleaned = cleaned.split("/", 1)[0]
    return cleaned


def _normalize_title_text(context: Dict[str, Any]) -> str:
    return " ".join(
        WHITESPACE_PATTERN.sub(" ", str(value).strip()).lower()
        for value in (context.get("window_title"), context.get("page_title"))
        if value
    )


def _is_browser_context(context: Dict[str, Any]) -> bool:
    browser_names = {
        "safari",
        "google chrome",
        "arc",
        "brave browser",
        "microsoft edge",
    }
    browser_bundle_prefixes = (
        "com.apple.safari",
        "com.google.chrome",
        "company.thebrowser.browser",
        "com.brave.browser",
        "com.microsoft.edgemac",
    )
    normalized_app_name = normalize_app_name(context.get("app_name"))
    normalized_bundle_id = str(context.get("bundle_id") or "").strip().lower()
    return normalized_app_name in browser_names or any(normalized_bundle_id.startswith(prefix) for prefix in browser_bundle_prefixes)


def _host_matches(rule_host: Optional[str], context_host: Any) -> bool:
    normalized_rule_host = normalize_host(rule_host)
    normalized_context_host = normalize_host(str(context_host or ""))
    if not normalized_rule_host or not normalized_context_host:
        return False
    return normalized_context_host == normalized_rule_host or normalized_context_host.endswith(f".{normalized_rule_host}")


def _find_matching_override(
    overrides: list[AppSkillDefault],
    context: Dict[str, Any],
) -> Optional[AppSkillDefault]:
    bundle_id = str(context.get("bundle_id") or "").strip()
    if bundle_id:
        for override in overrides:
            if override.enabled and override.bundle_id == bundle_id:
                return override

    url_host = context.get("url_host")
    if url_host:
        for override in overrides:
            if not override.enabled or not override.url_host:
                continue
            if _host_matches(override.url_host, url_host):
                return override

    normalized_app_name = normalize_app_name(context.get("app_name"))
    if normalized_app_name:
        for override in overrides:
            if not override.enabled:
                continue
            if override.bundle_id or override.url_host:
                continue
            if normalize_app_name(override.app_name) == normalized_app_name:
                return override

    return None


def _find_matching_starter_rule(context: Dict[str, Any]) -> Optional[StarterSkillRule]:
    bundle_id = str(context.get("bundle_id") or "").strip()
    if bundle_id:
        for rule in STARTER_SKILL_RULES:
            if rule.bundle_id == bundle_id:
                return rule

    url_host = context.get("url_host")
    if url_host:
        for rule in STARTER_SKILL_RULES:
            if rule.url_host and _host_matches(rule.url_host, url_host):
                return rule

    normalized_title_text = _normalize_title_text(context)
    if normalized_title_text:
        for rule in STARTER_SKILL_RULES:
            if not rule.title_contains:
                continue
            if rule.browser_only and not _is_browser_context(context):
                continue
            if rule.title_contains in normalized_title_text:
                return rule

    normalized_app_name = normalize_app_name(context.get("app_name"))
    if normalized_app_name:
        for rule in STARTER_SKILL_RULES:
            if rule.app_name and normalize_app_name(rule.app_name) == normalized_app_name:
                return rule

    return None


def _looks_like_email_context(context: Dict[str, Any]) -> bool:
    normalized = normalize_context(context)
    app_name = normalize_app_name(normalized.get("app_name"))
    bundle_id = str(normalized.get("bundle_id") or "").strip().lower()
    title_text = _normalize_title_text(normalized)
    url_host = normalize_host(normalized.get("url_host"))
    surface_kind = derive_surface_kind(normalized) or str(normalized.get("surface_kind") or "").strip().lower()
    combined = " ".join(filter(None, [app_name, bundle_id, title_text, url_host, surface_kind]))

    if surface_kind in {"email_subject", "email_body"}:
        return True
    if any(host and (url_host == host or url_host.endswith(f".{host}")) for host in EMAIL_HOSTS):
        return True
    return any(keyword in combined for keyword in EMAIL_APP_KEYWORDS)


def _looks_like_notes_context(context: Dict[str, Any], *, target_type: Optional[str]) -> bool:
    if target_type == "browser_doc":
        return True
    normalized = normalize_context(context)
    searchable = " ".join(
        filter(
            None,
            [
                normalize_app_name(normalized.get("app_name")),
                str(normalized.get("bundle_id") or "").strip().lower(),
                _normalize_title_text(normalized),
                normalize_host(normalized.get("url_host")),
            ],
        )
    )
    return any(keyword in searchable for keyword in NOTES_APP_KEYWORDS)


def _resolve_contextual_dictation_rule(context: Dict[str, Any]) -> Optional[StarterSkillRule]:
    normalized = normalize_context(context)
    target_type = str(normalized.get("target_type") or derive_target_type(normalized) or "").strip().lower() or None
    searchable = " ".join(
        filter(
            None,
            [
                normalize_app_name(normalized.get("app_name")),
                str(normalized.get("bundle_id") or "").strip().lower(),
                _normalize_title_text(normalized),
                normalize_host(normalized.get("url_host")),
            ],
        )
    )

    if _looks_like_email_context(normalized):
        return StarterSkillRule(id="context_email", label="Email context", skill_id="system_email_draft")
    if _looks_like_social_post_context(normalized, target_type=target_type):
        return StarterSkillRule(id="context_social_post", label="Social post context", skill_id="system_social_post")
    if target_type == "chat":
        return StarterSkillRule(id="context_chat", label="Chat context", skill_id="system_chat_reply")
    if target_type == "ide":
        if any(keyword in searchable for keyword in TERMINAL_APP_KEYWORDS):
            return StarterSkillRule(id="context_terminal", label="Terminal context", skill_id="system_terminal")
        return StarterSkillRule(id="context_code", label="Code context", skill_id="system_code")
    if _looks_like_notes_context(normalized, target_type=target_type):
        return StarterSkillRule(id="context_docs", label="Notes context", skill_id="system_doc_notes")
    return None


def _normalize_transcript_text(value: Optional[str]) -> str:
    if not value:
        return ""
    return WHITESPACE_PATTERN.sub(" ", value.strip()).lower()


def _looks_like_social_post_context(context: Dict[str, Any], *, target_type: Optional[str]) -> bool:
    normalized = normalize_context(context)
    if target_type == "social_post":
        return True

    searchable = " ".join(
        filter(
            None,
            [
                normalize_app_name(normalized.get("app_name")),
                str(normalized.get("bundle_id") or "").strip().lower(),
                _normalize_title_text(normalized),
                normalize_host(normalized.get("url_host")),
                str(normalized.get("url_path") or "").strip().lower(),
                str(normalized.get("focused_field_label") or "").strip().lower(),
                str(normalized.get("focused_field_placeholder") or "").strip().lower(),
                str(normalized.get("focused_field_subrole") or "").strip().lower(),
            ],
        )
    )
    return any(host in searchable for host in SOCIAL_HOSTS) and any(hint in searchable for hint in SOCIAL_COMPOSE_HINTS)


def _build_auto_router_skill_catalog(skill_manager: SkillManager) -> list[dict[str, Any]]:
    return [
        skill
        for skill in skill_manager.get_router_skill_catalog()
        if skill.get("id") in AUTO_ROUTER_SKILL_IDS
    ]


def _build_auto_skill_candidates(
    *,
    transcript: str,
    context: Dict[str, Any],
    skill_manager: SkillManager,
) -> list[AutoSkillCandidate]:
    normalized = normalize_context(context)
    transcript_text = _normalize_transcript_text(transcript)
    target_type = str(normalized.get("target_type") or derive_target_type(normalized) or "").strip().lower() or None
    candidates: dict[str, AutoSkillCandidate] = {}

    def add_candidate(skill_id: str, confidence: float, reason: str) -> None:
        if not skill_manager.get_skill(skill_id):
            return
        existing = candidates.get(skill_id)
        if existing is None or confidence > existing.confidence:
            candidates[skill_id] = AutoSkillCandidate(
                skill_id=skill_id,
                confidence=confidence,
                reason=reason,
            )

    matched_starter_rule = _find_matching_starter_rule(normalized)
    if matched_starter_rule and skill_manager.get_skill(matched_starter_rule.skill_id):
        add_candidate(
            matched_starter_rule.skill_id,
            0.97,
            f"{matched_starter_rule.label} matched the active app or site.",
        )

    contextual_rule = _resolve_contextual_dictation_rule(normalized)
    if contextual_rule and skill_manager.get_skill(contextual_rule.skill_id):
        confidence = 0.95 if contextual_rule.skill_id == "system_social_post" else 0.9
        add_candidate(
            contextual_rule.skill_id,
            confidence,
            f"{contextual_rule.label} matched the current writing surface.",
        )

    if TRANSLATE_REQUEST_PATTERN.search(transcript_text):
        add_candidate("system_translate", 0.96, "The transcript explicitly asked for translation.")
    if ISSUE_TICKET_PATTERN.search(transcript_text):
        add_candidate("system_issue_ticket", 0.93, "The transcript reads like an issue or task ticket.")
    if PROMPT_ARCHITECT_PATTERN.search(transcript_text):
        add_candidate("system_prompt_architect", 0.93, "The transcript explicitly asked for prompt design.")
    if WORKFLOW_PATTERN.search(transcript_text):
        add_candidate("system_agent_action_builder", 0.91, "The transcript asked for a workflow, schema, or automation definition.")
    if BULLET_REQUEST_PATTERN.search(transcript_text):
        add_candidate("system_bullets", 0.86, "The transcript explicitly asked for bullet or checklist formatting.")

    return sorted(
        candidates.values(),
        key=lambda candidate: (-candidate.confidence, candidate.skill_id),
    )


def _resolve_auto_skill_selection(
    *,
    transcript: str,
    context: Dict[str, Any],
    skill_manager: SkillManager,
    smart_router_agent: Any = None,
    allow_model_routing: bool = True,
) -> dict[str, Any]:
    candidates = _build_auto_skill_candidates(
        transcript=transcript,
        context=context,
        skill_manager=skill_manager,
    )
    if not candidates:
        return {
            "skill_id": None,
            "skill_router_resolver": "none",
            "skill_router_model_attempted": False,
            "skill_router_model_error": None,
            "skill_router_provider": None,
            "skill_router_model": None,
            "auto_selected_skill_id": None,
            "auto_selected_skill_name": None,
            "auto_selected_skill_reason": None,
        }

    best_candidate = candidates[0]
    runner_up = candidates[1] if len(candidates) > 1 else None
    should_attempt_model = (
        allow_model_routing
        and smart_router_agent is not None
        and (
            len(candidates) > 1
            or best_candidate.confidence < 0.9
            or (runner_up is not None and (best_candidate.confidence - runner_up.confidence) < 0.08)
        )
    )

    model_attempted = False
    model_error: Optional[str] = None
    model_provider = getattr(smart_router_agent, "provider", None) if smart_router_agent is not None else None
    model_name = getattr(smart_router_agent, "model", None) if smart_router_agent is not None else None

    if should_attempt_model:
        model_attempted = True
        model_result, model_error = smart_router_agent.resolve_skill(
            transcript=transcript,
            context=context,
            requested_skill_id="system_dictation",
            requested_skill_name="Standard Dictation",
            local_candidate_skill_id=best_candidate.skill_id,
            local_candidate_reason=best_candidate.reason,
            candidate_skills=_build_auto_router_skill_catalog(skill_manager),
        )
        if model_result is not None and skill_manager.get_skill(model_result.skill_id):
            selected_skill = skill_manager.get_skill(model_result.skill_id)
            return {
                "skill_id": model_result.skill_id if model_result.skill_id != "system_dictation" else None,
                "skill_router_resolver": "model",
                "skill_router_model_attempted": True,
                "skill_router_model_error": None,
                "skill_router_provider": model_provider,
                "skill_router_model": model_name,
                "auto_selected_skill_id": None if model_result.skill_id == "system_dictation" else model_result.skill_id,
                "auto_selected_skill_name": None if selected_skill is None or model_result.skill_id == "system_dictation" else selected_skill.name,
                "auto_selected_skill_reason": model_result.reason,
            }

    if best_candidate.confidence >= 0.86:
        selected_skill = skill_manager.get_skill(best_candidate.skill_id)
        return {
            "skill_id": best_candidate.skill_id,
            "skill_router_resolver": "local",
            "skill_router_model_attempted": model_attempted,
            "skill_router_model_error": model_error,
            "skill_router_provider": model_provider,
            "skill_router_model": model_name,
            "auto_selected_skill_id": best_candidate.skill_id,
            "auto_selected_skill_name": selected_skill.name if selected_skill is not None else best_candidate.skill_id,
            "auto_selected_skill_reason": best_candidate.reason,
        }

    return {
        "skill_id": None,
        "skill_router_resolver": "local" if candidates else "none",
        "skill_router_model_attempted": model_attempted,
        "skill_router_model_error": model_error,
        "skill_router_provider": model_provider,
        "skill_router_model": model_name,
        "auto_selected_skill_id": None,
        "auto_selected_skill_name": None,
        "auto_selected_skill_reason": best_candidate.reason if candidates else None,
    }


def resolve_requested_skill(
    *,
    context: Dict[str, Any],
    hotkeys: HotkeyConfig,
    skill_manager: SkillManager,
) -> RequestedSkillSelection:
    default_skill_id = hotkeys.default_skill_id or "system_dictation"
    if not skill_manager.get_skill(default_skill_id):
        default_skill_id = "system_dictation"
    matched_override = _find_matching_override(hotkeys.app_skill_defaults, context)

    if matched_override and skill_manager.get_skill(matched_override.skill_id):
        return RequestedSkillSelection(
            skill_id=matched_override.skill_id,
            source="app_override",
            app_override_id=matched_override.id,
            app_override_label=matched_override.app_label,
        )

    if matched_override:
        logger.warning(
            "[SkillSelection] Override %r for %r references missing skill %r. Falling back to %r.",
            matched_override.id,
            matched_override.app_label,
            matched_override.skill_id,
            default_skill_id,
        )

    return RequestedSkillSelection(skill_id=default_skill_id)


def resolve_active_skill_selection(
    *,
    context: Dict[str, Any],
    hotkeys: HotkeyConfig,
    skill_manager: SkillManager,
    transcript: str = "",
    domain_id: Optional[str] = None,
    domain_skill_id: Optional[str] = None,
    smart_router_agent: Any = None,
    allow_model_routing: bool = True,
) -> ActiveSkillSelection:
    requested = resolve_requested_skill(
        context=context,
        hotkeys=hotkeys,
        skill_manager=skill_manager,
    )
    default_skill_id = hotkeys.default_skill_id or "system_dictation"
    if not skill_manager.get_skill(default_skill_id):
        default_skill_id = "system_dictation"

    if not domain_id:
        computer_use_trigger = (
            detect_computer_use_trigger(
                transcript=transcript,
                requested_skill_id=requested.skill_id,
                effective_skill_id=requested.skill_id,
            )
            if requested.source == "global_default" and requested.skill_id == "system_dictation"
            else None
        )
        auto_selection = (
            _resolve_auto_skill_selection(
                transcript=transcript,
                context=context,
                skill_manager=skill_manager,
                smart_router_agent=smart_router_agent,
                allow_model_routing=allow_model_routing,
            )
            if requested.source == "global_default" and requested.skill_id == "system_dictation" and computer_use_trigger is None
            else None
        )
        final_skill_id = str(auto_selection.get("skill_id") or requested.skill_id) if auto_selection else requested.skill_id
        selected_skill = skill_manager.get_skill(final_skill_id)
        return ActiveSkillSelection(
            skill_id=final_skill_id,
            requested_skill_id=requested.skill_id,
            source=requested.source,
            app_override_id=requested.app_override_id,
            app_override_label=requested.app_override_label,
            skill_router_resolver=(str(auto_selection.get("skill_router_resolver")) if auto_selection else "none"),
            skill_router_model_attempted=bool(auto_selection.get("skill_router_model_attempted")) if auto_selection else False,
            skill_router_model_error=(str(auto_selection.get("skill_router_model_error")) if auto_selection and auto_selection.get("skill_router_model_error") else None),
            skill_router_provider=(str(auto_selection.get("skill_router_provider")) if auto_selection and auto_selection.get("skill_router_provider") else None),
            skill_router_model=(str(auto_selection.get("skill_router_model")) if auto_selection and auto_selection.get("skill_router_model") else None),
            auto_selected_skill_id=(str(auto_selection.get("auto_selected_skill_id")) if auto_selection and auto_selection.get("auto_selected_skill_id") else None),
            auto_selected_skill_name=(selected_skill.name if auto_selection and auto_selection.get("auto_selected_skill_id") and selected_skill is not None else None),
            auto_selected_skill_reason=(str(auto_selection.get("auto_selected_skill_reason")) if auto_selection and auto_selection.get("auto_selected_skill_reason") else None),
        )

    suppressed_source = requested.source if requested.source != "global_default" else None
    suppressed_app_override_id = requested.app_override_id if suppressed_source else None
    suppressed_app_override_label = requested.app_override_label if suppressed_source else None

    if domain_skill_id and skill_manager.get_skill(domain_skill_id):
        return ActiveSkillSelection(
            skill_id=domain_skill_id,
            requested_skill_id=domain_skill_id,
            source="domain_forced",
            domain_skill_id=domain_skill_id,
            suppressed_requested_skill_source=suppressed_source,
            suppressed_requested_app_override_id=suppressed_app_override_id,
            suppressed_requested_app_override_label=suppressed_app_override_label,
        )

    if domain_skill_id:
        logger.warning(
            "[SkillSelection] Domain %r requested missing skill %r. Falling back to global default %r.",
            domain_id,
            domain_skill_id,
            default_skill_id,
        )

    return ActiveSkillSelection(
        skill_id=default_skill_id,
        requested_skill_id=default_skill_id,
        source="global_default",
        suppressed_requested_skill_source=suppressed_source,
        suppressed_requested_app_override_id=suppressed_app_override_id,
        suppressed_requested_app_override_label=suppressed_app_override_label,
    )
