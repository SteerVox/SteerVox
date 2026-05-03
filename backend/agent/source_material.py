from __future__ import annotations

import re


INLINE_SOURCE_REQUEST_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(make this(?: sound)?(?: more)? professional)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? polite)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? clear(?:er)?)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? concise)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? short(?:er)?)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(rewrite this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(rephrase this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(polish this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(polish this prompt)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(clean this up)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(turn this into (?:bullets?|a checklist|bullet points?|action items?))\s+(.+)$", re.IGNORECASE),
)


def normalize_whitespace(text: str) -> str:
    return " ".join(str(text or "").split()).strip()


def extract_inline_source_request(transcript: str) -> tuple[str, str] | None:
    normalized = normalize_whitespace(transcript)
    if not normalized:
        return None
    for pattern in INLINE_SOURCE_REQUEST_PATTERNS:
        match = pattern.match(normalized)
        if not match:
            continue
        instruction = normalize_whitespace(match.group(1))
        source_text = normalize_whitespace(match.group(2))
        if instruction and source_text:
            return instruction, source_text
    return None
