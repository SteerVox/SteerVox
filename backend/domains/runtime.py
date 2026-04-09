from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .models import DomainPack, TemplateEntry, ExampleEntry


LOWERCASE_MEDICAL_TERMS = {"follow-up"}
LOWERCASE_SHIPPING_TERMS = {"container number", "shipment id"}
MULTISPACE_PATTERN = re.compile(r"\s+")


@dataclass(frozen=True)
class GlossaryCorrectionResult:
    text: str
    hits: List[str]


@dataclass(frozen=True)
class DomainRetrievalResult:
    block: str
    template_id: Optional[str]
    example_id: Optional[str]
    glossary_hits: List[str]


@dataclass(frozen=True)
class DomainIntentResolution:
    baseline_intent: str
    domain_intent: str
    preferred_skill_id: Optional[str]
    reason: str


def apply_glossary_corrections(text: str, domain_pack: Optional[DomainPack]) -> GlossaryCorrectionResult:
    if not domain_pack or not text.strip():
        return GlossaryCorrectionResult(text=text, hits=[])

    working = text
    hits: List[str] = []
    replacements: List[tuple[str, str]] = []
    for entry in sorted(domain_pack.glossary, key=lambda item: (item.priority, len(item.term)), reverse=True):
        for alias in [entry.term, *entry.aliases]:
            cleaned_alias = alias.strip()
            if not cleaned_alias:
                continue
            replacements.append((cleaned_alias, entry.term))

    for alias, canonical in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        pattern = re.compile(rf"(?<!\w){re.escape(alias)}(?!\w)", re.IGNORECASE)
        if not pattern.search(working):
            continue

        replacement = _format_canonical(domain_pack.id, canonical)
        working = pattern.sub(replacement, working)
        if canonical not in hits:
            hits.append(canonical)

    return GlossaryCorrectionResult(text=MULTISPACE_PATTERN.sub(" ", working).strip(), hits=hits[:12])


def resolve_domain_intent(
    *,
    domain_pack: Optional[DomainPack],
    transcript: str,
    context: Dict[str, Any],
) -> DomainIntentResolution:
    baseline_intent = _resolve_baseline_intent(transcript, context)
    if not domain_pack:
        return DomainIntentResolution(
            baseline_intent=baseline_intent,
            domain_intent=baseline_intent,
            preferred_skill_id=None,
            reason="No active domain pack.",
        )

    normalized = transcript.lower()
    if domain_pack.id == "shipping":
        if any(token in normalized for token in ("delay", "delayed", "late", "running behind", "missed eta")):
            domain_intent = "delay_notification"
        elif any(token in normalized for token in ("incident", "exception", "damaged", "customs hold", "discrepancy", "problem")):
            domain_intent = "incident_exception_summary"
        elif any(
            token in normalized
            for token in ("customer", "client", "reply", "respond", "coordinate", "customer update", "carrier update")
        ):
            domain_intent = "customer_coordination_reply"
        elif any(
            token in normalized
            for token in (
                "handoff",
                "hand off",
                "handover",
                "hand over",
                "handover update",
                "next shift",
                "shift handoff",
                "shift summary",
                "shift update",
                "ops note",
                "operations note",
                "warehouse note",
            )
        ):
            domain_intent = "operations_note"
        else:
            domain_intent = "shipment_update"
    else:
        if any(token in normalized for token in ("follow up", "follow-up", "follow-up note", "recheck")):
            domain_intent = "patient_follow_up_summary"
        elif any(token in normalized for token in ("referral", "referral note", "handoff", "handoff note", "hand off", "transfer")):
            domain_intent = "referral_handoff_note"
        elif any(token in normalized for token in ("discharge", "discharge note", "visit summary", "after visit", "visit note", "patient summary")):
            domain_intent = "discharge_visit_summary"
        elif any(token in normalized for token in ("care team", "care team note", "internal update", "team update")):
            domain_intent = "care_team_update"
        else:
            domain_intent = "clinical_note_draft"

    preferred_skill_id = _resolve_preferred_skill(domain_pack.id, domain_intent, baseline_intent, context)
    return DomainIntentResolution(
        baseline_intent=baseline_intent,
        domain_intent=domain_intent,
        preferred_skill_id=preferred_skill_id,
        reason=f"Resolved {domain_pack.id} domain intent {domain_intent} from transcript and context.",
    )


