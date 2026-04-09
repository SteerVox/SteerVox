from __future__ import annotations

import re
from enum import Enum
from typing import Optional

from pydantic import BaseModel

from agent.router import normalize_whitespace


class ActionRoute(str, Enum):
    PASS_THROUGH = "pass_through"
    SAVE_NOTE = "save_note"
    TRANSFORM_THEN_PASTE = "transform_then_paste"
    TRANSFORM_THEN_SAVE_NOTE = "transform_then_save_note"


class ExternalTextSource(str, Enum):
    NONE = "none"
    SELECTION = "selection"
    CLIPBOARD = "clipboard"


class InboxSourceKind(str, Enum):
    SPOKEN_TEXT = "spoken_text"
    SELECTION_TEXT = "selection_text"
    CLIPBOARD_TEXT = "clipboard_text"
    TRANSFORMED_OUTPUT = "transformed_output"


class ExternalTextResolution(BaseModel):
    source: ExternalTextSource = ExternalTextSource.NONE
    text: Optional[str] = None


class ActionRoutingResult(BaseModel):
    action: ActionRoute
    transcript_for_transform: str
    note_text: Optional[str] = None
    note_source: Optional[InboxSourceKind] = None
    requires_external_text: bool = False
    external_text_source: ExternalTextSource = ExternalTextSource.NONE
    resolver: str = "local"
    reason: str
    note_routing_suppressed: bool = False


POLITE_PREFIX_PATTERN = re.compile(
    r"^\s*(?:(?:please|kindly|hey|ok(?:ay)?|alright)\b[\s,]*)*(?:(?:can|could|would|will)\s+you\b[\s,]*)?",
    re.IGNORECASE,
)
REFERENTIAL_PATTERN = re.compile(
    r"\b(?:this|that|it|selection|selected text|clipboard)\b",
    re.IGNORECASE,
)
TRANSFORM_PATTERN = re.compile(
    r"\b(?:transform|summari[sz]e|translate|rewrite|rephrase|shorten|formalize|polish|clean(?:\s+this)?\s+up|fix\s+grammar|make\s+(?:this\s+)?(?:better|professional|clearer|concise)|turn\s+(?:this\s+)?into|bullet(?:ize|ise)|extract)\b",
    re.IGNORECASE,
)
STRONG_NOTE_PATTERN = re.compile(
    r"\b(?:note\s+to\s+self|add(?:\s+(?:this|that|it))?\s+to\s+(?:my\s+)?(?:notes?|inbox)|take\s+(?:a\s+)?note(?:\s+of(?:\s+(?:this|that|it))?)?|note(?:\s+(?:this|that|it))?(?:\s+down)?|jot(?:\s+(?:this|that|it))?\s+down|save(?:\s+(?:this|that|it))?\s+(?:for\s+later|to\s+(?:my\s+)?(?:notes?|inbox))|store(?:\s+(?:this|that|it))?\s+(?:for\s+later|in\s+(?:my\s+)?(?:notes?|inbox)))\b",
    re.IGNORECASE,
)

TRAILING_SAVE_PATTERN = re.compile(
    r"(?:\b(?:and|then|also)\b[\s,]*)?(?:note\s+to\s+self|take\s+(?:a\s+)?note(?:\s+of(?:\s+(?:this|that|it))?)?|note(?:\s+(?:this|that|it))?(?:\s+down)?|jot(?:\s+(?:this|that|it))?\s+down|add(?:\s+(?:this|that|it))?\s+to\s+(?:my\s+)?(?:notes?|inbox)|save(?:\s+(?:this|that|it))?\s+(?:for\s+later|to\s+(?:my\s+)?(?:notes?|inbox))|store(?:\s+(?:this|that|it))?\s+(?:for\s+later|in\s+(?:my\s+)?(?:notes?|inbox)))\s*$",
    re.IGNORECASE,
)
NOTE_STRIP_PATTERN = re.compile(
    r"\b(?:note\s+to\s+self|take\s+(?:a\s+)?note(?:\s+of(?:\s+(?:this|that|it))?)?|note(?:\s+(?:this|that|it))?(?:\s+down)?|jot(?:\s+(?:this|that|it))?\s+down|add(?:\s+(?:this|that|it))?\s+to\s+(?:my\s+)?(?:notes?|inbox)|save(?:\s+(?:this|that|it))?\s+(?:for\s+later|to\s+(?:my\s+)?(?:notes?|inbox))|store(?:\s+(?:this|that|it))?\s+(?:for\s+later|in\s+(?:my\s+)?(?:notes?|inbox)))\b",
    re.IGNORECASE,
)
EDGE_FILLER_PATTERN = re.compile(r"^(?:and|then|also|to|for|of|down|into|in|on|that)\b[\s,:-]*", re.IGNORECASE)
TRAILING_CONNECTOR_PATTERN = re.compile(r"[\s,:-]*(?:and|then|also)\s*$", re.IGNORECASE)
GENERIC_TRANSFORM_ONLY_PATTERN = re.compile(
    r"^(?:transform|rewrite|rephrase|summari[sz]e|translate|shorten|formalize|polish|clean up|fix grammar|extract|bullet(?:ize|ise))(?:\s+(?:this|that|it))?$",
    re.IGNORECASE,
)


def resolve_external_text(selection_text: Optional[str], clipboard_text: Optional[str]) -> ExternalTextResolution:
    selection_candidate = (selection_text or "").strip()
    if selection_candidate:
        return ExternalTextResolution(source=ExternalTextSource.SELECTION, text=selection_candidate)

    clipboard_candidate = (clipboard_text or "").strip()
    if clipboard_candidate:
        return ExternalTextResolution(source=ExternalTextSource.CLIPBOARD, text=clipboard_candidate)

    return ExternalTextResolution()


