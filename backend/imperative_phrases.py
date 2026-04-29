from __future__ import annotations

import re


MULTISPACE_PATTERN = re.compile(r"\s+")
LEADING_IMPERATIVE_FILLER_PATTERN = re.compile(
    r"^(?:(?:please|kindly|just|now)\s+|"
    r"(?:can|could|would|will)\s+you(?:\s+please)?\s+|"
    r"(?:please\s+)?(?:i\s+need\s+you\s+to|i\s+want\s+you\s+to)\s+|"
    r"(?:hey|ok|okay)\s+)+",
    re.IGNORECASE,
)
TRAILING_IMPERATIVE_FILLER_PATTERN = re.compile(
    r"(?:\s+(?:please|thanks|thank you|for me|right now|real quick))+$",
    re.IGNORECASE,
)


def normalize_imperative_phrase(text: str) -> str:
    cleaned = MULTISPACE_PATTERN.sub(" ", str(text or "")).strip()
    if not cleaned:
        return ""

    while True:
        next_cleaned = LEADING_IMPERATIVE_FILLER_PATTERN.sub("", cleaned).strip()
        if next_cleaned == cleaned:
            break
        cleaned = next_cleaned

    while True:
        next_cleaned = TRAILING_IMPERATIVE_FILLER_PATTERN.sub("", cleaned).strip()
        if next_cleaned == cleaned:
            break
        cleaned = next_cleaned

    return cleaned.strip(" \t\r\n.,;:!?")
