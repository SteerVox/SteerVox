from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Optional

from utils.logger import get_logger

from .models import SUPPORTED_DOMAIN_IDS, DomainsConfig


logger = get_logger()
WHITESPACE_PATTERN = re.compile(r"\s+")
_WARNED_UNKNOWN_DOMAIN_IDS: set[str] = set()


def _warn_unknown_domain_id_once(domain_id: str, source: str) -> None:
    """Log unknown domain ids once per process to avoid log spam."""
    key = f"{source}:{domain_id}"
    if key in _WARNED_UNKNOWN_DOMAIN_IDS:
        return
    _WARNED_UNKNOWN_DOMAIN_IDS.add(key)
    logger.warning(
        "Ignoring unknown domain id %r from %s. Supported domains: %s",
        domain_id,
        source,
        ", ".join(SUPPORTED_DOMAIN_IDS),
    )


@dataclass(frozen=True)
class DomainSelection:
    domain_id: Optional[str]
    source: str = "none"
    rule_id: Optional[str] = None
    rule_label: Optional[str] = None


@dataclass(frozen=True)
class StarterDomainRule:
    id: str
    label: str
    domain_id: str
    bundle_id: Optional[str] = None
    url_host: Optional[str] = None
    app_name: Optional[str] = None
    title_contains: Optional[str] = None
    browser_only: bool = False


STARTER_DOMAIN_RULES = (
    StarterDomainRule(id="shipping_project44", label="project44", domain_id="shipping", url_host="project44.com"),
    StarterDomainRule(id="shipping_fourkites", label="FourKites", domain_id="shipping", url_host="fourkites.com"),
    StarterDomainRule(id="shipping_shippo", label="Shippo", domain_id="shipping", url_host="goshippo.com"),
    StarterDomainRule(id="shipping_shipstation", label="ShipStation", domain_id="shipping", url_host="shipstation.com"),
    StarterDomainRule(id="shipping_flexport", label="Flexport", domain_id="shipping", url_host="flexport.com"),
    StarterDomainRule(id="medical_athena", label="athenahealth", domain_id="medical", url_host="athenahealth.com"),
    StarterDomainRule(id="medical_epic", label="Epic", domain_id="medical", app_name="Epic"),
    StarterDomainRule(id="medical_cerner", label="Cerner", domain_id="medical", app_name="Cerner"),
    StarterDomainRule(id="shipping_shipment_title", label="Shipment", domain_id="shipping", title_contains="shipment"),
    StarterDomainRule(id="shipping_logistics_title", label="Logistics", domain_id="shipping", title_contains="logistics"),
    StarterDomainRule(id="shipping_dispatch_title", label="Dispatch", domain_id="shipping", title_contains="dispatch"),
    StarterDomainRule(id="shipping_warehouse_title", label="Warehouse", domain_id="shipping", title_contains="warehouse"),
    StarterDomainRule(id="shipping_customs_title", label="Customs", domain_id="shipping", title_contains="customs"),
    StarterDomainRule(id="shipping_container_title", label="Container", domain_id="shipping", title_contains="container"),
    StarterDomainRule(id="medical_patient_title", label="Patient", domain_id="medical", title_contains="patient"),
    StarterDomainRule(id="medical_clinical_title", label="Clinical", domain_id="medical", title_contains="clinical"),
    StarterDomainRule(id="medical_chart_title", label="Chart", domain_id="medical", title_contains="chart"),
    StarterDomainRule(id="medical_referral_title", label="Referral", domain_id="medical", title_contains="referral"),
    StarterDomainRule(id="medical_discharge_title", label="Discharge", domain_id="medical", title_contains="discharge"),
    StarterDomainRule(id="medical_visit_title", label="Visit Summary", domain_id="medical", title_contains="visit summary"),
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


def _find_matching_override(overrides, context: Dict[str, Any]):
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


def _find_matching_starter_rule(context: Dict[str, Any]) -> Optional[StarterDomainRule]:
    bundle_id = str(context.get("bundle_id") or "").strip()
    if bundle_id:
        for rule in STARTER_DOMAIN_RULES:
            if rule.bundle_id == bundle_id:
                return rule

    url_host = context.get("url_host")
    if url_host:
        for rule in STARTER_DOMAIN_RULES:
            if rule.url_host and _host_matches(rule.url_host, url_host):
                return rule

    normalized_title_text = _normalize_title_text(context)
    if normalized_title_text:
        for rule in STARTER_DOMAIN_RULES:
            if not rule.title_contains:
                continue
            if rule.browser_only and not _is_browser_context(context):
                continue
            if rule.title_contains in normalized_title_text:
                return rule

    normalized_app_name = normalize_app_name(context.get("app_name"))
    if normalized_app_name:
        for rule in STARTER_DOMAIN_RULES:
            if rule.app_name and normalize_app_name(rule.app_name) == normalized_app_name:
                return rule

    return None


def resolve_domain(*, context: Dict[str, Any], domains: DomainsConfig) -> DomainSelection:
    matched_override = _find_matching_override(domains.app_domain_defaults, context)
    if matched_override:
        if matched_override.domain_id not in SUPPORTED_DOMAIN_IDS:
            _warn_unknown_domain_id_once(
                matched_override.domain_id,
                f"app_domain_defaults[{matched_override.id}]",
            )
        else:
            return DomainSelection(
                domain_id=matched_override.domain_id,
                source="app_override",
                rule_id=matched_override.id,
                rule_label=matched_override.app_label,
            )

    if domains.mode in {"shipping", "medical"}:
        return DomainSelection(domain_id=domains.mode, source="global_pin")

    if domains.mode != "auto":
        return DomainSelection(domain_id=None)

    matched_rule = _find_matching_starter_rule(context)
    if matched_rule:
        if matched_rule.domain_id not in SUPPORTED_DOMAIN_IDS:
            _warn_unknown_domain_id_once(
                matched_rule.domain_id,
                f"starter_rule[{matched_rule.id}]",
            )
        else:
            return DomainSelection(
                domain_id=matched_rule.domain_id,
                source="system_rule",
                rule_id=matched_rule.id,
                rule_label=matched_rule.label,
            )

    return DomainSelection(domain_id=None)