def build_domain_retrieval_block(
    *,
    domain_pack: Optional[DomainPack],
    domain_intent: Optional[str],
    glossary_hits: List[str],
    char_cap: int = 1400,
) -> DomainRetrievalResult:
    if not domain_pack or not domain_intent:
        return DomainRetrievalResult(block="", template_id=None, example_id=None, glossary_hits=[])

    template = _select_template(domain_pack.templates, domain_intent)
    example = _select_example(domain_pack.examples, domain_intent)
    relevant_hits = glossary_hits[:10]

    lines = [
        f"Domain Pack: {domain_pack.label}",
        f"Domain Intent: {domain_intent}",
    ]
    if domain_pack.documentation_only:
        lines.append("Boundary: documentation assistance only. Do not add diagnosis or treatment advice.")
    if relevant_hits:
        lines.append("Relevant glossary terms:")
        lines.extend(f"- {term}" for term in relevant_hits[:8])
    controls = domain_pack.controls
    if controls.default_format != "auto":
        lines.append(f"Preferred format: {controls.default_format}")
    if controls.default_surface_behavior != "auto":
        lines.append(f"Preferred surface behavior: {controls.default_surface_behavior}")
    if controls.tone:
        lines.append(f"Preferred tone: {controls.tone}")
    if controls.audience:
        lines.append(f"Preferred audience: {controls.audience}")
    if controls.suppress_external_text:
        lines.append("External selected or clipboard text is suppressed for this domain unless the user changes the domain controls.")
    if controls.minimize_context_capture:
        lines.append("Context capture is intentionally minimized for this domain.")
    if template:
        lines.append(f"Preferred template ({template.label}):")
        lines.append(template.body)
    if example:
        lines.append(f"Reference example ({example.label}):")
        lines.append(example.output)
    if domain_pack.styles:
        lines.append("Style preferences:")
        for key, value in list(domain_pack.styles.items())[:6]:
            lines.append(f"- {key}: {value}")

    block = "\n".join(lines).strip()
    if len(block) > char_cap:
        block = block[: char_cap - 3].rstrip() + "..."

    return DomainRetrievalResult(
        block=block,
        template_id=template.id if template else None,
        example_id=example.id if example else None,
        glossary_hits=relevant_hits,
    )


def _resolve_baseline_intent(transcript: str, context: Dict[str, Any]) -> str:
    normalized = transcript.lower()
    combined = " ".join(
        str(part).lower()
        for part in (
            context.get("app_name"),
            context.get("window_title"),
            context.get("page_title"),
            context.get("url_host"),
            context.get("target_type"),
        )
        if part
    )

    if any(token in normalized for token in ("handoff", "next shift", "handover", "hand off")):
        return "handoff_update"
    if any(token in normalized for token in ("summary", "summarize", "bullet", "overview")):
        return "structured_summary"
    if any(token in normalized for token in ("reply", "respond", "email", "send this", "message back")) or any(
        token in combined for token in ("gmail", "outlook", "mail", "slack", "teams", "discord")
    ):
        return "external_reply"
    if any(token in normalized for token in ("note", "document", "record", "chart")):
        return "internal_note"
    return "default_rewrite"


def _resolve_preferred_skill(domain_id: str, domain_intent: str, baseline_intent: str, context: Dict[str, Any]) -> Optional[str]:
    combined = " ".join(
        str(part).lower()
        for part in (
            context.get("app_name"),
            context.get("window_title"),
            context.get("page_title"),
            context.get("target_type"),
        )
        if part
    )
    if domain_id == "shipping":
        if domain_intent in {"delay_notification", "customer_coordination_reply"}:
            return "system_domain_email"
        if domain_intent == "shipment_update":
            if baseline_intent == "external_reply" or any(token in combined for token in ("mail", "gmail", "outlook", "customer", "reply", "message")):
                return "system_domain_email"
            return "system_domain_structured_note"
        if domain_intent in {"operations_note", "incident_exception_summary"}:
            return "system_domain_structured_note"
    if domain_id == "medical":
        return "system_domain_structured_note"
    if baseline_intent in {"structured_summary", "handoff_update", "internal_note"}:
        return "system_domain_structured_note"
    return None


def _select_template(templates: List[TemplateEntry], domain_intent: str) -> Optional[TemplateEntry]:
    matches = [template for template in templates if template.intent == domain_intent]
    if not matches:
        return None
    return sorted(matches, key=lambda item: (item.priority, item.label), reverse=True)[0]


def _select_example(examples: List[ExampleEntry], domain_intent: str) -> Optional[ExampleEntry]:
    matches = [example for example in examples if example.intent == domain_intent]
    if not matches:
        return None
    return sorted(matches, key=lambda item: (item.priority, item.label), reverse=True)[0]


def _format_canonical(domain_id: str, canonical: str) -> str:
    if domain_id == "medical" and canonical.lower() in LOWERCASE_MEDICAL_TERMS:
        return canonical.lower()
    if domain_id == "shipping" and canonical.lower() in LOWERCASE_SHIPPING_TERMS:
        return canonical.lower()
    if canonical.isupper() or len(canonical) <= 4:
        return canonical.upper()
    return canonical
