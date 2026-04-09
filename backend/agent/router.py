from __future__ import annotations

import re
from typing import Any, Dict, Iterable, Optional, Tuple

from agent.skills.models import SkillDefinition
from agent.smart_models import RoutingDecision, SkillReference, SmartIntent, SmartLane


FILLER_PATTERN = re.compile(r"\b(?:uh|um|erm|hmm|mm)\b", re.IGNORECASE)
MULTISPACE_PATTERN = re.compile(r"\s+")
NUMBER_WORD_PATTERN = r"(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)"
ORDINAL_LIST_WORD_PATTERN = r"(?:first|second|third|fourth|fifth|sixth)"
UNORDERED_LIST_MARKER_PATTERN = rf"(?:point|bullet|item|step|dash)(?:\s+{NUMBER_WORD_PATTERN})?"
ORDERED_LIST_MARKER_PATTERN = rf"(?:number\s+{NUMBER_WORD_PATTERN}|{NUMBER_WORD_PATTERN}\s+period|\d+[.)]|{ORDINAL_LIST_WORD_PATTERN})"
SPOKEN_LIST_MARKER_PATTERN = rf"(?:{UNORDERED_LIST_MARKER_PATTERN}|{ORDERED_LIST_MARKER_PATTERN})"
LIST_MARKER_PATTERN = re.compile(
    rf"(?:^|[\n\r]+|(?<!\w))(?:[-*]\s*)?(?:{SPOKEN_LIST_MARKER_PATTERN})\s*[,:\-]?\s*",
    re.IGNORECASE,
)
LEADING_BULLET_LINE_PATTERN = re.compile(r"^\s*[-*]\s+(.+?)\s*$")
LEADING_LIST_MARKER_LINE_PATTERN = re.compile(
    rf"^\s*(?:[-*]\s*)?(?:{SPOKEN_LIST_MARKER_PATTERN})\s*[,:\-]?\s*(.+?)\s*$",
    re.IGNORECASE,
)
LEADING_LIST_MARKER_STRIP_PATTERN = re.compile(
    rf"^(?:{SPOKEN_LIST_MARKER_PATTERN})\s*[,:\-]?\s*",
    re.IGNORECASE,
)
INLINE_BULLET_SPLIT_PATTERN = re.compile(r"\s+(?=[-*]\s+)")
EXPLICIT_BULLET_PATTERN = re.compile(
    r"\b(?:bullet(?:ed)?(?: list| points?)?|bullets?|action items?|key points?|checklist)\b",
    re.IGNORECASE,
)
ORDERED_LIST_HINT_PATTERN = re.compile(
    rf"\b(?:number\s+{NUMBER_WORD_PATTERN}|{NUMBER_WORD_PATTERN}\s+period)\b|(?<!\w)\d+[.)](?=\s)|\b{ORDINAL_LIST_WORD_PATTERN}\b",
    re.IGNORECASE,
)
UNORDERED_LIST_HINT_PATTERN = re.compile(
    rf"\b(?:{UNORDERED_LIST_MARKER_PATTERN})\b|^\s*[-*]\s+",
    re.IGNORECASE | re.MULTILINE,
)
INLINE_LIST_DELIMITER_PATTERN = re.compile(r"\s*[;,]\s*")
TABLE_FORMAT_PATTERN = re.compile(r"\b(?:table|tabular|columns?|rows?|matrix|grid)\b", re.IGNORECASE)
PARAGRAPH_FORMAT_PATTERN = re.compile(r"\b(?:paragraph|prose|narrative)\b", re.IGNORECASE)
TRANSLATE_PATTERN = re.compile(r"\btranslate\b|\bin (?:spanish|french|german|italian|hindi|english)\b", re.IGNORECASE)
GRAMMAR_PATTERN = re.compile(r"\bfix grammar\b|\bclean (?:this )?up\b|\bmake this (?:sound )?(?:better|professional)\b", re.IGNORECASE)
INLINE_REWRITE_REQUEST_PATTERN = re.compile(
    r"^(?:make this(?: sound)?(?: more)?\s+(?:professional|polite|clear(?:er)?|concise|short(?:er)?|better)|rewrite this|rephrase this|polish this|clean this up)\b.+",
    re.IGNORECASE,
)
JIRA_PATTERN = re.compile(r"\b(?:jira|ticket|acceptance criteria|bug report)\b", re.IGNORECASE)
PROMPT_PATTERN = re.compile(
    r"\b(?:system prompt|prompt engineer|prompt for|write (?:me )?(?:a )?prompt|craft (?:a )?prompt|improve (?:this )?prompt)\b",
    re.IGNORECASE,
)
WORKFLOW_PATTERN = re.compile(
    r"\b(?:workflow|agent action|tool definition|tool schema|input schema|json schema|yaml|automation|make\.com|n8n|flowise)\b",
    re.IGNORECASE,
)
ACTION_COMMAND_PREFIX_PATTERN = re.compile(
    r"^(?:open|launch|switch to|bring up|focus(?: on)?|go to|visit|navigate to|click|press|tap|choose|hit)\b",
    re.IGNORECASE,
)
FIELD_ACTION_NOUN_PATTERN = (
    r"(?:field|input(?: box)?|text box|textbox|text area|search field|search box|search bar|"
    r"message field|message box|compose box|chat input(?: box)?|chat box|prompt box|prompt input|reply box|composer|bar)"
)
MAIL_ACTION_PATTERN = re.compile(
    r"^(?:compose|draft)\s+(?:an?\s+)?email\b|^(?:email|mail)\b.+\bto\b",
    re.IGNORECASE,
)
URL_ACTION_PATTERN = re.compile(r"^(?:go to|visit|navigate to|open)\s+(?:https?://)?[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.IGNORECASE)
SPOKEN_URL_ACTION_PATTERN = re.compile(
    r"^(?:go to|visit|navigate to|open)\s+[A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+)+(?:\s+slash\s+[A-Za-z0-9._~!$&'()*+,;=:@-]+)*",
    re.IGNORECASE,
)
APP_ACTION_PATTERN = re.compile(r"^(?:open|launch|switch to|bring up|focus(?: on)?)\s+[A-Za-z0-9][A-Za-z0-9 .&+'/-]{1,60}$", re.IGNORECASE)
FIELD_ACTION_PATTERN = re.compile(
    rf"^(?:focus(?: on)?|select|click into|tap into|go to|jump to|put (?:the )?(?:cursor|caret) in|place (?:the )?(?:cursor|caret) in)\b.+\b{FIELD_ACTION_NOUN_PATTERN}\b",
    re.IGNORECASE,
)
BUTTON_ACTION_PATTERN = re.compile(r"^(?:click|press|tap|choose|hit)\b.+\bbutton\b|^(?:click|press|tap|choose|hit)\s+[A-Za-z0-9]", re.IGNORECASE)
CODE_REFACTOR_PATTERN = re.compile(
    r"\b(?:refactor|clean up this code|rewrite this code|improve this code|extract (?:a )?(?:helper|function|method)|rename (?:this )?(?:variable|function|method)|fix this function)\b",
    re.IGNORECASE,
)
EMAIL_KEYWORDS = ("mail", "gmail", "outlook", "superhuman", "hey.com")
CHAT_KEYWORDS = ("slack", "discord", "messages", "signal", "telegram", "teams")
TERMINAL_KEYWORDS = ("terminal", "iterm", "warp", "hyper")
CODE_KEYWORDS = (
    "antigravity",
    "cloud code",
    "cloudcode",
    "codex",
    "cursor",
    "visual studio code",
    "vscode",
    "windsurf",
    "code",
    "pycharm",
    "intellij",
    "webstorm",
)
WORKFLOW_HOST_KEYWORDS = ("make.com", "n8n.io", "n8n.cloud", "flowiseai.com")
GRAMMAR_SKILL_IDS = {"system_grammar", "strict_grammar", "system_rewrite"}
SHELL_STARTERS = (
    "git ",
    "cd ",
    "ls",
    "pwd",
    "mkdir ",
    "rm ",
    "cp ",
    "mv ",
    "cat ",
    "grep ",
    "rg ",
    "npm ",
    "pnpm ",
    "yarn ",
    "python ",
    "python3 ",
    "pip ",
    "pytest",
    "uv ",
    "docker ",
    "kubectl ",
)


def build_skill_ref(skill: SkillDefinition) -> SkillReference:
    return SkillReference(id=skill.id, name=skill.name)


def build_raw_fallback_ref() -> SkillReference:
    return SkillReference(id="raw_dictation", name="Raw Dictation Fallback")


def evaluate_skill_applicability(
    skill: SkillDefinition,
    context: Dict[str, Any],
    target_type: Optional[str],
) -> Tuple[bool, Optional[str]]:
    if skill.target_types and (target_type or "") not in skill.target_types:
        return False, f"Skill target types {skill.target_types} do not match {target_type or 'unknown'}."

    if skill.triggers:
        searchable = " ".join(
            part.lower()
            for part in (
                context.get("app_name"),
                context.get("bundle_id"),
                context.get("window_title"),
                context.get("page_title"),
                context.get("url_host"),
                context.get("url_path"),
            )
            if part
        )
        if not any(trigger in searchable for trigger in skill.triggers):
            return False, "Skill triggers do not match the current Smart Mode target."

    return True, None


def normalize_whitespace(text: str) -> str:
    return MULTISPACE_PATTERN.sub(" ", text).strip()


def _looks_like_explicit_action_command(text: str) -> bool:
    normalized = normalize_whitespace(text)
    if not normalized:
        return False

    if not ACTION_COMMAND_PREFIX_PATTERN.match(normalized):
        return False

    # Long freeform dictation often mentions words like "open" or "focus"
    # mid-sentence. Keep the action fallback limited to short imperative commands.
    if len(normalized) > 120 or len(normalized.split()) > 16:
        return False

    trimmed = normalized.rstrip(".!?")
    if any(marker in trimmed for marker in ("\n", "\r", ";")):
        return False

    if trimmed.count(",") >= 2:
        return False

    return True


def trim_fillers(text: str) -> Tuple[str, bool]:
    cleaned = FILLER_PATTERN.sub(" ", text)
    cleaned = normalize_whitespace(cleaned)
    return cleaned, cleaned != normalize_whitespace(text)


def normalize_quotes(text: str) -> Tuple[str, bool]:
    replacements = {
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
    }
    cleaned = text
    for source, target in replacements.items():
        cleaned = cleaned.replace(source, target)
    return cleaned, cleaned != text


def cleanup_sentence_punctuation(text: str) -> Tuple[str, bool]:
    cleaned = re.sub(r"\s+([,.;!?])", r"\1", text)
    cleaned = re.sub(r"([,.;!?])([^\s])", r"\1 \2", cleaned)
    cleaned = cleaned.strip()

    changed = cleaned != text
    if cleaned and cleaned[0].isalpha():
        capitalized = cleaned[0].upper() + cleaned[1:]
        changed = changed or capitalized != cleaned
        cleaned = capitalized

    if cleaned and cleaned[-1] not in ".!?" and len(cleaned.split()) >= 3:
        cleaned = f"{cleaned}."
        changed = True

    return cleaned, changed


def normalize_command_text(text: str) -> Tuple[str, Iterable[str]]:
    working = text.strip()
    operations = []

    working, changed = normalize_quotes(working)
    if changed:
        operations.append("normalize_quotes")

    working, changed = trim_fillers(working)
    if changed:
        operations.append("trim_fillers")

    collapsed = normalize_whitespace(working)
    if collapsed != working:
        operations.append("collapse_whitespace")
        working = collapsed

    stripped = working.rstrip(".,;:")
    if stripped != working:
        operations.append("strip_trailing_punctuation")
        working = stripped

    return working, operations


def normalize_list_item(chunk: str) -> str:
    cleaned_chunk = LEADING_LIST_MARKER_STRIP_PATTERN.sub("", chunk.strip())
    cleaned_chunk = normalize_whitespace(cleaned_chunk)
    if not cleaned_chunk:
        return ""
    cleaned_text, _ = cleanup_sentence_punctuation(cleaned_chunk)
    return cleaned_text.rstrip(".")


def _render_bullet_list(items: Iterable[str]) -> Optional[str]:
    rendered = [f"- {item}" for item in items if item]
    if len(rendered) < 2:
        return None
    return "\n".join(rendered)


def infer_spoken_list_format(text: str) -> Optional[str]:
    normalized = normalize_whitespace(str(text or ""))
    if not normalized:
        return None

    marker_matches = list(LIST_MARKER_PATTERN.finditer(normalized))
    if len(marker_matches) >= 2:
        matched_markers = " ".join(match.group(0) for match in marker_matches)
        if ORDERED_LIST_HINT_PATTERN.search(matched_markers):
            return "numbered"
        if UNORDERED_LIST_HINT_PATTERN.search(matched_markers):
            return "bullets"

    if len(re.findall(r"(?<!\w)\d+[.)](?=\s)", normalized)) >= 2:
        return "numbered"

    return None


def _extract_delimited_inline_list_items(text: str) -> list[str]:
    if ";" not in text and "," not in text:
        return []

    items = [
        normalize_list_item(chunk)
        for chunk in INLINE_LIST_DELIMITER_PATTERN.split(text.strip())
        if chunk.strip()
    ]
    items = [item for item in items if item]
    if len(items) < 2:
        return []

    if any(len(item.split()) > 12 for item in items):
        return []

    return items


def extract_list_items_from_text(text: str, *, allow_delimited_fallback: bool = False) -> Tuple[list[str], Iterable[str]]:
    working = str(text or "").strip()
    if not working:
        return [], []

    line_items = []
    lines = [line for line in working.splitlines() if line.strip()]
    for line in lines:
        marker_match = LEADING_LIST_MARKER_LINE_PATTERN.match(line)
        if marker_match:
            item = normalize_list_item(marker_match.group(1))
            if item:
                line_items.append(item)
            continue
        match = LEADING_BULLET_LINE_PATTERN.match(line)
        if not match:
            continue
        item = normalize_list_item(match.group(1))
        if item:
            line_items.append(item)

    if len(line_items) >= 2:
        return line_items, ["spoken_points_to_bullets"]

    inline_bullet_chunks = [chunk.strip() for chunk in INLINE_BULLET_SPLIT_PATTERN.split(working) if chunk.strip()]
    if len(inline_bullet_chunks) >= 2 and all(LEADING_BULLET_LINE_PATTERN.match(chunk) for chunk in inline_bullet_chunks):
        inline_items = []
        for chunk in inline_bullet_chunks:
            match = LEADING_BULLET_LINE_PATTERN.match(chunk)
            if not match:
                continue
            item = normalize_list_item(match.group(1))
            if item:
                inline_items.append(item)
        if len(inline_items) >= 2:
            return inline_items, ["spoken_points_to_bullets"]

    matches = list(LIST_MARKER_PATTERN.finditer(working))
    if len(matches) >= 2:
        items = []
        for index, match in enumerate(matches):
            start = match.end()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(working)
            item = normalize_list_item(working[start:end])
            if item:
                items.append(item)
        if len(items) >= 2:
            return items, ["spoken_points_to_bullets"]

    if allow_delimited_fallback:
        delimited_items = _extract_delimited_inline_list_items(working)
        if delimited_items:
            return delimited_items, ["split_delimited_list_items"]

    return [], []


def spoken_points_to_bullets(text: str) -> Tuple[Optional[str], Iterable[str]]:
    items, operations = extract_list_items_from_text(text)
    rendered_items = _render_bullet_list(items)
    if not rendered_items:
        return None, []
    return rendered_items, operations


def infer_format_preference(transcript: str, skill: SkillDefinition, context: Dict[str, Any]) -> Optional[str]:
    lowered = normalize_whitespace(transcript).lower()
    command_format_contract = str(context.get("command_format_contract") or "").strip().lower()
    domain_default_format = str(context.get("domain_default_format") or "").strip().lower()
    if command_format_contract in {"bullets", "paragraph", "table", "checklist", "numbered"}:
        return command_format_contract
    spoken_list_format = infer_spoken_list_format(transcript)
    if spoken_list_format:
        return spoken_list_format
    if TABLE_FORMAT_PATTERN.search(lowered):
        return "table"
    if PARAGRAPH_FORMAT_PATTERN.search(lowered):
        return "paragraph"
    if domain_default_format in {"bullets", "paragraph", "table"}:
        return domain_default_format
    if skill.output_mode == "bullets":
        return "bullets"
    if EXPLICIT_BULLET_PATTERN.search(lowered) or spoken_points_to_bullets(transcript)[0]:
        return "bullets"

    domain_intent = str(context.get("domain_intent") or "").strip().lower()
    if domain_intent in {
        "operations_note",
        "incident_exception_summary",
        "patient_follow_up_summary",
        "referral_handoff_note",
        "care_team_update",
        "discharge_visit_summary",
    }:
        return "bullets"

    if context.get("target_type") == "browser_doc" and any(token in lowered for token in ("summary", "action items", "notes")):
        return "bullets"

    return None


def cleanup_plain_text(text: str) -> Tuple[str, Iterable[str]]:
    operations = []
    working = text.strip()

    working, changed = normalize_quotes(working)
    if changed:
        operations.append("normalize_quotes")

    working, changed = trim_fillers(working)
    if changed:
        operations.append("trim_fillers")

    collapsed = normalize_whitespace(working)
    if collapsed != working:
        operations.append("collapse_whitespace")
        working = collapsed

    punctuated, changed = cleanup_sentence_punctuation(working)
    if changed:
        operations.append("cleanup_punctuation")
        working = punctuated

    return working, operations


def apply_deterministic_transform(intent: SmartIntent, transcript: str) -> Tuple[str, list[str]]:
    if intent == SmartIntent.TERMINAL_COMMAND:
        command, operations = normalize_command_text(transcript)
        return command or normalize_whitespace(transcript), list(operations)

    if intent == SmartIntent.BULLETIZE:
        bullet_text, operations = spoken_points_to_bullets(transcript)
        if bullet_text:
            return bullet_text, list(operations)

    cleaned, operations = cleanup_plain_text(transcript)
    return cleaned or normalize_whitespace(transcript), list(operations)


def _combined_context_text(context: Dict[str, Any]) -> str:
    return " ".join(
        part.lower()
        for part in (
            context.get("app_name"),
            context.get("bundle_id"),
            context.get("window_title"),
            context.get("page_title"),
            context.get("url_host"),
            context.get("url_path"),
            context.get("target_type"),
        )
        if part
    )


def _is_terminal_context(context: Dict[str, Any]) -> bool:
    combined = _combined_context_text(context)
    return any(keyword in combined for keyword in TERMINAL_KEYWORDS)


def _is_chat_context(context: Dict[str, Any]) -> bool:
    combined = _combined_context_text(context)
    return context.get("target_type") == "chat" or any(keyword in combined for keyword in CHAT_KEYWORDS)


def _is_email_context(context: Dict[str, Any]) -> bool:
    combined = _combined_context_text(context)
    return any(keyword in combined for keyword in EMAIL_KEYWORDS)


def _is_code_context(context: Dict[str, Any]) -> bool:
    combined = _combined_context_text(context)
    return context.get("target_type") == "ide" or any(keyword in combined for keyword in CODE_KEYWORDS)


def _is_workflow_context(context: Dict[str, Any]) -> bool:
    combined = _combined_context_text(context)
    return any(keyword in combined for keyword in WORKFLOW_HOST_KEYWORDS)


def _looks_like_shell_command(transcript: str) -> bool:
    lowered = normalize_whitespace(transcript).lower()
    tokens = lowered.split()
    if not tokens:
        return False

    if any(lowered.startswith(prefix) for prefix in SHELL_STARTERS):
        return True

    shell_markers = {"&&", "||", "|", ">", ">>", "2>", "2>&1"}
    has_shell_tokens = any(token in shell_markers for token in tokens)
    has_flag = any(token.startswith("-") for token in tokens[1:])
    has_path_like_token = any(
        token.startswith(("/", "./", "../", "~/")) or "/" in token or "=" in token
        for token in tokens
    )
    natural_language_stopwords = {
        "the",
        "a",
        "an",
        "and",
        "for",
        "with",
        "after",
        "before",
        "this",
        "that",
        "need",
        "can",
        "you",
        "we",
        "to",
        "later",
    }
    stopword_count = sum(token in natural_language_stopwords for token in tokens)

    return len(tokens) <= 12 and stopword_count <= 1 and (has_shell_tokens or has_flag or has_path_like_token)


def _looks_like_simple_cleanup(transcript: str) -> bool:
    normalized = normalize_whitespace(transcript)
    word_count = len(normalized.split())
    if word_count == 0 or word_count > 42:
        return False

    has_signal = any([
        transcript != normalized,
        bool(FILLER_PATTERN.search(transcript)),
        normalized.islower(),
        normalized and normalized[-1] not in ".!?",
        "  " in transcript,
    ])
    return has_signal


class LocalIntentRouter:
    def plan(
        self,
        transcript: str,
        context: Dict[str, Any],
        requested_skill: SkillDefinition,
        effective_skill: SkillDefinition,
        *,
        fallback_applied: bool = False,
        fallback_reason: Optional[str] = None,
        raw_fallback: bool = False,
    ) -> RoutingDecision:
        normalized_transcript = normalize_whitespace(transcript)
        lowered = normalized_transcript.lower()
        normalized_command_candidate, _ = normalize_command_text(normalized_transcript)
        bullet_text, _ = spoken_points_to_bullets(normalized_transcript)
        explicit_bullets = bool(EXPLICIT_BULLET_PATTERN.search(lowered))
        explicit_table = bool(TABLE_FORMAT_PATTERN.search(lowered))
        explicit_paragraph = bool(PARAGRAPH_FORMAT_PATTERN.search(lowered))

        if raw_fallback:
            return RoutingDecision(
                intent=SmartIntent.RAW_DICTATION,
                lane=SmartLane.PASSTHROUGH,
                confidence=0.98,
                ambiguity=0.02,
                reason=fallback_reason or "Skill contract requested raw dictation fallback.",
                requested_skill=build_skill_ref(requested_skill),
                skill_used=build_raw_fallback_ref(),
                fallback_applied=True,
                fallback_reason=fallback_reason,
                output_mode="plain_text",
            )

        if TRANSLATE_PATTERN.search(lowered):
            return self._decision(
                SmartIntent.TRANSLATE,
                SmartLane.LLM,
                0.94,
                "Explicit translation language cues detected in the transcript.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        if JIRA_PATTERN.search(lowered):
            return self._decision(
                SmartIntent.JIRA_TICKET,
                SmartLane.LLM,
                0.88,
                "Ticket-writing keywords suggest a structured issue or Jira draft.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        if URL_ACTION_PATTERN.search(lowered) or SPOKEN_URL_ACTION_PATTERN.search(lowered):
            return self._decision(
                SmartIntent.ACTION_EXECUTION,
                SmartLane.DETERMINISTIC,
                0.92,
                "Explicit URL navigation cues matched the deterministic browser action route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
                output_mode="code",
            )

        if (
            effective_skill.id == "system_action_execution"
            or MAIL_ACTION_PATTERN.search(lowered)
            or APP_ACTION_PATTERN.search(lowered)
            or FIELD_ACTION_PATTERN.search(lowered)
            or BUTTON_ACTION_PATTERN.search(lowered)
            or _looks_like_explicit_action_command(normalized_transcript)
        ):
            return self._decision(
                SmartIntent.ACTION_EXECUTION,
                SmartLane.LLM,
                0.86 if effective_skill.id == "system_action_execution" else 0.8,
                "Explicit desktop action phrasing matched the reviewed action-execution route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
                output_mode="code",
            )

        if effective_skill.id == "system_prompt_architect" or PROMPT_PATTERN.search(lowered):
            return self._decision(
                SmartIntent.PROMPT_CRAFTING,
                SmartLane.LLM,
                0.9 if effective_skill.id == "system_prompt_architect" else 0.8,
                "Prompt-design cues matched the prompt architect route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        if effective_skill.id == "system_agent_action_builder" or _is_workflow_context(context) or WORKFLOW_PATTERN.search(lowered):
            return self._decision(
                SmartIntent.WORKFLOW_DESIGN,
                SmartLane.LLM,
                0.9 if effective_skill.id == "system_agent_action_builder" or _is_workflow_context(context) else 0.82,
                "Workflow or agent-schema cues matched the structured builder route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
                output_mode="code",
            )

        if _is_terminal_context(context) or effective_skill.output_mode == "command" or _looks_like_shell_command(normalized_transcript):
            lane = SmartLane.DETERMINISTIC if _looks_like_shell_command(normalized_command_candidate) else SmartLane.LLM
            confidence = 0.93 if lane == SmartLane.DETERMINISTIC else 0.72
            reason = "Terminal context or command-shaped transcript matched the shell cleanup lane."
            return self._decision(
                SmartIntent.TERMINAL_COMMAND,
                lane,
                confidence,
                reason,
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
                output_mode="command",
            )

        if not explicit_table and not explicit_paragraph and (effective_skill.output_mode == "bullets" or explicit_bullets or bullet_text):
            lane = SmartLane.LLM
            confidence = 0.76 if bullet_text else 0.7
            reason = "List-formatting cues matched the Smart bulletize route, which should be handled by the LLM."
            return self._decision(
                SmartIntent.BULLETIZE,
                lane,
                confidence,
                reason,
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
                output_mode="bullets",
            )

        if explicit_table:
            return self._decision(
                SmartIntent.GENERIC,
                SmartLane.LLM,
                0.8,
                "Explicit table-format cues matched a structured LLM formatting route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        if explicit_paragraph:
            return self._decision(
                SmartIntent.GENERIC,
                SmartLane.LLM,
                0.78,
                "Explicit paragraph-format cues matched a clean prose rewrite route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        has_explicit_cleanup_request = requested_skill.id in GRAMMAR_SKILL_IDS or GRAMMAR_PATTERN.search(lowered)

        if _is_email_context(context) and not has_explicit_cleanup_request:
            return self._decision(
                SmartIntent.EMAIL_REWRITE,
                SmartLane.LLM,
                0.87,
                "Email client context matched the email rewrite route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        if _is_chat_context(context) and not has_explicit_cleanup_request:
            return self._decision(
                SmartIntent.CHAT_REPLY,
                SmartLane.LLM,
                0.9,
                "Chat app context matched the chat reply route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        if _is_code_context(context) or effective_skill.output_mode == "code":
            if effective_skill.id == "system_code" or CODE_REFACTOR_PATTERN.search(lowered):
                return self._decision(
                    SmartIntent.CODE_REFACTOR,
                    SmartLane.LLM,
                    0.84 if CODE_REFACTOR_PATTERN.search(lowered) else 0.76,
                    "Editor context or refactor language matched the code refactor route.",
                    requested_skill,
                    effective_skill,
                    fallback_applied,
                    fallback_reason,
                    output_mode="code",
                )
            return self._decision(
                SmartIntent.CODE_SNIPPET,
                SmartLane.LLM,
                0.8,
                "IDE context or code output mode matched the code snippet route.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
                output_mode="code",
            )

        if has_explicit_cleanup_request:
            lane = (
                SmartLane.LLM
                if INLINE_REWRITE_REQUEST_PATTERN.match(normalized_transcript)
                else SmartLane.DETERMINISTIC if _looks_like_simple_cleanup(normalized_transcript) else SmartLane.LLM
            )
            confidence = 0.84 if lane == SmartLane.DETERMINISTIC else 0.7
            reason = "Grammar-focused skill or cleanup phrasing matched the grammar cleanup route."
            return self._decision(
                SmartIntent.GRAMMAR_CLEANUP,
                lane,
                confidence,
                reason,
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        if effective_skill.id == "system_dictation" and context.get("context_quality") in {"empty", "transcript_only"}:
            return self._decision(
                SmartIntent.RAW_DICTATION,
                SmartLane.PASSTHROUGH,
                0.76,
                "Context is limited, so Smart Mode will preserve the transcript without an LLM call.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        if effective_skill.id == "system_dictation" and _looks_like_simple_cleanup(normalized_transcript) and effective_skill.output_mode == "plain_text":
            return self._decision(
                SmartIntent.RAW_DICTATION,
                SmartLane.DETERMINISTIC,
                0.8,
                "Transcript is short and cleanup-only, so the local deterministic lane is safe.",
                requested_skill,
                effective_skill,
                fallback_applied,
                fallback_reason,
            )

        return self._decision(
            SmartIntent.GENERIC,
            SmartLane.LLM,
            0.58,
            "No narrow local route matched, so Smart Mode will use the selected LLM lane.",
            requested_skill,
            effective_skill,
            fallback_applied,
            fallback_reason,
        )

    def _decision(
        self,
        intent: SmartIntent,
        lane: SmartLane,
        confidence: float,
        reason: str,
        requested_skill: SkillDefinition,
        effective_skill: SkillDefinition,
        fallback_applied: bool,
        fallback_reason: Optional[str],
        *,
        output_mode: Optional[str] = None,
    ) -> RoutingDecision:
        bounded_confidence = min(max(confidence, 0.0), 1.0)
        return RoutingDecision(
            intent=intent,
            lane=lane,
            confidence=bounded_confidence,
            ambiguity=round(1.0 - bounded_confidence, 3),
            reason=reason,
            requested_skill=build_skill_ref(requested_skill),
            skill_used=build_skill_ref(effective_skill),
            fallback_applied=fallback_applied,
            fallback_reason=fallback_reason,
            output_mode=output_mode or effective_skill.output_mode,
        )
