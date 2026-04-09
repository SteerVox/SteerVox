from __future__ import annotations

import re
from typing import Any, Dict, List, Literal, Optional, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator


DomainId = Literal["shipping", "medical"]
DomainMode = Literal["off", "auto", "shipping", "medical"]
DomainSource = Literal["none", "app_override", "global_pin", "system_rule"]

SUPPORTED_DOMAIN_IDS: tuple[str, ...] = tuple(get_args(DomainId))


class AppDomainDefault(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    app_label: str
    bundle_id: Optional[str] = None
    url_host: Optional[str] = None
    app_name: str
    domain_id: DomainId
    enabled: bool = True

    @field_validator("id", "app_label", "app_name")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Field cannot be empty.")
        return value.strip()

    @field_validator("domain_id", mode="before")
    @classmethod
    def validate_domain_id(cls, value: object) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(
                "domain_id must be one of: " + ", ".join(SUPPORTED_DOMAIN_IDS)
            )
        cleaned = value.strip().lower()
        if cleaned not in SUPPORTED_DOMAIN_IDS:
            raise ValueError(
                f"Unknown domain_id {cleaned!r}. Supported domains: "
                + ", ".join(SUPPORTED_DOMAIN_IDS)
            )
        return cleaned

    @field_validator("bundle_id")
    @classmethod
    def normalize_bundle_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("url_host")
    @classmethod
    def normalize_url_host(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip().lower().removeprefix("https://").removeprefix("http://").strip("/")
        if "/" in cleaned:
            cleaned = cleaned.split("/", 1)[0]
        return cleaned or None


class DomainsConfig(BaseModel):
    mode: DomainMode = Field(default="off", description="Controls whether domain packs are off, automatically inferred, or pinned to a specific domain.")
    app_domain_defaults: List[AppDomainDefault] = Field(
        default_factory=list,
        description="Optional app-specific or host-specific domain overrides.",
    )


class GlossaryEntry(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    term: str
    aliases: List[str] = Field(default_factory=list)
    kind: Optional[str] = None
    priority: int = 0

    @field_validator("term")
    @classmethod
    def require_term(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Glossary terms cannot be empty.")
        return value.strip()

    @field_validator("aliases", mode="before")
    @classmethod
    def normalize_aliases(cls, value: object) -> List[str]:
        if value is None:
            return []
        if isinstance(value, str):
            items = [segment.strip() for segment in value.split(",")]
        elif isinstance(value, list):
            items = [str(segment).strip() for segment in value]
        else:
            raise ValueError("Aliases must be a string or a list of strings.")

        seen = set()
        normalized: List[str] = []
        for item in items:
            if not item:
                continue
            lowered = item.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            normalized.append(item)
        return normalized


class TemplateEntry(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    label: str
    intent: str
    body: str
    priority: int = 0

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z0-9_]+", value.strip()):
            raise ValueError("Template id must contain only lowercase letters, numbers, and underscores.")
        return value.strip()

    @field_validator("label", "intent", "body")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Template fields cannot be empty.")
        return value.strip()


class ExampleEntry(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    label: str
    intent: str
    output: str
    priority: int = 0

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z0-9_]+", value.strip()):
            raise ValueError("Example id must contain only lowercase letters, numbers, and underscores.")
        return value.strip()

    @field_validator("label", "intent", "output")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Example fields cannot be empty.")
        return value.strip()


class DomainControls(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    default_format: Literal["auto", "bullets", "paragraph", "table"] = "auto"
    default_surface_behavior: Literal["auto", "email", "note", "summary"] = "auto"
    suppress_external_text: bool = False
    minimize_context_capture: bool = False
    tone: str = "clear"
    audience: str = "general"

    @field_validator("tone", "audience")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        cleaned = value.strip()
        return cleaned or "general"


class DomainPack(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: DomainId
    label: str
    description: str
    documentation_only: bool = False
    default_intent: str
    glossary: List[GlossaryEntry] = Field(default_factory=list)
    templates: List[TemplateEntry] = Field(default_factory=list)
    examples: List[ExampleEntry] = Field(default_factory=list)
    styles: Dict[str, str] = Field(default_factory=dict)
    controls: DomainControls = Field(default_factory=DomainControls)

    @field_validator("label", "description", "default_intent")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Domain pack metadata cannot be empty.")
        return value.strip()

    @field_validator("styles", mode="before")
    @classmethod
    def normalize_styles(cls, value: object) -> Dict[str, str]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("styles must be an object.")

        normalized: Dict[str, str] = {}
        for key, raw_value in value.items():
            cleaned_key = str(key).strip()
            cleaned_value = str(raw_value).strip()
            if not cleaned_key or not cleaned_value:
                continue
            normalized[cleaned_key] = cleaned_value
        return normalized


class DomainPackSummary(BaseModel):
    id: DomainId
    label: str
    description: str
    documentation_only: bool = False
    bundled: bool = True
    overlay_present: bool = False
    last_imported_at: Optional[str] = None
    glossary_count: int = 0
    template_count: int = 0
    example_count: int = 0
    controls: DomainControls = Field(default_factory=DomainControls)


class DomainPackContent(BaseModel):
    glossary: List[GlossaryEntry] = Field(default_factory=list)
    templates: List[TemplateEntry] = Field(default_factory=list)
    examples: List[ExampleEntry] = Field(default_factory=list)
    styles: Dict[str, str] = Field(default_factory=dict)
    controls: DomainControls = Field(default_factory=DomainControls)


class DomainOverlayContent(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    glossary: List[GlossaryEntry] = Field(default_factory=list)
    templates: List[TemplateEntry] = Field(default_factory=list)
    examples: List[ExampleEntry] = Field(default_factory=list)
    styles: Dict[str, str] = Field(default_factory=dict)
    controls: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("styles", mode="before")
    @classmethod
    def normalize_overlay_styles(cls, value: object) -> Dict[str, str]:
        return DomainPack.normalize_styles(value)

    @field_validator("controls", mode="before")
    @classmethod
    def normalize_controls(cls, value: object) -> Dict[str, Any]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("controls must be an object.")

        normalized: Dict[str, Any] = {}
        allowed_keys = set(DomainControls.model_fields.keys())
        for key, raw_value in value.items():
            cleaned_key = str(key).strip()
            if cleaned_key not in allowed_keys:
                continue
            if cleaned_key in {"suppress_external_text", "minimize_context_capture"}:
                normalized[cleaned_key] = bool(raw_value) if isinstance(raw_value, bool) else str(raw_value).strip().lower() in {"1", "true", "yes"}
            else:
                cleaned_value = str(raw_value).strip()
                if cleaned_value:
                    normalized[cleaned_key] = cleaned_value
        return normalized


class DomainPackOverlay(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: DomainId
    label: str
    description: str
    documentation_only: bool = False
    default_intent: str
    glossary: List[GlossaryEntry] = Field(default_factory=list)
    templates: List[TemplateEntry] = Field(default_factory=list)
    examples: List[ExampleEntry] = Field(default_factory=list)
    styles: Dict[str, str] = Field(default_factory=dict)
    controls: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("label", "description", "default_intent")
    @classmethod
    def require_overlay_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Domain pack metadata cannot be empty.")
        return value.strip()

    @field_validator("styles", mode="before")
    @classmethod
    def normalize_overlay_styles(cls, value: object) -> Dict[str, str]:
        return DomainPack.normalize_styles(value)

    @field_validator("controls", mode="before")
    @classmethod
    def normalize_overlay_controls(cls, value: object) -> Dict[str, Any]:
        return DomainOverlayContent.normalize_controls(value)


class DomainPackDetail(BaseModel):
    id: DomainId
    label: str
    description: str
    documentation_only: bool = False
    default_intent: str
    bundled: bool = True
    overlay_present: bool = False
    last_imported_at: Optional[str] = None
    effective: DomainPackContent = Field(default_factory=DomainPackContent)
    overlay: DomainOverlayContent = Field(default_factory=DomainOverlayContent)


class DomainImportPayload(BaseModel):
    domain_id: DomainId
    overlay: DomainPackOverlay


class DomainExportPayload(BaseModel):
    domain_id: DomainId
    overlay: DomainPackOverlay
