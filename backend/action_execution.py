from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Literal, Optional
from uuid import uuid4

from pydantic import BaseModel

from agent.skills.models import SkillDefinition
from agent.smart_models import AutoActionPayload
from automation.applescript import escape_applescript_string, run_applescript_lines
from automation.reviewed_actions import execute_reviewed_applescript, validate_reviewed_applescript
from app_catalog import AppCatalog, InstalledAppRecord, normalize_app_match_text
from config.manager import ConfigManager
from imperative_phrases import normalize_imperative_phrase
from local_task_shell.models import LocalTaskStep
from providers.llm_factory import LLMFactory
from system_control import SystemControlError, SystemControlService
from ui_automation import BUTTON_ROLES, TEXT_FIELD_ROLES, UIAutomationService, UIElementCandidate, classify_ui_automation_error
from utils.logger import get_logger


logger = get_logger()
ReviewedActionType = Literal[
    "open_app",
    "open_url",
    "mail_draft",
    "youtube_open_first_result",
    "youtube_ensure_playing",
]
ActionType = Literal[
    "open_app",
    "open_url",
    "mail_draft",
    "youtube_open_first_result",
    "youtube_ensure_playing",
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
AUTO_ACTION_TYPES = {
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
}
UI_AUTOMATION_ACTION_TYPES = {
    "focus_field",
    "press_button",
    "focus_browser_address_bar",
    "focus_primary_chat_input",
    "press_primary_chat_send",
}
OPEN_APP_VERBS = ("switch to", "bring up", "focus on", "open up", "launch", "focus", "open")
URL_VERBS = ("open", "go to", "visit", "navigate to")
FIELD_NOUNS = (
    "chat input box",
    "chat input",
    "prompt box",
    "prompt input",
    "message field",
    "message box",
    "reply box",
    "chat box",
    "compose field",
    "field",
    "input box",
    "input",
    "text box",
    "textbox",
    "text area",
    "search field",
    "search box",
    "search bar",
    "message box",
    "compose box",
    "bar",
)
CONTROL_SUFFIXES = ("button", "link")
LEADING_TARGET_FILLER_PATTERN = re.compile(r"^(?:on|into|in|to|the|a|an|my|this|that|current)\s+", re.IGNORECASE)
TRAILING_PAGE_HINT_PATTERN = re.compile(r"\s+(?:on|in)\s+(?:this|the|current)\s+(?:page|screen|site)\b", re.IGNORECASE)
TRAILING_CONTROL_SUFFIX_PATTERN = re.compile(r"\s+(?:button|link)\b", re.IGNORECASE)
TRAILING_CONTEXT_QUALIFIER_PATTERN = re.compile(
    r"\s+(?:of|on|in)\s+(?:chatgpt|chat gpt|claude|gemini|google chrome|chrome|safari|arc|brave(?: browser)?|microsoft edge|edge|browser)\b.*$",
    re.IGNORECASE,
)
LEADING_APP_FILLER_PATTERN = re.compile(r"^(?:the|my)\s+", re.IGNORECASE)
TRAILING_APP_NOUN_PATTERN = re.compile(r"\s+(?:app|application)\b$", re.IGNORECASE)
TRAILING_APP_CLAUSE_PATTERN = re.compile(
    r"\s+(?:and|then)\s+(?:go|open|show|find|search|navigate|switch|focus|bring|launch|move|scroll|click|press|select|type)\b.*$",
    re.IGNORECASE,
)
DOT_WORD_PATTERN = re.compile(r"\s+dot\s+", re.IGNORECASE)
SLASH_WORD_PATTERN = re.compile(r"\s+slash\s+", re.IGNORECASE)
COLON_WORD_PATTERN = re.compile(r"\s+colon\s+", re.IGNORECASE)
MULTISPACE_PATTERN = re.compile(r"\s+")
URL_PATH_SPACE_PATTERN = re.compile(r"\s*/\s*")
SUPPORTED_BROWSER_APPS = {
    "Safari",
    "Google Chrome",
    "Arc",
    "Brave Browser",
    "Microsoft Edge",
}
CHROMIUM_BROWSER_APPS = SUPPORTED_BROWSER_APPS - {"Safari"}
SUPPORTED_YOUTUBE_BROWSER_APPS = {
    "Google Chrome",
    "Brave Browser",
    "Microsoft Edge",
}
SUPPORTED_MEDIA_APPS = {
    "Music",
    "Spotify",
}
EXPERIMENTAL_MEDIA_ACTION_TYPES = {"play_pause", "next_track", "previous_track"}
URL_HOST_PATTERN = re.compile(r"^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$")
AI_CHAT_HOST_ALIASES = {
    "chatgpt.com": ("chatgpt", "chat gpt"),
    "claude.ai": ("claude",),
    "gemini.google.com": ("gemini",),
}
AI_CHAT_HOST_LABELS = {
    "chatgpt.com": "ChatGPT",
    "claude.ai": "Claude",
    "gemini.google.com": "Gemini",
}

OPEN_URL_PATTERN = re.compile(
    r"\b(?:open|go to|visit|navigate to)\s+((?:https?://)?[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:/[^\s]*)?)",
    re.IGNORECASE,
)
SPOKEN_URL_PATTERN = re.compile(
    r"\b(?:open|go to|visit|navigate to)\s+([A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+)+(?:\s+slash\s+[A-Za-z0-9._~!$&'()*+,;=:@-]+)*)",
    re.IGNORECASE,
)
OPEN_APP_PATTERN = re.compile(
    r"\b(?:open(?: up)?|launch|switch to|bring up|focus(?: on)?)\s+([A-Za-z0-9][A-Za-z0-9 .&+'/-]{1,60})$",
    re.IGNORECASE,
)
MAIL_RECIPIENT_PATTERN = re.compile(
    r"\b(?:email|mail|draft|compose)\b.*?\bto\s+([A-Za-z0-9@._ +'-]{2,80})",
    re.IGNORECASE,
)
MAIL_SUBJECT_PATTERN = re.compile(
    r"\b(?:subject|about|regarding)\s+(.+?)(?=(?:\b(?:saying|that says|with body|body|message)\b|$))",
    re.IGNORECASE,
)
MAIL_BODY_PATTERN = re.compile(
    r"\b(?:saying|that says|with body|body|message)\s+(.+)$",
    re.IGNORECASE,
)
MAIL_INTENT_PATTERN = re.compile(r"\b(?:email|mail|draft|compose)\b", re.IGNORECASE)
FOCUS_FIELD_PATTERN = re.compile(
    r"\b(?:focus(?: on)?|select|click into|tap into|go to|jump to|put (?:the )?(?:cursor|caret) in|place (?:the )?(?:cursor|caret) in)\s+(.+)$",
    re.IGNORECASE,
)
PRESS_BUTTON_PATTERN = re.compile(
    r"\b(?:click|press|tap|choose|hit)\s+(?:the\s+)?(.+?)(?:\s+button)?$",
    re.IGNORECASE,
)
BROWSER_ADDRESS_BAR_PATTERN = re.compile(
    r"\b(?:focus(?: on)?|select|click into|tap into|go to|jump to|put (?:the )?(?:cursor|caret) in|place (?:the )?(?:cursor|caret) in)\s+(?:the\s+)?(?:(?:browser|chrome|safari|arc|brave|edge)\s+)?(?:address bar|url bar|omnibox|browser address)\b",
    re.IGNORECASE,
)
PRIMARY_CHAT_INPUT_PATTERN = re.compile(
    r"\b(?:focus(?: on)?|select|click into|tap into|go to|jump to|put (?:the )?(?:cursor|caret) in|place (?:the )?(?:cursor|caret) in)\s+(?:the\s+)?(?:chat input(?: box)?|prompt box|prompt input|message field|message box|reply box|chat box|compose box|compose field|input box|input field|text box|text area|composer)\b",
    re.IGNORECASE,
)
PRIMARY_CHAT_SEND_PATTERN = re.compile(
    r"\b(?:click|press|tap|choose|hit)\s+(?:the\s+)?(?:send(?: message| prompt)?|submit(?: prompt)?|ask(?:\s+(?:chatgpt|chat gpt|claude|gemini))?)(?:\s+button)?\b",
    re.IGNORECASE,
)
PLAY_PAUSE_PATTERN = re.compile(
    r"\b(?:play(?:\s*/\s*|\s+or\s+|\s+)pause|pause\s*/\s*play|toggle\s+(?:playback|media)|toggle\s+play(?:back)?|toggle\s+pause)\b",
    re.IGNORECASE,
)
PAUSE_PLAYBACK_PATTERN = re.compile(
    r"\b(?:pause(?:\s+(?:playback|music|audio|video))?|stop playback)\b",
    re.IGNORECASE,
)
NEXT_TRACK_PATTERN = re.compile(
    r"\b(?:next\s+(?:track|song)|skip(?:\s+(?:track|song))?)\b",
    re.IGNORECASE,
)
PREVIOUS_TRACK_PATTERN = re.compile(
    r"\b(?:(?:previous|last)\s+(?:track|song)|go to previous track)\b",
    re.IGNORECASE,
)
MUTE_AUDIO_PATTERN = re.compile(
    r"\b(?:mute(?:\s+(?:audio|volume|sound))?|turn mute on)\b",
    re.IGNORECASE,
)
UNMUTE_AUDIO_PATTERN = re.compile(
    r"\b(?:unmute(?:\s+(?:audio|volume|sound))?|turn mute off)\b",
    re.IGNORECASE,
)
VOLUME_UP_PATTERN = re.compile(
    r"\b(?:volume up|turn (?:the )?volume up|raise (?:the )?volume|increase (?:the )?volume|make it louder)\b",
    re.IGNORECASE,
)
VOLUME_DOWN_PATTERN = re.compile(
    r"\b(?:volume down|turn (?:the )?volume down|lower (?:the )?volume|decrease (?:the )?volume|make it quieter)\b",
    re.IGNORECASE,
)
SET_VOLUME_PERCENT_PATTERN = re.compile(
    r"\b(?:set\s+(?:the\s+)?volume\s+to|set\s+volume\s+to|volume)\s+([a-z0-9][a-z0-9\s-]{0,32})\s*(?:percent|%)\b",
    re.IGNORECASE,
)
BRIGHTNESS_UP_PATTERN = re.compile(
    r"\b(?:brightness up|turn (?:the )?brightness up|raise (?:the )?brightness|increase (?:the )?brightness)\b",
    re.IGNORECASE,
)
BRIGHTNESS_DOWN_PATTERN = re.compile(
    r"\b(?:brightness down|turn (?:the )?brightness down|lower (?:the )?brightness|decrease (?:the )?brightness)\b",
    re.IGNORECASE,
)
SET_BRIGHTNESS_PERCENT_PATTERN = re.compile(
    r"\b(?:set\s+(?:the\s+)?brightness\s+to|set\s+brightness\s+to|brightness)\s+([a-z0-9][a-z0-9\s-]{0,32})\s*(?:percent|%)\b",
    re.IGNORECASE,
)
BROWSER_BACK_PATTERN = re.compile(
    r"\b(?:go back|browser back|navigate back)\b",
    re.IGNORECASE,
)
BROWSER_FORWARD_PATTERN = re.compile(
    r"\b(?:go forward|browser forward|navigate forward)\b",
    re.IGNORECASE,
)
BROWSER_RELOAD_PATTERN = re.compile(
    r"\b(?:reload(?: (?:this|the|current) page)?|refresh(?: (?:this|the|current) page)?|refresh browser)\b",
    re.IGNORECASE,
)


class ActionPlan(BaseModel):
    action_type: ActionType
    title: str
    summary: str
    app_name: Optional[str] = None
    bundle_id: Optional[str] = None
    value_percent: Optional[int] = None
    app_path: Optional[str] = None
    url: Optional[str] = None
    recipient: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    browser_app_name: Optional[str] = None
    url_target: Optional[Literal["current_tab", "system_open"]] = None
    target_label: Optional[str] = None
    target_role: Optional[str] = None
    ui_index: Optional[int] = None
    site: Optional[str] = None
    query: Optional[str] = None


class PendingActionReview(BaseModel):
    run_id: str
    action_type: ReviewedActionType
    title: str
    summary: str
    script: str
    language: Literal["applescript"] = "applescript"
    status: Literal["pending", "approved", "rejected", "error"] = "pending"
    error: Optional[str] = None


class ActionBuildResult(BaseModel):
    pending_review: Optional[PendingActionReview] = None
    auto_action: Optional[AutoActionPayload] = None


class ActionResolutionError(RuntimeError):
    pass


_PERCENT_UNITS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
}
_PERCENT_TENS = {
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
_PERCENT_ALLOWED_TOKENS = set(_PERCENT_UNITS) | set(_PERCENT_TENS) | {"hundred", "and"}


def _parse_percent_value(raw_value: str) -> Optional[int]:
    normalized = " ".join(str(raw_value or "").lower().replace("-", " ").split())
    if not normalized:
        return None

    digit_match = re.fullmatch(r"\d{1,3}", normalized)
    if digit_match:
        value = int(normalized)
        return value if 0 <= value <= 100 else None

    if normalized in {"hundred", "one hundred"}:
        return 100

    tokens = [token for token in normalized.split() if token != "and"]
    if not tokens or any(token not in _PERCENT_ALLOWED_TOKENS for token in tokens):
        return None

    if "hundred" in tokens:
        return 100 if tokens == ["one", "hundred"] else None

    if len(tokens) == 1:
        if tokens[0] in _PERCENT_UNITS:
            return _PERCENT_UNITS[tokens[0]]
        return _PERCENT_TENS.get(tokens[0])

    if len(tokens) == 2 and tokens[0] in _PERCENT_TENS and tokens[1] in _PERCENT_UNITS:
        return _PERCENT_TENS[tokens[0]] + _PERCENT_UNITS[tokens[1]]

    return None


def _extract_percent_value(pattern: re.Pattern[str], transcript: str) -> Optional[int]:
    match = pattern.search(transcript)
    if not match:
        return None
    return _parse_percent_value(match.group(1))


@dataclass(frozen=True)
class _MatchCandidate:
    candidate_id: str
    label: str
    aliases: tuple[str, ...]
    payload: Any


class ReviewedActionBuilder:
    def __init__(
        self,
        *,
        provider: str,
        model: str,
        temperature: float,
        app_catalog: Optional[AppCatalog] = None,
        ui_automation: Optional[UIAutomationService] = None,
    ):
        self.provider = provider
        self.model = model
        self.temperature = temperature
        self.app_catalog = app_catalog or AppCatalog()
        self.ui_automation = ui_automation or UIAutomationService()

    def build(
        self,
        *,
        transcript: str,
        context: dict[str, Any],
        skill: SkillDefinition,
    ) -> ActionBuildResult:
        plan = self._build_local_plan(transcript, context)
        if plan is None and self.provider.lower() != "lmstudio":
            plan = self._build_llm_plan(transcript, context, skill)
        if plan is None:
            raise RuntimeError("Smart Mode could not convert that request into a safe desktop action.")

        return self._build_result_from_plan(plan)

    def build_planned_step(
        self,
        *,
        planned_step: Any,
        context: dict[str, Any],
        skill: SkillDefinition,
    ) -> ActionBuildResult:
        plan = self._build_structured_plan(planned_step, context=context)
        if plan is None:
            plan = self._build_local_plan(str(getattr(planned_step, "request", "") or "").strip(), context)
        if plan is None and self.provider.lower() != "lmstudio":
            plan = self._build_llm_plan(str(getattr(planned_step, "request", "") or "").strip(), context, skill)
        if plan is None:
            raise RuntimeError("Smart Mode could not convert that request into a safe desktop action.")

        return self._build_result_from_plan(plan)

    def _build_result_from_plan(self, plan: ActionPlan) -> ActionBuildResult:
        if plan.action_type in AUTO_ACTION_TYPES:
            return ActionBuildResult(
                auto_action=AutoActionPayload(
                    action_type=plan.action_type,
                    title=plan.title.strip(),
                    summary=plan.summary.strip(),
                    app_name=plan.app_name or "Unknown",
                    bundle_id=plan.bundle_id,
                    value_percent=plan.value_percent,
                    target_label=plan.target_label,
                    target_role=plan.target_role,
                    ui_index=plan.ui_index,
                )
            )

        return ActionBuildResult(
            pending_review=PendingActionReview(
                run_id=str(uuid4()),
                action_type=plan.action_type,
                title=plan.title.strip(),
                summary=plan.summary.strip(),
                script=render_applescript(plan),
            )
        )

    def _build_structured_plan(self, planned_step: Any, *, context: dict[str, Any]) -> Optional[ActionPlan]:
        action_type = str(getattr(planned_step, "action_type", "") or "").strip()
        if not action_type:
            return None

        title = str(getattr(planned_step, "title", "") or "").strip()
        summary = str(getattr(planned_step, "summary", "") or "").strip()
        app_name = str(getattr(planned_step, "app_name", "") or "").strip() or None
        browser_app_name = str(getattr(planned_step, "browser_app_name", "") or "").strip() or None
        url = str(getattr(planned_step, "url", "") or "").strip() or None
        site = str(getattr(planned_step, "site", "") or "").strip() or None
        query = str(getattr(planned_step, "query", "") or "").strip() or None

        if action_type == "open_app":
            if not app_name:
                raise ActionResolutionError("The planned app-open step did not include a target app.")
            return self._resolve_app_action(title or f"open {app_name}", app_name)

        if action_type == "open_url":
            if not url:
                raise ActionResolutionError("The planned browser navigation step did not include a URL.")
            target_browser = browser_app_name or app_name
            if target_browser:
                if target_browser not in SUPPORTED_BROWSER_APPS:
                    raise ActionResolutionError(
                        f"{target_browser} is not supported for reviewed browser navigation. Use Safari, Chrome, Arc, Brave, or Edge."
                    )
                label = target_browser
                return ActionPlan(
                    action_type="open_url",
                    title=title or "Open URL",
                    summary=summary or f"Open {url} in {label}.",
                    url=url,
                    browser_app_name=label,
                    url_target="current_tab",
                    app_name=label,
                )
            return ActionPlan(
                action_type="open_url",
                title=title or "Open URL",
                summary=summary or f"Open {url} in the default browser.",
                url=url,
                url_target="system_open",
            )

        if action_type in {"youtube_open_first_result", "youtube_ensure_playing"}:
            target_browser = browser_app_name or app_name
            if not target_browser:
                raise ActionResolutionError("The planned YouTube browser step did not include a target browser.")
            if target_browser not in SUPPORTED_YOUTUBE_BROWSER_APPS:
                raise ActionResolutionError(
                    f"YouTube playback automation currently supports Google Chrome, Brave Browser, and Microsoft Edge. {target_browser} is not supported yet."
                )
            if site and site.lower() != "youtube":
                raise ActionResolutionError("The planned browser-media step was not scoped to YouTube.")
            return ActionPlan(
                action_type=action_type,  # type: ignore[arg-type]
                title=title or ("Open First Result" if action_type == "youtube_open_first_result" else "Ensure Playback"),
                summary=summary or (
                    "Open the first YouTube search result."
                    if action_type == "youtube_open_first_result"
                    else "Start playback on the current YouTube video only if it is paused."
                ),
                app_name=target_browser,
                browser_app_name=target_browser,
                site="youtube",
                query=query,
            )

        return None

    def _build_local_plan(self, transcript: str, context: dict[str, Any]) -> Optional[ActionPlan]:
        normalized = normalize_imperative_phrase(transcript)
        if not normalized:
            return None

        url = _extract_url_request(normalized)
        if url:
            browser_app_name = _resolve_supported_browser_app(context)
            browser_mode = "current_tab" if browser_app_name else "system_open"
            logger.info(
                "[ActionExecution] Resolved URL action request=%r url=%s browser_mode=%s frontmost_app=%s",
                normalized,
                url,
                browser_mode,
                context.get("app_name"),
            )
            return ActionPlan(
                action_type="open_url",
                title="Navigate Browser" if browser_app_name else "Open URL",
                summary=(
                    f"Navigate the current {browser_app_name} tab to {url}."
                    if browser_app_name
                    else f"Open {url} in the default browser."
                ),
                url=url,
                browser_app_name=browser_app_name,
                url_target="current_tab" if browser_app_name else "system_open",
            )

        if MAIL_INTENT_PATTERN.search(normalized):
            recipient = None
            recipient_match = MAIL_RECIPIENT_PATTERN.search(normalized)
            if recipient_match:
                recipient = recipient_match.group(1).strip().rstrip(".,")
            subject_match = MAIL_SUBJECT_PATTERN.search(normalized)
            body_match = MAIL_BODY_PATTERN.search(normalized)
            screen_context = str(context.get("screen_context") or "").strip()
            body = body_match.group(1).strip() if body_match else ""
            if not body and screen_context:
                body = screen_context
            if recipient or body:
                subject = subject_match.group(1).strip().rstrip(".,") if subject_match else None
                summary = f"Open Mail with a draft{f' to {recipient}' if recipient else ''}."
                if subject:
                    summary = f"{summary} Subject: {subject}."
                logger.info("[ActionExecution] Resolved Mail draft request=%r recipient=%r", normalized, recipient)
                return ActionPlan(
                    action_type="mail_draft",
                    title="Draft Email",
                    summary=summary,
                    recipient=recipient,
                    subject=subject,
                    body=body or "Draft created from Smart Mode.",
                )

        if PLAY_PAUSE_PATTERN.search(normalized):
            return self._resolve_media_transport_plan(
                action_type="play_pause",
                title="Play or Pause",
                summary_template="Play or pause the current system playback.",
                context=context,
            )

        if PAUSE_PLAYBACK_PATTERN.search(normalized):
            return self._resolve_pause_playback_plan(context)

        if NEXT_TRACK_PATTERN.search(normalized):
            return self._resolve_media_transport_plan(
                action_type="next_track",
                title="Next Track",
                summary_template="Skip to the next system track.",
                context=context,
            )

        if PREVIOUS_TRACK_PATTERN.search(normalized):
            return self._resolve_media_transport_plan(
                action_type="previous_track",
                title="Previous Track",
                summary_template="Go to the previous system track.",
                context=context,
            )

        exact_volume = _extract_percent_value(SET_VOLUME_PERCENT_PATTERN, normalized)
        if exact_volume is not None:
            return ActionPlan(
                action_type="set_volume_percent",
                title="Set Volume",
                summary=f"Set the system output volume to {exact_volume}%.",
                app_name=str(context.get("app_name") or "").strip() or "System",
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
                value_percent=exact_volume,
            )

        exact_brightness = _extract_percent_value(SET_BRIGHTNESS_PERCENT_PATTERN, normalized)
        if exact_brightness is not None:
            return ActionPlan(
                action_type="set_brightness_percent",
                title="Set Brightness",
                summary=f"Set the main display brightness to {exact_brightness}%.",
                app_name=str(context.get("app_name") or "").strip() or "System",
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
                value_percent=exact_brightness,
            )

        if UNMUTE_AUDIO_PATTERN.search(normalized):
            return ActionPlan(
                action_type="unmute_audio",
                title="Unmute Audio",
                summary="Unmute system audio output.",
                app_name=str(context.get("app_name") or "").strip() or "System",
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
            )

        if MUTE_AUDIO_PATTERN.search(normalized):
            return ActionPlan(
                action_type="mute_audio",
                title="Mute Audio",
                summary="Mute system audio output.",
                app_name=str(context.get("app_name") or "").strip() or "System",
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
            )

        if VOLUME_UP_PATTERN.search(normalized):
            return ActionPlan(
                action_type="volume_up",
                title="Volume Up",
                summary="Increase the system output volume by one safe step.",
                app_name=str(context.get("app_name") or "").strip() or "System",
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
            )

        if VOLUME_DOWN_PATTERN.search(normalized):
            return ActionPlan(
                action_type="volume_down",
                title="Volume Down",
                summary="Decrease the system output volume by one safe step.",
                app_name=str(context.get("app_name") or "").strip() or "System",
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
            )

        if BRIGHTNESS_UP_PATTERN.search(normalized):
            return ActionPlan(
                action_type="brightness_up",
                title="Brightness Up",
                summary="Increase the main display brightness by one safe step.",
                app_name=str(context.get("app_name") or "").strip() or "System",
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
            )

        if BRIGHTNESS_DOWN_PATTERN.search(normalized):
            return ActionPlan(
                action_type="brightness_down",
                title="Brightness Down",
                summary="Decrease the main display brightness by one safe step.",
                app_name=str(context.get("app_name") or "").strip() or "System",
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
            )

        if BROWSER_BACK_PATTERN.search(normalized):
            return self._resolve_browser_transport_plan(
                action_type="browser_back",
                title="Browser Back",
                summary_template="Go back in {app_name}.",
                context=context,
            )

        if BROWSER_FORWARD_PATTERN.search(normalized):
            return self._resolve_browser_transport_plan(
                action_type="browser_forward",
                title="Browser Forward",
                summary_template="Go forward in {app_name}.",
                context=context,
            )

        if BROWSER_RELOAD_PATTERN.search(normalized):
            return self._resolve_browser_transport_plan(
                action_type="browser_reload",
                title="Reload Page",
                summary_template="Reload the current page in {app_name}.",
                context=context,
            )

        if self._is_browser_address_bar_request(normalized, context):
            browser_app_name = _resolve_supported_browser_app(context)
            if browser_app_name:
                return ActionPlan(
                    action_type="focus_browser_address_bar",
                    title="Focus Address Bar",
                    summary=f"Focus the address bar in {browser_app_name}.",
                    app_name=browser_app_name,
                    bundle_id=str(context.get("bundle_id") or "").strip() or None,
                    target_label="Address bar",
                    target_role="browser_chrome",
                    ui_index=0,
                )

        if self._is_primary_chat_input_request(normalized, context):
            host = _resolve_ai_chat_site(context)
            host_label = AI_CHAT_HOST_LABELS.get(host or "", str(context.get("app_name") or "the current site").strip() or "the current site")
            return ActionPlan(
                action_type="focus_primary_chat_input",
                title="Focus Chat Input",
                summary=f"Focus the main chat input in {host_label}.",
                app_name=str(context.get("app_name") or "").strip() or host_label,
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
                target_label="Chat input",
                target_role="page_content",
                ui_index=0,
            )

        if self._is_primary_chat_send_request(normalized, context):
            host = _resolve_ai_chat_site(context)
            host_label = AI_CHAT_HOST_LABELS.get(host or "", str(context.get("app_name") or "the current site").strip() or "the current site")
            return ActionPlan(
                action_type="press_primary_chat_send",
                title="Press Send",
                summary=f"Press the main send button in {host_label}.",
                app_name=str(context.get("app_name") or "").strip() or host_label,
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
                target_label="Send",
                target_role="page_content",
                ui_index=0,
            )

        focus_target = self._extract_field_target(normalized)
        if focus_target:
            return self._resolve_frontmost_ui_action(
                transcript=normalized,
                target_phrase=focus_target,
                action_type="focus_field",
                context=context,
            )

        button_target = self._extract_button_target(normalized)
        if button_target:
            return self._resolve_frontmost_ui_action(
                transcript=normalized,
                target_phrase=button_target,
                action_type="press_button",
                context=context,
            )

        app_match = OPEN_APP_PATTERN.search(normalized)
        if app_match:
            app_query = _clean_app_query(app_match.group(1))
            if len(app_query.split()) <= 8:
                return self._resolve_app_action(normalized, app_query)

        return None

    def _resolve_app_action(self, transcript: str, app_query: str) -> ActionPlan:
        apps = self.app_catalog.list_apps()
        match, method, suggestions = self._match_candidate(
            query=app_query,
            candidates=[
                _MatchCandidate(
                    candidate_id=record.bundle_id or record.app_path,
                    label=record.display_name,
                    aliases=record.aliases,
                    payload=record,
                )
                for record in apps
            ],
            candidate_kind="application",
        )
        if match is None:
            suggestion_text = f" Try: {', '.join(suggestions)}." if suggestions else ""
            logger.warning("[ActionExecution] Unable to resolve app request=%r suggestions=%s", app_query, suggestions)
            raise ActionResolutionError(f"Couldn't find an installed app matching '{app_query}'.{suggestion_text}")

        record: InstalledAppRecord = match.payload
        verb = self._extract_app_verb(transcript)
        title = "Switch App" if verb in {"switch to", "focus"} else "Open App"
        summary = (
            f"Bring {record.display_name} to the front."
            if verb in {"switch to", "focus"}
            else f"Open {record.display_name}."
        )
        logger.info(
            "[ActionExecution] Resolved app request=%r method=%s app=%s bundle_id=%s path=%s suggestions=%s",
            app_query,
            method,
            record.display_name,
            record.bundle_id,
            record.app_path,
            suggestions,
        )
        return ActionPlan(
            action_type="open_app",
            title=title,
            summary=summary,
            app_name=record.display_name,
            bundle_id=record.bundle_id,
            app_path=record.app_path,
        )

    def _resolve_browser_transport_plan(
        self,
        *,
        action_type: Literal["browser_back", "browser_forward", "browser_reload"],
        title: str,
        summary_template: str,
        context: dict[str, Any],
    ) -> ActionPlan:
        browser_app_name = _resolve_supported_browser_app(context)
        if browser_app_name is None:
            raise ActionResolutionError("Browser navigation actions only run in Safari, Chrome, Arc, Brave, or Edge.")
        return ActionPlan(
            action_type=action_type,
            title=title,
            summary=summary_template.format(app_name=browser_app_name),
            app_name=browser_app_name,
            bundle_id=str(context.get("bundle_id") or "").strip() or None,
        )

    def _resolve_media_transport_plan(
        self,
        *,
        action_type: Literal["play_pause", "next_track", "previous_track"],
        title: str,
        summary_template: str,
        context: dict[str, Any],
    ) -> ActionPlan:
        app_name = str(context.get("app_name") or "").strip() or "System"
        return ActionPlan(
            action_type=action_type,
            title=title,
            summary=summary_template,
            app_name=app_name,
            bundle_id=str(context.get("bundle_id") or "").strip() or None,
        )

    def _resolve_pause_playback_plan(self, context: dict[str, Any]) -> ActionPlan:
        app_name = str(context.get("app_name") or "").strip()
        if app_name in SUPPORTED_MEDIA_APPS:
            return ActionPlan(
                action_type="pause_playback",
                title="Pause Playback",
                summary=f"Pause playback in {app_name}.",
                app_name=app_name,
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
            )

        browser_app_name = _resolve_supported_browser_app(context)
        if browser_app_name is not None:
            return ActionPlan(
                action_type="pause_playback",
                title="Pause Playback",
                summary=f"Pause the current media element in {browser_app_name}.",
                app_name=browser_app_name,
                bundle_id=str(context.get("bundle_id") or "").strip() or None,
            )

        return ActionPlan(
            action_type="pause_playback",
            title="Pause Playback",
            summary="Pause playback using the current app when possible, otherwise use the global system pause control.",
            app_name=app_name or "System",
            bundle_id=str(context.get("bundle_id") or "").strip() or None,
        )

    def _resolve_frontmost_ui_action(
        self,
        *,
        transcript: str,
        target_phrase: str,
        action_type: Literal["focus_field", "press_button"],
        context: dict[str, Any],
    ) -> ActionPlan:
        try:
            snapshot = self.ui_automation.capture_frontmost_ui_snapshot()
        except subprocess.TimeoutExpired as exc:
            logger.warning("[ActionExecution] UI snapshot timed out for request=%r detail=%s", transcript, exc)
            raise ActionResolutionError(
                "The frontmost app took too long to expose usable UI controls. Try a more specific control name, or simplify the current page before retrying."
            ) from exc
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
            classification = classify_ui_automation_error(detail)
            logger.warning("[ActionExecution] UI snapshot failed class=%s detail=%s", classification, detail)
            if classification == "permission":
                raise ActionResolutionError("Accessibility access is required before Smart can focus fields or press buttons.") from exc
            if classification == "script_compile":
                raise ActionResolutionError("Local UI automation failed to compile its AppleScript helpers. This is an internal automation bug, not a missing page control.") from exc
            raise ActionResolutionError("The frontmost app did not expose usable UI controls for automation.") from exc
        except Exception as exc:
            logger.warning("[ActionExecution] UI snapshot failed detail=%s", exc)
            raise ActionResolutionError("The frontmost app did not expose usable UI controls for automation.") from exc

        target_roles = TEXT_FIELD_ROLES if action_type == "focus_field" else BUTTON_ROLES
        candidates = [
            candidate
            for candidate in snapshot.elements
            if candidate.role in target_roles
        ]
        if not candidates:
            logger.warning(
                "[ActionExecution] No UI candidates action=%s app=%s transcript=%r",
                action_type,
                snapshot.app_name,
                transcript,
            )
            if action_type == "focus_field":
                raise ActionResolutionError(f"{snapshot.app_name} does not expose named text fields for Smart to focus.")
            raise ActionResolutionError(f"{snapshot.app_name} does not expose named buttons for Smart to press.")

        source_preference = self._resolve_source_preference(
            transcript=transcript,
            target_phrase=target_phrase,
            action_type=action_type,
            snapshot=snapshot,
            context=context,
        )
        candidate_pool = candidates
        if source_preference == "page_content":
            page_candidates = [candidate for candidate in candidates if candidate.source_class == "page_content"]
            if page_candidates:
                candidate_pool = page_candidates
            elif snapshot.app_name in SUPPORTED_BROWSER_APPS and action_type == "press_button":
                logger.warning(
                    "[ActionExecution] Browser page-control request=%r parsed_target=%r app=%s found_only_browser_chrome=%s",
                    transcript,
                    target_phrase,
                    snapshot.app_name,
                    [candidate.display_label for candidate in candidates[:5]],
                )
                raise ActionResolutionError(
                    f"Couldn't find a page control matching '{target_phrase}' in {snapshot.app_name}. I only found browser toolbar or tab-strip controls."
                )

        match, method, suggestions = self._match_candidate(
            query=target_phrase,
            candidates=[
                _MatchCandidate(
                    candidate_id=str(candidate.ui_index),
                    label=candidate.display_label,
                    aliases=self._build_ui_aliases(candidate, context=context),
                    payload=candidate,
                )
                for candidate in candidate_pool
            ],
            candidate_kind="ui element",
            source_preference=source_preference,
        )
        if match is None:
            label = "field" if action_type == "focus_field" else "button"
            suggestion_text = f" Try: {', '.join(suggestions)}." if suggestions else ""
            logger.warning(
                "[ActionExecution] Unable to resolve %s raw_request=%r parsed_target=%r app=%s source_preference=%s suggestions=%s",
                label,
                transcript,
                target_phrase,
                snapshot.app_name,
                source_preference,
                suggestions,
            )
            raise ActionResolutionError(
                f"Couldn't find a {label} matching '{target_phrase}' in {snapshot.app_name}.{suggestion_text}"
            )

        candidate: UIElementCandidate = match.payload
        logger.info(
            "[ActionExecution] Resolved UI action=%s raw_request=%r parsed_target=%r method=%s app=%s target=%s role=%s source_class=%s source_preference=%s suggestions=%s",
            action_type,
            transcript,
            target_phrase,
            method,
            snapshot.app_name,
            candidate.display_label,
            candidate.role,
            candidate.source_class,
            source_preference,
            suggestions,
        )
        summary = (
            f"Focus {candidate.display_label} in {snapshot.app_name}."
            if action_type == "focus_field"
            else f"Press {candidate.display_label} in {snapshot.app_name}."
        )
        return ActionPlan(
            action_type=action_type,
            title="Focus Field" if action_type == "focus_field" else "Press Button",
            summary=summary,
            app_name=snapshot.app_name,
            bundle_id=snapshot.bundle_id,
            target_label=candidate.display_label,
            target_role=candidate.role,
            ui_index=candidate.ui_index,
        )

    def _match_candidate(
        self,
        *,
        query: str,
        candidates: list[_MatchCandidate],
        candidate_kind: str,
        source_preference: Optional[str] = None,
    ) -> tuple[Optional[_MatchCandidate], str, list[str]]:
        normalized_query = normalize_app_match_text(query)
        if not normalized_query or not candidates:
            return None, "none", []

        scored: list[tuple[float, _MatchCandidate]] = []
        for candidate in candidates:
            score = self._score_candidate(normalized_query, candidate, source_preference=source_preference)
            if score > 0:
                scored.append((score, candidate))

        scored.sort(key=lambda item: (-item[0], item[1].label.lower()))
        suggestions = [candidate.label for _, candidate in scored[:3]]
        if not scored:
            return None, "none", suggestions

        top_score, top_candidate = scored[0]
        second_score = scored[1][0] if len(scored) > 1 else 0.0
        score_gap = top_score - second_score
        alias_hit = normalized_query in top_candidate.aliases
        if alias_hit or top_score >= 0.93:
            return top_candidate, "exact", suggestions
        if top_score >= 0.72 and score_gap >= 0.08:
            return top_candidate, "fuzzy", suggestions

        close_candidates = [candidate for score, candidate in scored[:5] if (top_score - score) <= 0.08 and score >= 0.6]
        if len(close_candidates) <= 1 and top_score >= 0.62:
            return top_candidate, "fuzzy", suggestions
        if len(close_candidates) >= 2 and self.provider.lower() != "lmstudio":
            llm_choice = self._choose_candidate_with_llm(
                query=query,
                candidate_kind=candidate_kind,
                candidates=close_candidates,
            )
            if llm_choice is not None:
                return llm_choice, "llm_tiebreak", [candidate.label for candidate in close_candidates]
        return None, "ambiguous", suggestions

    def _score_candidate(
        self,
        normalized_query: str,
        candidate: _MatchCandidate,
        *,
        source_preference: Optional[str] = None,
    ) -> float:
        best_score = 0.0
        query_token_list = normalized_query.split()
        query_tokens = set(query_token_list)
        compact_query = normalized_query.replace(" ", "")
        source_bonus = 0.0
        source_class = getattr(candidate.payload, "source_class", None)
        if source_preference == "page_content":
            if source_class == "page_content":
                source_bonus = 0.08
            elif source_class == "browser_chrome":
                source_bonus = -0.06
        elif source_preference == "browser_chrome":
            if source_class == "browser_chrome":
                source_bonus = 0.08
            elif source_class == "page_content":
                source_bonus = -0.04

        for alias in candidate.aliases:
            if not alias:
                continue
            compact_alias = alias.replace(" ", "")
            alias_token_list = alias.split()
            alias_tokens = set(alias_token_list)
            if normalized_query == alias:
                return 1.0
            contains_bonus = 0.12 if normalized_query in alias or alias in normalized_query else 0.0
            token_overlap = len(query_tokens & alias_tokens) / max(len(query_tokens), len(alias_tokens), 1)
            sequence_ratio = max(
                SequenceMatcher(None, normalized_query, alias).ratio(),
                SequenceMatcher(None, compact_query, compact_alias).ratio(),
            )
            token_bonus = 0.12 if query_tokens and query_tokens.issubset(alias_tokens) else 0.0
            first_token_bonus = (
                0.14
                if query_token_list and alias_token_list and query_token_list[0] == alias_token_list[0]
                else 0.0
            )
            prefix_bonus = (
                0.08
                if query_token_list
                and alias_token_list
                and any(
                    query_token_list[0].startswith(alias_token)
                    or alias_token.startswith(query_token_list[0])
                    for alias_token in alias_token_list
                )
                else 0.0
            )
            mismatch_penalty = 0.08 if token_overlap == 0 and first_token_bonus == 0.0 and prefix_bonus == 0.0 else 0.0
            score = min(
                1.0,
                max(
                    0.0,
                    sequence_ratio * 0.56
                    + token_overlap * 0.22
                    + token_bonus
                    + contains_bonus
                    + first_token_bonus
                    + prefix_bonus
                    + source_bonus
                    - mismatch_penalty,
                ),
            )
            best_score = max(best_score, score)

        return best_score

    def _choose_candidate_with_llm(
        self,
        *,
        query: str,
        candidate_kind: str,
        candidates: list[_MatchCandidate],
    ) -> Optional[_MatchCandidate]:
        if self.provider.lower() == "lmstudio":
            return None
        try:
            from langchain_core.prompts import ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate

            llm = LLMFactory.get_llm(
                self.provider,
                self.model,
                temperature=0.0,
                timeout=4.0,
                max_retries=0,
                max_tokens=90,
            )
            prompt = ChatPromptTemplate.from_messages([
                SystemMessagePromptTemplate.from_template(
                    """Choose the best {candidate_kind} candidate for the user's request.

Return strict JSON only in this shape:
{"choice_id":"candidate-id"} or {"choice_id":null}

Rules:
- Pick only from the provided candidate ids.
- Return null when the request is still ambiguous.
- Do not include explanation or markdown.
"""
                ),
                HumanMessagePromptTemplate.from_template(
                    """Request:
{query}

Candidates:
{candidate_json}
"""
                ),
            ])
            candidate_payload = [
                {
                    "id": candidate.candidate_id,
                    "label": candidate.label,
                    "aliases": list(candidate.aliases)[:4],
                }
                for candidate in candidates
            ]
            chain = prompt | llm
            response = chain.invoke({
                "candidate_kind": candidate_kind,
                "query": query,
                "candidate_json": json.dumps(candidate_payload, ensure_ascii=True),
            })
            raw = str(response.content or "").strip()
            if raw.startswith("```"):
                lines = raw.splitlines()
                if len(lines) >= 3:
                    raw = "\n".join(lines[1:-1]).strip()
            parsed = json.loads(raw)
            choice_id = parsed.get("choice_id")
            if not isinstance(choice_id, str) or not choice_id.strip():
                return None
            for candidate in candidates:
                if candidate.candidate_id == choice_id:
                    logger.info(
                        "[ActionExecution] LLM tie-break chose %s candidate=%s for request=%r",
                        candidate_kind,
                        candidate.label,
                        query,
                    )
                    return candidate
        except Exception as exc:
            logger.warning("[ActionExecution] LLM tie-break failed for %s request=%r: %s", candidate_kind, query, exc)
        return None

    def _is_browser_address_bar_request(self, transcript: str, context: dict[str, Any]) -> bool:
        if _resolve_supported_browser_app(context) is None:
            return False
        return bool(BROWSER_ADDRESS_BAR_PATTERN.search(transcript))

    def _is_primary_chat_input_request(self, transcript: str, context: dict[str, Any]) -> bool:
        return _resolve_ai_chat_site(context) is not None and bool(PRIMARY_CHAT_INPUT_PATTERN.search(transcript))

    def _is_primary_chat_send_request(self, transcript: str, context: dict[str, Any]) -> bool:
        return _resolve_ai_chat_site(context) is not None and bool(PRIMARY_CHAT_SEND_PATTERN.search(transcript))

    def _build_ui_aliases(self, candidate: UIElementCandidate, *, context: dict[str, Any]) -> tuple[str, ...]:
        alias_values = {
            candidate.display_label,
            candidate.label or "",
            candidate.description or "",
            candidate.placeholder or "",
            candidate.value or "",
            candidate.role_description or "",
        }
        if candidate.role in TEXT_FIELD_ROLES:
            alias_values.update(self._build_text_field_aliases(candidate, context=context))
        return tuple(sorted({
            normalized
            for alias in alias_values
            for normalized in (normalize_app_match_text(alias),)
            if normalized
        }))

    def _extract_field_target(self, transcript: str) -> Optional[str]:
        match = FOCUS_FIELD_PATTERN.search(transcript)
        if not match:
            return None
        target = _clean_target_phrase(match.group(1))
        if not target:
            return None
        lowered_target = target.lower()
        if not any(
            lowered_target == noun
            or lowered_target.endswith(f" {noun}")
            or f" {noun} " in f" {lowered_target} "
            for noun in FIELD_NOUNS
        ):
            return None
        return target or None

    def _extract_button_target(self, transcript: str) -> Optional[str]:
        match = PRESS_BUTTON_PATTERN.search(transcript)
        if not match:
            return None
        target = _clean_target_phrase(match.group(1))
        target = TRAILING_CONTROL_SUFFIX_PATTERN.sub("", target).strip()
        return target or None

    def _resolve_source_preference(
        self,
        *,
        transcript: str,
        target_phrase: str,
        action_type: Literal["focus_field", "press_button"],
        snapshot,
        context: dict[str, Any],
    ) -> Optional[str]:
        app_name = snapshot.app_name or str(context.get("app_name") or "")
        if app_name not in SUPPORTED_BROWSER_APPS:
            return None

        lowered = f"{transcript} {target_phrase}".lower()
        if action_type == "press_button":
            return "page_content"

        if any(token in lowered for token in ("address", "address bar", "url", "omnibox", "tab")):
            return "browser_chrome"
        if any(token in lowered for token in ("page", "current page", "this page", "message", "compose", "comment", "reply", "form", "chat", "prompt", "input")):
            return "page_content"
        return None

    def _build_text_field_aliases(self, candidate: UIElementCandidate, *, context: dict[str, Any]) -> set[str]:
        alias_values: set[str] = {
            "field",
            "input",
            "input box",
            "text box",
            "text field",
        }

        if candidate.role == "AXSearchField":
            alias_values.update({"search", "search field", "search box", "search bar"})
        if candidate.role in {"AXTextField", "AXTextArea", "AXComboBox"}:
            alias_values.update({"message field", "message box", "composer"})

        descriptive_values = (
            candidate.label,
            candidate.description,
            candidate.placeholder,
            candidate.value,
            candidate.role_description,
        )
        for raw_value in descriptive_values:
            normalized = normalize_app_match_text(raw_value)
            if not normalized:
                continue
            alias_values.add(normalized)
            alias_values.add(f"{normalized} field")
            alias_values.add(f"{normalized} input")
            alias_values.add(f"{normalized} input box")
            alias_values.add(f"{normalized} box")

        ai_chat_host = _resolve_ai_chat_site(context)
        if ai_chat_host and candidate.source_class == "page_content":
            alias_values.update({
                "chat input",
                "chat input box",
                "prompt box",
                "prompt input",
                "message box",
                "message field",
                "reply box",
                "chat box",
                "composer",
                "input box",
            })
            for site_alias in AI_CHAT_HOST_ALIASES[ai_chat_host]:
                alias_values.update({
                    f"{site_alias} input",
                    f"{site_alias} input box",
                    f"{site_alias} prompt box",
                    f"{site_alias} chat input",
                    f"input box of {site_alias}",
                    f"prompt box of {site_alias}",
                })

        return alias_values

    def _extract_app_verb(self, transcript: str) -> str:
        lowered = normalize_imperative_phrase(transcript).lower()
        for verb in sorted(OPEN_APP_VERBS, key=len, reverse=True):
            if lowered.startswith(verb):
                return verb
        return "open"

    def _build_llm_plan(self, transcript: str, context: dict[str, Any], skill: SkillDefinition) -> Optional[ActionPlan]:
        if self.provider.lower() == "lmstudio":
            return None
        from langchain_core.prompts import ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate

        llm = LLMFactory.get_llm(
            self.provider,
            self.model,
            min(self.temperature, 0.1),
            timeout=12.0,
            max_retries=0,
            max_tokens=420,
        )
        prompt = ChatPromptTemplate.from_messages([
            SystemMessagePromptTemplate.from_template(
                """{system_instruction}

Return strict JSON only with keys:
- action_type: one of open_app, open_url, mail_draft
- title: short review title
- summary: one sentence describing what will happen
- app_name: string or null
- url: string or null
- recipient: string or null
- subject: string or null
- body: string or null

Rules:
- Only choose allowlisted reviewed actions: open_app, open_url, mail_draft.
- Never send email or messages.
- Do not generate keyboard automation, shell commands, or arbitrary AppleScript.
- For mail_draft, produce a subject and body when they can be inferred.
- Use screen context only when it directly helps with the requested action.
"""
            ),
            HumanMessagePromptTemplate.from_template(
                """Transcript:
{transcript}

Relevant context:
{context_json}
"""
            ),
        ])
        chain = prompt | llm
        response = chain.invoke({
            "system_instruction": skill.prompt,
            "transcript": transcript,
            "context_json": json.dumps({
                "app_name": context.get("app_name"),
                "window_title": context.get("window_title"),
                "url_host": context.get("url_host"),
                "screen_context": context.get("screen_context"),
            }, ensure_ascii=True, sort_keys=True),
        })
        raw = str(response.content or "").strip()
        if raw.startswith("```"):
            lines = raw.splitlines()
            if len(lines) >= 3:
                raw = "\n".join(lines[1:-1]).strip()
        try:
            parsed = ActionPlan.model_validate(json.loads(raw))
            if parsed.action_type not in {"open_app", "open_url", "mail_draft"}:
                return None
            if parsed.action_type == "open_app" and parsed.app_name:
                return self._resolve_app_action(transcript, parsed.app_name)
            return parsed
        except Exception as exc:
            logger.warning("Reviewed action LLM returned invalid JSON: %s", exc)
            return None


def render_applescript(plan: ActionPlan) -> str:
    if plan.action_type == "open_app":
        if plan.bundle_id:
            bundle_id = escape_applescript_string(plan.bundle_id)
            return "\n".join([
                f'tell application id "{bundle_id}"',
                'reopen',
                'activate',
                'end tell',
            ])
        app_name = escape_applescript_string(plan.app_name or "")
        return "\n".join([
            f'tell application "{app_name}"',
            'reopen',
            'activate',
            'end tell',
        ])

    if plan.action_type == "open_url":
        url = escape_applescript_string(plan.url or "")
        if plan.url_target == "current_tab" and plan.browser_app_name:
            browser_name = escape_applescript_string(plan.browser_app_name)
            if plan.browser_app_name == "Safari":
                return "\n".join([
                    f'tell application "{browser_name}"',
                    'activate',
                    'if (count of windows) = 0 then make new document',
                    f'set URL of current tab of front window to "{url}"',
                    'end tell',
                ])
            if plan.browser_app_name in CHROMIUM_BROWSER_APPS:
                return "\n".join([
                    f'tell application "{browser_name}"',
                    'activate',
                    'if (count of windows) = 0 then make new window',
                    f'set URL of active tab of front window to "{url}"',
                    'end tell',
                ])
        return f'open location "{url}"'

    if plan.action_type == "youtube_open_first_result":
        browser_name = escape_applescript_string(plan.browser_app_name or plan.app_name or "")
        javascript = escape_applescript_string(
            "(() => {"
            " if (!location.hostname.includes('youtube.com')) { throw new Error('Not on YouTube.'); }"
            " const firstResult = document.querySelector('ytd-video-renderer a#video-title, ytd-rich-item-renderer a#video-title');"
            " if (!firstResult) { throw new Error('No YouTube search result available.'); }"
            " firstResult.click();"
            " return 'opened-first-result';"
            "})();"
        )
        return "\n".join([
            f'tell application "{browser_name}"',
            'activate',
            f'if (count of windows) = 0 then error "{browser_name} does not have an open browser window."',
            f'execute front window\'s active tab javascript "{javascript}"',
            'end tell',
        ])

    if plan.action_type == "youtube_ensure_playing":
        browser_name = escape_applescript_string(plan.browser_app_name or plan.app_name or "")
        javascript = escape_applescript_string(
            "(() => {"
            " if (!location.hostname.includes('youtube.com')) { throw new Error('Not on YouTube.'); }"
            " const video = document.querySelector('video');"
            " if (!video) { throw new Error('No YouTube video is open.'); }"
            " if (!video.paused) { return 'already-playing'; }"
            " const playButton = document.querySelector('.ytp-play-button');"
            " const ariaLabel = (playButton?.getAttribute('aria-label') || '').toLowerCase();"
            " if (playButton && (!ariaLabel || ariaLabel.includes('play'))) {"
            "   playButton.click();"
            "   return 'started-playing';"
            " }"
            " video.play();"
            " return 'started-playing';"
            "})();"
        )
        return "\n".join([
            f'tell application "{browser_name}"',
            'activate',
            f'if (count of windows) = 0 then error "{browser_name} does not have an open browser window."',
            f'execute front window\'s active tab javascript "{javascript}"',
            'end tell',
        ])

    recipient_line = ""
    if plan.recipient:
        recipient = escape_applescript_string(plan.recipient)
        recipient_line = (
            'tell newMessage\n'
            f'    make new to recipient at end of to recipients with properties {{address:"{recipient}"}}\n'
            'end tell'
        )
    subject = escape_applescript_string(plan.subject or "")
    body = escape_applescript_string(plan.body or "")
    return "\n".join([
        'tell application "Mail"',
        'set newMessage to make new outgoing message with properties {visible:true, subject:"' + subject + '", content:"' + body + '"}',
        recipient_line,
        'activate',
        'end tell',
    ]).strip()


def validate_reviewed_action(review: PendingActionReview) -> Optional[str]:
    return validate_reviewed_applescript(review.action_type, review.script)


def execute_reviewed_action(review: PendingActionReview) -> None:
    execute_reviewed_applescript(review.action_type, review.script)


def execute_auto_action(action: AutoActionPayload) -> None:
    if action.action_type in UI_AUTOMATION_ACTION_TYPES:
        if action.ui_index is None or not action.target_role:
            raise RuntimeError(f"Auto action '{action.action_type}' is missing required UI targeting metadata.")
        UIAutomationService().execute_auto_ui_action(
            action_type=action.action_type,
            ui_index=action.ui_index,
            expected_app_name=action.app_name,
            expected_bundle_id=action.bundle_id,
            expected_role=action.target_role,
        )
        return

    if action.action_type in {"browser_back", "browser_forward", "browser_reload"}:
        _execute_browser_transport_action(action)
        return

    if action.action_type in {"play_pause", "next_track", "previous_track"}:
        _execute_media_transport_action(action)
        return

    if action.action_type == "pause_playback":
        _execute_pause_playback_action(
            action,
            allow_global_fallback=_experimental_media_controls_enabled(),
        )
        return

    if action.action_type == "mute_audio":
        run_applescript_lines([
            "set volume with output muted",
        ])
        return

    if action.action_type == "unmute_audio":
        run_applescript_lines([
            "set volume without output muted",
        ])
        return

    if action.action_type == "volume_up":
        _execute_volume_step(+8)
        return

    if action.action_type == "volume_down":
        _execute_volume_step(-8)
        return

    if action.action_type == "set_volume_percent":
        if action.value_percent is None:
            raise RuntimeError("Set volume actions require an exact percent value.")
        _set_volume_percent(action.value_percent)
        return

    if action.action_type == "brightness_up":
        SystemControlService().brightness_up()
        return

    if action.action_type == "brightness_down":
        SystemControlService().brightness_down()
        return

    if action.action_type == "set_brightness_percent":
        if action.value_percent is None:
            raise RuntimeError("Set brightness actions require an exact percent value.")
        SystemControlService().set_brightness_percent(action.value_percent)
        return

    raise RuntimeError(f"Unsupported auto action '{action.action_type}'.")


def validate_planned_desktop_step(step: LocalTaskStep) -> Optional[str]:
    if step.kind != "desktop_action":
        return "The planned step is not a desktop action."

    if step.execution_mode == "reviewed":
        if not step.action_type or not step.script:
            return "The reviewed desktop step is missing action metadata."
        review = PendingActionReview(
            run_id=f"planned-step:{step.id}",
            action_type=step.action_type,  # type: ignore[arg-type]
            title=step.title,
            summary=step.summary,
            script=step.script,
            language="applescript",
        )
        return validate_reviewed_action(review)

    if step.execution_mode == "auto":
        try:
            _build_auto_action_from_step(step)
        except RuntimeError as exc:
            return str(exc).strip() or "The planned auto desktop step is invalid."
        return None

    return "The desktop step is missing an execution mode."


def execute_planned_desktop_step(step: LocalTaskStep) -> None:
    validation_error = validate_planned_desktop_step(step)
    if validation_error:
        raise RuntimeError(validation_error)

    if step.execution_mode == "reviewed":
        review = PendingActionReview(
            run_id=f"planned-step:{step.id}",
            action_type=step.action_type,  # type: ignore[arg-type]
            title=step.title,
            summary=step.summary,
            script=step.script or "",
            language="applescript",
        )
        execute_reviewed_action(review)
        return

    execute_auto_action(_build_auto_action_from_step(step))


def _build_auto_action_from_step(step: LocalTaskStep) -> AutoActionPayload:
    if step.kind != "desktop_action":
        raise RuntimeError("Only desktop-action steps can be executed as auto actions.")
    if not step.action_type:
        raise RuntimeError("The desktop step is missing an action type.")
    if not step.app_name:
        raise RuntimeError("The auto desktop step is missing its target app name.")
    return AutoActionPayload(
        action_type=step.action_type,  # type: ignore[arg-type]
        title=step.title,
        summary=step.summary,
        app_name=step.app_name,
        bundle_id=step.bundle_id,
        value_percent=step.value_percent,
        target_label=step.target_label,
        target_role=step.target_role,
        ui_index=step.ui_index,
    )


def _execute_volume_step(delta: int) -> None:
    run_applescript_lines([
        "set currentVolume to output volume of (get volume settings)",
        f"set nextVolume to currentVolume + ({delta})",
        "if nextVolume > 100 then set nextVolume to 100",
        "if nextVolume < 0 then set nextVolume to 0",
        "set volume output volume nextVolume",
    ])


def _set_volume_percent(value_percent: int) -> None:
    clamped_value = max(0, min(100, int(value_percent)))
    script_lines = [
        f"set targetVolume to {clamped_value}",
    ]
    if clamped_value > 0:
        script_lines.append("set volume without output muted")
    script_lines.append("set volume output volume targetVolume")
    run_applescript_lines(script_lines)


def _experimental_media_controls_enabled() -> bool:
    try:
        return bool(ConfigManager().get_config().actions.experimental_media_controls)
    except Exception:
        return False


def _execute_media_transport_action(action: AutoActionPayload) -> None:
    if action.action_type in EXPERIMENTAL_MEDIA_ACTION_TYPES and not _experimental_media_controls_enabled():
        raise RuntimeError("Experimental media controls are turned off in Advanced settings.")

    helper_error: Optional[Exception] = None
    try:
        SystemControlService().media_transport(action.action_type)
        return
    except SystemControlError as exc:
        helper_error = exc
        logger.warning(
            "[ActionExecution] Global media transport failed action=%s detail=%s",
            action.action_type,
            str(exc).strip() or exc,
        )

    app_name = str(action.app_name or "").strip()
    if app_name not in SUPPORTED_MEDIA_APPS:
        detail = str(helper_error).strip() if helper_error else ""
        raise RuntimeError(detail or "Playback controls are unavailable right now.")

    if action.action_type == "play_pause":
        command_line = "playpause"
    elif action.action_type == "next_track":
        command_line = "next track"
    elif action.action_type == "previous_track":
        command_line = "previous track"
    else:
        raise RuntimeError(f"Unsupported media action '{action.action_type}'.")

    escaped_app_name = escape_applescript_string(app_name)
    run_applescript_lines([
        f'if application "{escaped_app_name}" is not running then error "{escaped_app_name} is not running."',
        f'tell application "{escaped_app_name}"',
        f"    {command_line}",
        "end tell",
    ])


def _execute_pause_playback_action(
    action: AutoActionPayload,
    *,
    allow_global_fallback: bool = True,
) -> None:
    app_name = str(action.app_name or "").strip()
    if app_name in SUPPORTED_MEDIA_APPS:
        try:
            escaped_app_name = escape_applescript_string(app_name)
            run_applescript_lines([
                f'if application "{escaped_app_name}" is not running then error "{escaped_app_name} is not running."',
                f'tell application "{escaped_app_name}"',
                '    if player state is not playing then error "Nothing is playing right now."',
                "    pause",
                "end tell",
            ])
            return
        except Exception as exc:
            logger.warning(
                "[ActionExecution] App-aware pause failed app=%s detail=%s",
                app_name,
                str(exc).strip() or exc,
            )

    if app_name in SUPPORTED_BROWSER_APPS:
        try:
            paused_count = _execute_browser_javascript(
                app_name,
                "(() => { const media = Array.from(document.querySelectorAll('video, audio')).filter((node) => !node.paused && !node.ended); media.forEach((node) => node.pause()); return String(media.length); })();",
            )
            if paused_count not in {"", "0"}:
                return
            logger.warning(
                "[ActionExecution] Browser pause found no active media app=%s. Falling back to global pause.",
                app_name,
            )
        except Exception as exc:
            logger.warning(
                "[ActionExecution] Browser pause failed app=%s detail=%s",
                app_name,
                str(exc).strip() or exc,
            )

    if not allow_global_fallback:
        raise RuntimeError("Pause fallback is limited to app-aware media handling while experimental media controls are off.")

    try:
        SystemControlService().pause_playback()
        return
    except SystemControlError as exc:
        detail = str(exc).strip() or "Global pause is unavailable right now."
        raise RuntimeError(detail) from exc


def _execute_browser_transport_action(action: AutoActionPayload) -> None:
    browser_app_name = str(action.app_name or "").strip()
    if browser_app_name not in SUPPORTED_BROWSER_APPS:
        raise RuntimeError("Browser navigation actions only run in Safari, Chrome, Arc, Brave, or Edge.")

    javascript = {
        "browser_back": "(() => { history.back(); return 'ok'; })();",
        "browser_forward": "(() => { history.forward(); return 'ok'; })();",
        "browser_reload": "(() => { location.reload(); return 'ok'; })();",
    }.get(action.action_type)
    if javascript is None:
        raise RuntimeError(f"Unsupported browser action '{action.action_type}'.")

    _execute_browser_javascript(browser_app_name, javascript)


def _execute_browser_javascript(browser_app_name: str, javascript: str) -> str:
    escaped_browser_name = escape_applescript_string(browser_app_name)
    escaped_javascript = escape_applescript_string(javascript)
    if browser_app_name == "Safari":
        lines = [
            f'tell application "{escaped_browser_name}"',
            "activate",
            'if (count of windows) = 0 then error "No browser window is open."',
            f'set actionResult to do JavaScript "{escaped_javascript}" in current tab of front window',
            "end tell",
            "return actionResult",
        ]
    elif browser_app_name in CHROMIUM_BROWSER_APPS:
        lines = [
            f'tell application "{escaped_browser_name}"',
            "activate",
            'if (count of windows) = 0 then error "No browser window is open."',
            f'set actionResult to execute active tab of front window javascript "{escaped_javascript}"',
            "end tell",
            "return actionResult",
        ]
    else:
        raise RuntimeError(f"{browser_app_name} is not a supported browser.")
    return run_applescript_lines(lines)


def _clean_target_phrase(value: str) -> str:
    cleaned = str(value or "").strip().strip(".,")
    cleaned = TRAILING_PAGE_HINT_PATTERN.sub("", cleaned).strip()
    cleaned = TRAILING_CONTEXT_QUALIFIER_PATTERN.sub("", cleaned).strip()
    while True:
        next_cleaned = LEADING_TARGET_FILLER_PATTERN.sub("", cleaned).strip()
        if next_cleaned == cleaned:
            break
        cleaned = next_cleaned
    cleaned = MULTISPACE_PATTERN.sub(" ", cleaned)
    return cleaned.strip(" .,:;")


def _clean_app_query(value: str) -> str:
    cleaned = str(value or "").strip().strip(".,")
    cleaned = normalize_imperative_phrase(cleaned)
    cleaned = TRAILING_APP_CLAUSE_PATTERN.sub("", cleaned).strip()
    while True:
        next_cleaned = LEADING_APP_FILLER_PATTERN.sub("", cleaned).strip()
        if next_cleaned == cleaned:
            break
        cleaned = next_cleaned
    cleaned = TRAILING_APP_NOUN_PATTERN.sub("", cleaned).strip()
    cleaned = MULTISPACE_PATTERN.sub(" ", cleaned)
    return cleaned.strip(" .,:;")


def _extract_url_request(transcript: str) -> Optional[str]:
    normalized = " ".join((transcript or "").split()).strip()
    if not normalized:
        return None

    direct_match = OPEN_URL_PATTERN.search(normalized)
    if direct_match:
        return _normalize_url_candidate(direct_match.group(1))

    spoken_match = SPOKEN_URL_PATTERN.search(normalized)
    if spoken_match:
        return _normalize_url_candidate(spoken_match.group(1))

    return None


def _normalize_url_candidate(candidate: str) -> Optional[str]:
    normalized = str(candidate or "").strip().rstrip(".,;:")
    if not normalized:
        return None

    normalized = DOT_WORD_PATTERN.sub(".", normalized)
    normalized = SLASH_WORD_PATTERN.sub("/", normalized)
    normalized = COLON_WORD_PATTERN.sub(":", normalized)
    normalized = URL_PATH_SPACE_PATTERN.sub("/", normalized)
    normalized = MULTISPACE_PATTERN.sub("", normalized)
    normalized = normalized.strip()
    if not normalized:
        return None

    if not normalized.startswith(("http://", "https://")):
        normalized = f"https://{normalized}"

    host_and_path = normalized.split("://", 1)[-1]
    host = host_and_path.split("/", 1)[0].strip().lower()
    if not URL_HOST_PATTERN.match(host):
        return None
    return normalized


def _resolve_supported_browser_app(context: dict[str, Any]) -> Optional[str]:
    app_name = str(context.get("app_name") or "").strip()
    if app_name in SUPPORTED_BROWSER_APPS:
        return app_name
    return None


def _resolve_ai_chat_site(context: dict[str, Any]) -> Optional[str]:
    raw_host = str(context.get("url_host") or "").strip().lower()
    if not raw_host:
        searchable = " ".join(
            str(context.get(key) or "").strip().lower()
            for key in ("page_title", "window_title", "app_name")
        )
        for host, aliases in AI_CHAT_HOST_ALIASES.items():
            if any(alias in searchable for alias in aliases):
                return host
        return None
    for host in AI_CHAT_HOST_ALIASES:
        if raw_host == host or raw_host.endswith(f".{host}"):
            return host
    return None
