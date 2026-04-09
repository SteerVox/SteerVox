from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

from agent.router import (
    extract_list_items_from_text,
    infer_spoken_list_format,
    normalize_list_item,
    normalize_whitespace,
    spoken_points_to_bullets,
)


NEW_PARAGRAPH_PATTERN = re.compile(r"\b(?:new|next)\s+paragraph\b", re.IGNORECASE)
NEW_LINE_PATTERN = re.compile(r"\b(?:new|next)\s+line\b", re.IGNORECASE)
SCRATCH_THAT_PATTERN = re.compile(r"\b(?:scratch that|never mind|ignore that)\b", re.IGNORECASE)
REMOVE_LAST_POINT_PATTERN = re.compile(r"\b(?:remove|delete)\s+(?:the\s+)?last\s+(?:point|bullet|item)\b", re.IGNORECASE)
REPLACE_PATTERN = re.compile(
    r"\breplace\s+(?P<old>.+?)\s+with\s+(?P<new>.+?)(?=(?:\s+(?:and\s+)?)?(?:new line|new paragraph|point|bullet|item|step|$))",
    re.IGNORECASE,
)
FORMAT_COMMAND_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "paragraph",
        re.compile(
            r"\b(?:turn|make|format|write|give)\s+(?:this|that|it)?\s*(?:into|as)?\s*(?:a\s+)?paragraph\b",
            re.IGNORECASE,
        ),
    ),
    (
        "table",
        re.compile(
            r"\b(?:turn|make|format|write|give)\s+(?:this|that|it)?\s*(?:into|as)?\s*(?:a\s+)?(?:table|tabular format|matrix|grid)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "checklist",
        re.compile(
            r"\b(?:turn|make|format|write|give)\s+(?:this|that|it)?\s*(?:into|as)?\s*(?:a\s+)?checklist\b",
            re.IGNORECASE,
        ),
    ),
    (
        "numbered",
        re.compile(
            r"\b(?:turn|make|format|write|give)\s+(?:this|that|it)?\s*(?:into|as)?\s*(?:a\s+)?(?:numbered list|number list)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "bullets",
        re.compile(
            r"\b(?:turn|make|format|write|give)\s+(?:this|that|it)?\s*(?:into|as)?\s*(?:a\s+)?(?:bullet(?:ed)? list|bullets?|points?)\b",
            re.IGNORECASE,
        ),
    ),
]
CODE_HINT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("diff", re.compile(r"\b(?:diff|patch)\b", re.IGNORECASE)),
    ("shell_command", re.compile(r"\b(?:shell command|terminal command|command only)\b", re.IGNORECASE)),
    ("function_stub", re.compile(r"\b(?:function stub|function skeleton|stub this function)\b", re.IGNORECASE)),
    ("code_block", re.compile(r"\b(?:code block|code snippet)\b", re.IGNORECASE)),
    ("bullet_summary", re.compile(r"\b(?:bullet summary|summary bullets)\b", re.IGNORECASE)),
]
PUNCTUATION_COMMANDS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bcomma\b", re.IGNORECASE), ","),
    (re.compile(r"\bcolon\b", re.IGNORECASE), ":"),
    (re.compile(r"\bsemicolon\b", re.IGNORECASE), ";"),
    (re.compile(r"\bquestion mark\b", re.IGNORECASE), "?"),
    (re.compile(r"\bexclamation point\b", re.IGNORECASE), "!"),
    (re.compile(r"\bexclamation mark\b", re.IGNORECASE), "!"),
    (re.compile(r"\bopen parenthesis\b", re.IGNORECASE), "("),
    (re.compile(r"\bclose parenthesis\b", re.IGNORECASE), ")"),
    (re.compile(r"\bopen bracket\b", re.IGNORECASE), "["),
    (re.compile(r"\bclose bracket\b", re.IGNORECASE), "]"),
    (re.compile(r"\bopen brace\b", re.IGNORECASE), "{"),
    (re.compile(r"\bclose brace\b", re.IGNORECASE), "}"),
    (re.compile(r"\bopen quote\b", re.IGNORECASE), '"'),
    (re.compile(r"\bclose quote\b", re.IGNORECASE), '"'),
    (re.compile(r"\bdash\b", re.IGNORECASE), "-"),
]
INLINE_TERMINAL_PUNCTUATION_COMMANDS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(
            r"(?<!a\s)(?<!the\s)(?<!word\s)(?<!literal\s)\b(?:period|full stop)\b(?!\s+(?:after|before|character|word|words?|mark|symbol))",
            re.IGNORECASE,
        ),
        ".",
    ),
]
TERMINAL_PUNCTUATION_COMMANDS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?:\s+|^)(?:period|full stop)\s*$", re.IGNORECASE), "."),
]
SUBJECT_PREFIX_PATTERN = re.compile(r"^\s*subject\s*:\s*", re.IGNORECASE)
GREETING_LINE_PATTERN = re.compile(r"^(?:dear\b|hi\b|hello\b|hey\b)", re.IGNORECASE)
SIGNOFF_LINE_PATTERN = re.compile(r"^(?:best regards\b|regards\b|kind regards\b|thanks\b|thank you\b|sincerely\b)", re.IGNORECASE)
BULLET_LINE_PATTERN = re.compile(r"^\s*[-*]\s+", re.MULTILINE)
NUMBERED_LIST_MARKER_PATTERN = re.compile(r"^\s*(\d+)[.)]\s+")
CHECKLIST_LINE_PATTERN = re.compile(r"^\s*[-*]\s+")
COLON_PAIR_PATTERN = re.compile(r"^\s*([^:|]+?)\s*[:|]\s*(.+?)\s*$")


