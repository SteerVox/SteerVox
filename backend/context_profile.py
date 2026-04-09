from __future__ import annotations

import re
from typing import Any, Dict, Optional

DOC_HOSTS = (
    "docs.google.com",
    "notion.so",
    "notion.site",
    "coda.io",
    "quip.com",
)

FORM_HOSTS = (
    "forms.google.com",
    "typeform.com",
    "airtable.com",
    "tally.so",
)

CHAT_APP_KEYWORDS = (
    "slack",
    "discord",
    "messages",
    "signal",
    "telegram",
    "teams",
)

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
    "share your thoughts",
    "caption",
    "post",
)

IDE_APP_KEYWORDS = (
    "antigravity",
    "cloud code",
    "cloudcode",
    "codex",
    "cursor",
    "code",
    "windsurf",
    "visual studio code",
    "terminal",
    "iterm",
    "pycharm",
    "webstorm",
    "intellij",
)

CODE_FILE_PATTERN = re.compile(
    r"(?P<filename>[A-Za-z0-9._-]+\.(?P<extension>py|ts|tsx|js|jsx|java|go|rb|rs|php|swift|kt|json|ya?ml|toml|md|sql|sh|zsh|html|css|scss|c|cc|cpp|h|hpp))",
    re.IGNORECASE,
)


def normalize_context(context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = context or {}
    normalized = {
        "app_name": payload.get("app_name") or "Unknown",
        "bundle_id": payload.get("bundle_id") or None,
        "window_title": payload.get("window_title") or None,
        "page_title": payload.get("page_title") or None,
        "url_host": payload.get("url_host") or None,
        "url_path": payload.get("url_path") or None,
        "focused_field_role": payload.get("focused_field_role") or None,
        "focused_field_subrole": payload.get("focused_field_subrole") or None,
        "focused_field_label": payload.get("focused_field_label") or None,
        "focused_field_placeholder": payload.get("focused_field_placeholder") or None,
    }
    normalized["code_file_name"] = infer_code_file_name(normalized)
    normalized["code_file_extension"] = infer_code_file_extension(normalized)
    normalized["surface_kind"] = derive_surface_kind(normalized)
    return normalized


def derive_context_quality(context: Dict[str, Any], warning: Optional[str] = None) -> str:
    app_name = context.get("app_name")
    has_app = bool(app_name and app_name != "Unknown")
    has_window = bool(context.get("window_title"))
    has_browser = bool(context.get("page_title") or context.get("url_host") or context.get("url_path"))

    if has_app and has_browser:
        return "full"
    if has_app or has_window:
        return "app_only"
    if warning:
        return "transcript_only"
    return "empty"


def derive_target_type(context: Dict[str, Any]) -> Optional[str]:
    app_name = (context.get("app_name") or "").lower()
    bundle_id = (context.get("bundle_id") or "").lower()
    window_title = (context.get("window_title") or "").lower()
    page_title = (context.get("page_title") or "").lower()
    url_host = (context.get("url_host") or "").lower()
    url_path = (context.get("url_path") or "").lower()
    focused_field_label = (context.get("focused_field_label") or "").lower()
    focused_field_placeholder = (context.get("focused_field_placeholder") or "").lower()
    focused_field_subrole = (context.get("focused_field_subrole") or "").lower()

    combined = " ".join(filter(None, [
        app_name,
        bundle_id,
        window_title,
        page_title,
        url_path,
        focused_field_label,
        focused_field_placeholder,
        focused_field_subrole,
    ]))

    if any(host in url_host for host in FORM_HOSTS):
        return "form"
    if any(host in url_host for host in DOC_HOSTS):
        return "browser_doc"
    if any(host in url_host for host in SOCIAL_HOSTS) and any(hint in combined for hint in SOCIAL_COMPOSE_HINTS):
        return "social_post"
    if any(keyword in combined for keyword in CHAT_APP_KEYWORDS):
        return "chat"
    if any(keyword in combined for keyword in IDE_APP_KEYWORDS):
        return "ide"
    if "form" in combined or "survey" in combined:
        return "form"
    return "generic" if combined or url_host else None


def derive_surface_kind(context: Dict[str, Any]) -> Optional[str]:
    target_type = derive_target_type(context)
    role = (context.get("focused_field_role") or "").strip().lower()
    subrole = (context.get("focused_field_subrole") or "").strip().lower()
    hint_text = " ".join(
        str(value).strip().lower()
        for value in (
            context.get("focused_field_label"),
            context.get("focused_field_placeholder"),
        )
        if value
    )

    if "subject" in hint_text or "subject" in subrole:
        return "email_subject"
    if role == "axsearchfield" or "search" in hint_text or "find" in hint_text:
        return "search"
    if any(token in hint_text for token in ("message body", "email body", "compose", "reply", "message")):
        return "email_body"
    if target_type == "social_post" and any(token in hint_text for token in SOCIAL_COMPOSE_HINTS):
        return "social_compose"
    if role == "axtextarea":
        if target_type == "social_post":
            return "social_compose"
        if target_type == "browser_doc":
            return "structured_editor"
        if target_type == "chat":
            return "chat_input"
        return "multiline_input"
    if role in {"axtextfield", "axcombobox"}:
        if target_type == "social_post":
            return "social_compose"
        if target_type == "chat":
            return "chat_input"
        return "single_line_input"
    if target_type == "browser_doc":
        return "structured_editor"
    return "generic" if target_type or role or hint_text else None


def infer_code_file_name(context: Dict[str, Any]) -> Optional[str]:
    searchable = " ".join(
        str(value or "")
        for value in (
            context.get("window_title"),
            context.get("page_title"),
            context.get("focused_field_label"),
            context.get("focused_field_placeholder"),
        )
    )
    match = CODE_FILE_PATTERN.search(searchable)
    if not match:
        return None
    return match.group("filename")


def infer_code_file_extension(context: Dict[str, Any]) -> Optional[str]:
    filename = infer_code_file_name(context)
    if not filename or "." not in filename:
        return None
    return filename.rsplit(".", 1)[-1].lower()


def has_meaningful_context(context: Optional[Dict[str, Any]]) -> bool:
    if not context:
        return False

    normalized = normalize_context(context)
    return any([
        normalized.get("app_name") and normalized["app_name"] != "Unknown",
        normalized.get("window_title"),
        normalized.get("page_title"),
        normalized.get("url_host"),
        normalized.get("url_path"),
    ])
