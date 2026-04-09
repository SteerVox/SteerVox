from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional

from config.models import PrivacyConfig, SensitiveTargetRule


SENSITIVE_FIELD_TOKENS = (
    "password",
    "passcode",
    "verification code",
    "otp",
    "one time password",
    "security code",
    "cvv",
    "cvc",
    "routing number",
    "account number",
    "card number",
)
MEDICAL_CONTEXT_TOKENS = (
    "epic",
    "athenahealth",
    "cerner",
    "emr",
    "ehr",
    "clinical",
    "patient chart",
)


def _normalize_app_name(value: Optional[str]) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _normalize_host(value: Optional[str]) -> str:
    cleaned = str(value or "").strip().lower().removeprefix("https://").removeprefix("http://").strip("/")
    if "/" in cleaned:
        cleaned = cleaned.split("/", 1)[0]
    return cleaned


def _host_matches(rule_host: Optional[str], context_host: Optional[str]) -> bool:
    normalized_rule_host = _normalize_host(rule_host)
    normalized_context_host = _normalize_host(context_host)
    if not normalized_rule_host or not normalized_context_host:
        return False
    return normalized_context_host == normalized_rule_host or normalized_context_host.endswith(f".{normalized_rule_host}")


@dataclass(frozen=True)
class SensitiveTargetResolution:
    matched_rules: List[SensitiveTargetRule]
    minimize_context: bool
    block_external_text: bool


def resolve_sensitive_targets(context: Dict[str, Any], privacy: PrivacyConfig) -> SensitiveTargetResolution:
    matched: List[SensitiveTargetRule] = []
    bundle_id = str(context.get("bundle_id") or "").strip()
    url_host = str(context.get("url_host") or "").strip()
    app_name = _normalize_app_name(context.get("app_name"))

    for rule in privacy.sensitive_targets:
        if not rule.enabled:
            continue
        if bundle_id and rule.bundle_id and rule.bundle_id == bundle_id:
            matched.append(rule)
            continue
        if url_host and rule.url_host and _host_matches(rule.url_host, url_host):
            matched.append(rule)
            continue
        if app_name and not rule.bundle_id and not rule.url_host and _normalize_app_name(rule.app_name) == app_name:
            matched.append(rule)

    matched.extend(_resolve_builtin_rules(context))

    builtin_minimize_context = any(rule.mode == "minimize_context" and rule.id.startswith("builtin_") for rule in matched)
    minimize_context = builtin_minimize_context or (
        privacy.minimize_sensitive_context and any(rule.mode == "minimize_context" for rule in matched)
    )
    block_external_text = any(rule.mode == "block_external_text" for rule in matched)
    return SensitiveTargetResolution(
        matched_rules=matched,
        minimize_context=minimize_context,
        block_external_text=block_external_text,
    )


def _resolve_builtin_rules(context: Dict[str, Any]) -> List[SensitiveTargetRule]:
    builtins: List[SensitiveTargetRule] = []
    hint_text = " ".join(
        str(value or "").strip().lower()
        for value in (
            context.get("focused_field_label"),
            context.get("focused_field_placeholder"),
            context.get("focused_field_subrole"),
        )
        if value
    )
    combined_context = " ".join(
        str(value or "").strip().lower()
        for value in (
            context.get("app_name"),
            context.get("window_title"),
            context.get("page_title"),
            context.get("url_host"),
        )
        if value
    )

    if any(token in hint_text for token in SENSITIVE_FIELD_TOKENS):
        builtins.append(_builtin_rule("builtin_secure_field_context", "Sensitive field", "minimize_context"))
        builtins.append(_builtin_rule("builtin_secure_field_external", "Sensitive field", "block_external_text"))

    if any(token in combined_context for token in MEDICAL_CONTEXT_TOKENS):
        builtins.append(_builtin_rule("builtin_medical_context", "Medical context", "minimize_context"))
        builtins.append(_builtin_rule("builtin_medical_external", "Medical context", "block_external_text"))

    return builtins


def _builtin_rule(rule_id: str, label: str, mode: str) -> SensitiveTargetRule:
    return SensitiveTargetRule(
        id=rule_id,
        app_label=label,
        app_name=label,
        mode=mode,
        enabled=True,
    )


def minimize_context_fields(context: Dict[str, Any]) -> Dict[str, Any]:
    minimized = dict(context)
    for key in (
        "window_title",
        "page_title",
        "url_path",
        "focused_field_role",
        "focused_field_subrole",
        "focused_field_label",
        "focused_field_placeholder",
    ):
        minimized[key] = None
    return minimized


def suppress_external_text(
    *,
    selection_text: Optional[str],
    selection_truncated: bool,
    clipboard_text: Optional[str],
    clipboard_truncated: bool,
    suppress: bool,
) -> Dict[str, Any]:
    if not suppress:
        return {
            "selection_text": selection_text,
            "selection_truncated": selection_truncated,
            "clipboard_text": clipboard_text,
            "clipboard_truncated": clipboard_truncated,
        }
    return {
        "selection_text": None,
        "selection_truncated": False,
        "clipboard_text": None,
        "clipboard_truncated": False,
    }