@dataclass
class CommandControlResult:
    text: str
    operations: List[str] = field(default_factory=list)
    format_contract: Optional[str] = None
    code_format_hint: Optional[str] = None


def apply_command_control(transcript: str, *, allow_format_contract: bool = True) -> CommandControlResult:
    working = str(transcript or "").strip()
    if not working:
        return CommandControlResult(text="")

    operations: list[str] = []
    format_contract: Optional[str] = None
    if allow_format_contract:
        format_contract, working = _extract_format_contract(working)
    if format_contract:
        operations.append(f"format_contract:{format_contract}")

    code_format_hint = _extract_code_format_hint(working)

    working, replaced = _apply_replace_instruction(working)
    if replaced:
        operations.append("replace_within_utterance")

    working, scratched = _apply_scratch_that(working)
    if scratched:
        operations.append("scratch_that")

    working, removed_last_point = _apply_remove_last_point(working)
    if removed_last_point:
        operations.append("remove_last_point")

    working, paragraph_changed = _replace_command(NEW_PARAGRAPH_PATTERN, working, "\n\n")
    if paragraph_changed:
        operations.append("new_paragraph")

    working, line_changed = _replace_command(NEW_LINE_PATTERN, working, "\n")
    if line_changed:
        operations.append("new_line")

    working, punctuation_operations = _apply_punctuation_commands(working)
    operations.extend(punctuation_operations)

    rendered_text, format_operations = apply_format_contract(
        working,
        format_contract=format_contract,
        transcript_hint=transcript,
    )
    working = rendered_text
    operations.extend(format_operations)

    working = _normalize_command_result(working)
    return CommandControlResult(
        text=working,
        operations=_dedupe_operations(operations),
        format_contract=format_contract,
        code_format_hint=code_format_hint,
    )


def apply_minimal_command_control(transcript: str, *, allow_format_contract: bool = True) -> CommandControlResult:
    working = str(transcript or "").strip()
    if not working:
        return CommandControlResult(text="")

    if not allow_format_contract:
        return CommandControlResult(text=working)

    format_contract, working = _extract_format_contract(working)
    if not format_contract:
        return CommandControlResult(text=working)

    rendered_text, format_operations = apply_format_contract(
        working,
        format_contract=format_contract,
        transcript_hint=transcript,
    )
    operations = [f"explicit_format_contract:{format_contract}", *format_operations]
    normalized_text = _normalize_command_result(rendered_text)
    return CommandControlResult(
        text=normalized_text,
        operations=_dedupe_operations(operations),
        format_contract=format_contract,
    )


def apply_format_contract(
    text: str,
    *,
    format_contract: Optional[str],
    transcript_hint: Optional[str] = None,
) -> Tuple[str, List[str]]:
    working = str(text or "").strip()
    if not working:
        return working, []

    contract = (format_contract or "").strip().lower()
    if not contract:
        return working, []

    operations: list[str] = []
    bullet_text, bullet_ops = spoken_points_to_bullets(working)
    transcript_bullets, transcript_bullet_ops = spoken_points_to_bullets(str(transcript_hint or "").strip())

    if contract in {"bullets", "checklist", "numbered"}:
        base_list = bullet_text or transcript_bullets or _lines_to_bullets(working) or _lines_to_bullets(str(transcript_hint or ""))
        if base_list:
            operations.extend(list(bullet_ops or transcript_bullet_ops or ["normalize_list_structure"]))
            if contract == "checklist":
                return _to_checklist(base_list), operations + ["format_checklist"]
            if contract == "numbered":
                return _to_numbered_list(base_list), operations + ["format_numbered_list"]
            return base_list, operations + ["normalize_literal_bullet_markers"]
        return working, operations

    if contract == "paragraph":
        if BULLET_LINE_PATTERN.search(working):
            collapsed = _collapse_bullets_to_paragraph(working)
            if collapsed and collapsed != working:
                return collapsed, ["collapse_bullets_to_paragraph"]
        return working, []

    if contract == "table":
        rendered_table = _render_table(working)
        if rendered_table:
            return rendered_table, ["render_table"]
        fallback_source = bullet_text or transcript_bullets or _lines_to_bullets(working)
        if fallback_source:
            return fallback_source, ["table_fallback_to_bullets"]
        return working, []

    return working, []