def infer_inbox_source_kind(source: ExternalTextSource) -> InboxSourceKind:
    if source == ExternalTextSource.SELECTION:
        return InboxSourceKind.SELECTION_TEXT
    if source == ExternalTextSource.CLIPBOARD:
        return InboxSourceKind.CLIPBOARD_TEXT
    return InboxSourceKind.SPOKEN_TEXT


def should_use_action_router_model(transcript: str, *, mode: str) -> bool:
    return False


def _clean_edges(text: str) -> str:
    working = normalize_whitespace(text)
    previous = None
    while working and working != previous:
        previous = working
        working = POLITE_PREFIX_PATTERN.sub("", working, count=1).strip(" ,:-")
        working = EDGE_FILLER_PATTERN.sub("", working, count=1).strip(" ,:-")
        working = TRAILING_CONNECTOR_PATTERN.sub("", working).strip(" ,:-")
    return normalize_whitespace(working)


def _extract_spoken_note_body(text: str) -> str:
    stripped = NOTE_STRIP_PATTERN.sub(" ", text)
    return _clean_edges(stripped)


def _extract_transform_instruction(text: str, *, external_available: bool) -> str:
    stripped = TRAILING_SAVE_PATTERN.sub("", text)
    stripped = _clean_edges(stripped)
    if not stripped:
        return "transform this" if external_available else ""

    if external_available and not REFERENTIAL_PATTERN.search(stripped) and GENERIC_TRANSFORM_ONLY_PATTERN.fullmatch(stripped):
        return f"{stripped} this"
    return stripped


class LocalActionRouter:
    def route(
        self,
        transcript: str,
        *,
        mode: str,
        external_text: ExternalTextResolution,
        allow_note_capture: bool = True,
    ) -> ActionRoutingResult:
        normalized = normalize_whitespace(transcript)
        lowered = normalized.lower()
        has_transform = bool(TRANSFORM_PATTERN.search(lowered))
        has_strong_note = bool(STRONG_NOTE_PATTERN.search(lowered))
        mentions_external = bool(REFERENTIAL_PATTERN.search(lowered))

        if mode != "smart_transform":
            return ActionRoutingResult(
                action=ActionRoute.PASS_THROUGH,
                transcript_for_transform=normalized,
                reason="Dictation mode no longer auto-saves notes, so the transcript will paste normally.",
            )

        if not allow_note_capture:
            return ActionRoutingResult(
                action=ActionRoute.TRANSFORM_THEN_PASTE,
                transcript_for_transform=normalized,
                reason=(
                    "Active domain mode suppresses note capture, so Smart Mode will keep this in the normal transform flow."
                    if has_strong_note
                    else "Domain mode is active, so Smart Mode will continue with the normal transform-and-paste flow."
                ),
                note_routing_suppressed=has_strong_note,
            )

        if not has_strong_note:
            return ActionRoutingResult(
                action=ActionRoute.TRANSFORM_THEN_PASTE,
                transcript_for_transform=normalized,
                reason="No explicit note phrase was detected, so Smart Mode will continue with the normal transform-and-paste flow.",
            )

        if has_transform and has_strong_note:
            transform_instruction = _extract_transform_instruction(
                normalized,
                external_available=external_text.source != ExternalTextSource.NONE,
            )
            if transform_instruction:
                requires_external = (
                    external_text.source != ExternalTextSource.NONE
                    or mentions_external
                    or GENERIC_TRANSFORM_ONLY_PATTERN.fullmatch(transform_instruction) is not None
                )
                if requires_external and external_text.source == ExternalTextSource.NONE:
                    raise ValueError("No selected or copied text was available to transform and save. Select or copy text first, then try again.")
                return ActionRoutingResult(
                    action=ActionRoute.TRANSFORM_THEN_SAVE_NOTE,
                    transcript_for_transform=transform_instruction,
                    requires_external_text=requires_external,
                    external_text_source=external_text.source if requires_external else ExternalTextSource.NONE,
                    reason="Smart Mode detected both a transform request and a save-to-notes request, so it will save the transformed output instead of pasting it.",
                )

        spoken_note = _extract_spoken_note_body(normalized)
        if spoken_note and not REFERENTIAL_PATTERN.fullmatch(spoken_note):
            return ActionRoutingResult(
                action=ActionRoute.SAVE_NOTE,
                transcript_for_transform=normalized,
                note_text=spoken_note,
                note_source=InboxSourceKind.SPOKEN_TEXT,
                reason="Smart Mode matched an explicit note phrase with spoken note content.",
            )
        if external_text.source != ExternalTextSource.NONE:
            return ActionRoutingResult(
                action=ActionRoute.SAVE_NOTE,
                transcript_for_transform=normalized,
                requires_external_text=True,
                external_text_source=external_text.source,
                reason="Smart Mode matched an explicit referential note phrase, so the selected or clipboard text will be stored in the inbox.",
            )
        fallback_note = spoken_note or normalized
        return ActionRoutingResult(
            action=ActionRoute.SAVE_NOTE,
            transcript_for_transform=normalized,
            note_text=fallback_note,
            note_source=InboxSourceKind.SPOKEN_TEXT,
            reason="Smart Mode matched an explicit note phrase but no external text was available, so the spoken transcript itself will be stored in the inbox.",
        )