def enforce_surface_contract(text: str, context: Dict[str, Any]) -> Tuple[str, bool]:
    surface_kind = str(context.get("surface_kind") or "").strip().lower()
    if not surface_kind:
        return text, False

    if surface_kind in {"email_subject", "single_line_input", "search"}:
        lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
        if not lines:
            return str(text or "").strip(), False

        cleaned_lines = []
        for line in lines:
            cleaned = SUBJECT_PREFIX_PATTERN.sub("", line).strip(" -:\t")
            if not cleaned:
                continue
            if GREETING_LINE_PATTERN.match(cleaned) or SIGNOFF_LINE_PATTERN.match(cleaned):
                continue
            cleaned_lines.append(cleaned)

        final_line = cleaned_lines[0] if cleaned_lines else SUBJECT_PREFIX_PATTERN.sub("", lines[0]).strip(" -:\t")
        changed = final_line != str(text or "").strip()
        return final_line, changed

    return text, False


def _extract_format_contract(text: str) -> Tuple[Optional[str], str]:
    working = text
    chosen: Optional[str] = None
    for contract, pattern in FORMAT_COMMAND_PATTERNS:
        match = pattern.search(working)
        if not match:
            continue
        chosen = contract
        working = f"{working[:match.start()]} {working[match.end():]}".strip()
        break
    if chosen:
        return chosen, normalize_whitespace(working)
    lowered = normalize_whitespace(text).lower()
    if "numbered list" in lowered:
        return "numbered", text
    if "checklist" in lowered:
        return "checklist", text
    if "bullet" in lowered or "bulleted list" in lowered:
        return "bullets", text
    if "paragraph" in lowered and "point" in lowered:
        return "paragraph", text
    if "table" in lowered:
        return "table", text
    return None, text


def _extract_code_format_hint(text: str) -> Optional[str]:
    for hint, pattern in CODE_HINT_PATTERNS:
        if pattern.search(text):
            return hint
    return None


def _apply_replace_instruction(text: str) -> Tuple[str, bool]:
    matches = list(REPLACE_PATTERN.finditer(text))
    if not matches:
        return text, False

    latest = matches[-1]
    old = normalize_whitespace(latest.group("old"))
    new = normalize_whitespace(latest.group("new"))
    if not old or not new:
        return text, False

    prefix = normalize_whitespace(text[:latest.start()])
    suffix = normalize_whitespace(text[latest.end():])
    if prefix:
        lowered_prefix = prefix.lower()
        lowered_old = old.lower()
        replace_index = lowered_prefix.rfind(lowered_old)
        if replace_index >= 0:
            prefix = f"{prefix[:replace_index]}{new}{prefix[replace_index + len(old):]}"
    elif not suffix:
        prefix = new

    rebuilt = " ".join(part for part in (prefix, suffix) if part)
    return rebuilt or text, rebuilt != text


def _apply_scratch_that(text: str) -> Tuple[str, bool]:
    matches = list(SCRATCH_THAT_PATTERN.finditer(text))
    if not matches:
        return text, False
    latest = matches[-1]
    before = normalize_whitespace(text[:latest.start()])
    after = normalize_whitespace(text[latest.end():])
    if after:
        return after, True
    if not before:
        return "", True

    sentence_breaks = [before.rfind(delimiter) for delimiter in (".", "!", "?", "\n", ";", ",")]
    cutoff = max(sentence_breaks)
    if cutoff >= 0:
        trimmed = before[:cutoff].strip()
        return trimmed, trimmed != text
    return "", True


def _apply_remove_last_point(text: str) -> Tuple[str, bool]:
    if not REMOVE_LAST_POINT_PATTERN.search(text):
        return text, False
    stripped = REMOVE_LAST_POINT_PATTERN.sub(" ", text).strip()
    bullet_text, _ = spoken_points_to_bullets(stripped)
    if bullet_text:
        lines = [line for line in bullet_text.splitlines() if line.strip()]
        if len(lines) > 1:
            return "\n".join(lines[:-1]), True
        return "", True

    lines = [line for line in stripped.splitlines() if line.strip()]
    if len(lines) > 1:
        return "\n".join(lines[:-1]), True
    return stripped, stripped != text


def _replace_command(pattern: re.Pattern[str], text: str, replacement: str) -> Tuple[str, bool]:
    updated, count = pattern.subn(replacement, text)
    return updated, count > 0


def _apply_punctuation_commands(text: str) -> Tuple[str, List[str]]:
    working = text
    operations: list[str] = []
    for pattern, replacement in INLINE_TERMINAL_PUNCTUATION_COMMANDS:
        updated, count = pattern.subn(replacement, working)
        if count:
            operations.append(f"punctuation:{replacement}")
            working = updated
    for pattern, replacement in TERMINAL_PUNCTUATION_COMMANDS:
        updated, count = pattern.subn(replacement, working)
        if count:
            operations.append(f"punctuation:{replacement}")
            working = updated
    for pattern, replacement in PUNCTUATION_COMMANDS:
        updated, count = pattern.subn(replacement, working)
        if count:
            operations.append(f"punctuation:{replacement}")
            working = updated
    normalized = re.sub(r"\s+([,.;:!?])", r"\1", working)
    normalized = re.sub(r"([,.;:!?])([^\s\n])", r"\1 \2", normalized)
    normalized = re.sub(r":\s+\.", ":", normalized)
    normalized = re.sub(r"[ \t]{2,}", " ", normalized)
    working = normalized.strip()
    return working, operations


def _normalize_command_result(text: str) -> str:
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in str(text or "").splitlines()]
    cleaned_lines: list[str] = []
    previous_blank = False
    for line in lines:
        if not line:
            if previous_blank:
                continue
            cleaned_lines.append("")
            previous_blank = True
            continue
        cleaned_lines.append(re.sub(r"\s+([,.;!?])", r"\1", line))
        previous_blank = False
    return "\n".join(cleaned_lines).strip()


def _to_checklist(text: str) -> str:
    items = _extract_list_items(text)
    return "\n".join(f"- [ ] {item}" for item in items if item)


def _to_numbered_list(text: str) -> str:
    items = _extract_list_items(text)
    return "\n".join(f"{index}. {item}" for index, item in enumerate(items, start=1) if item)


def _collapse_bullets_to_paragraph(text: str) -> str:
    parts = []
    for raw_line in text.splitlines():
        stripped_line = raw_line.strip()
        if not stripped_line:
            continue
        if stripped_line.startswith(("-", "*")):
            stripped_line = stripped_line[1:].strip()
        numbered_match = NUMBERED_LIST_MARKER_PATTERN.match(stripped_line)
        if numbered_match:
            stripped_line = stripped_line[numbered_match.end():].strip()
        if stripped_line.startswith("[ ]"):
            stripped_line = stripped_line[3:].strip()
        parts.append(stripped_line)
    return " ".join(parts).strip()


def _render_table(text: str) -> Optional[str]:
    rows: list[tuple[str, str]] = []
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        if stripped.startswith(("-", "*")):
            stripped = stripped[1:].strip()
        match = COLON_PAIR_PATTERN.match(stripped)
        if not match:
            continue
        left = normalize_list_item(match.group(1))
        right = normalize_whitespace(match.group(2))
        if left and right:
            rows.append((left, right))
    if len(rows) < 2:
        return None

    header_left = "Item"
    header_right = "Details"
    left_width = max(len(header_left), *(len(left) for left, _ in rows))
    right_width = max(len(header_right), *(len(right) for _, right in rows))
    separator = f"| {'-' * left_width} | {'-' * right_width} |"
    lines = [
        f"| {header_left.ljust(left_width)} | {header_right.ljust(right_width)} |",
        separator,
    ]
    for left, right in rows:
        lines.append(f"| {left.ljust(left_width)} | {right.ljust(right_width)} |")
    return "\n".join(lines)


def _lines_to_bullets(text: str) -> Optional[str]:
    items, _ = extract_list_items_from_text(text, allow_delimited_fallback=True)
    if len(items) < 2:
        return None
    return "\n".join(f"- {item}" for item in items)


def _extract_list_items(text: str) -> List[str]:
    items: list[str] = []
    for raw_line in str(text or "").splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        if stripped.startswith(("-", "*")):
            stripped = stripped[1:].strip()
        numbered_match = NUMBERED_LIST_MARKER_PATTERN.match(stripped)
        if numbered_match:
            stripped = stripped[numbered_match.end():].strip()
        if stripped.startswith("[ ]"):
            stripped = stripped[3:].strip()
        normalized = normalize_whitespace(stripped)
        if normalized:
            items.append(normalized)
    return items


def _dedupe_operations(items: Iterable[str]) -> List[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for item in items:
        if not item or item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped
