from __future__ import annotations

import re
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


SkillOutputMode = Literal["plain_text", "bullets", "command", "code"]


class SkillDefinition(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    name: str
    prompt: str
    description: Optional[str] = None
    triggers: List[str] = Field(default_factory=list)
    target_types: List[str] = Field(default_factory=list)
    max_chars: Optional[int] = Field(default=None, ge=1)
    style: Optional[str] = None
    fallback_behavior: str = "selected_skill"
    output_mode: SkillOutputMode = "plain_text"

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not re.fullmatch(r"[a-z0-9_]+", value):
            raise ValueError("Skill id must contain only lowercase letters, numbers, and underscores.")
        return value

    @field_validator("name", "prompt")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Field cannot be empty.")
        return value

    @field_validator("triggers", "target_types", mode="before")
    @classmethod
    def normalize_string_list(cls, value: object) -> List[str]:
        if value is None:
            return []
        if isinstance(value, str):
            items = [segment.strip() for segment in value.split(",")]
        elif isinstance(value, list):
            items = [str(segment).strip() for segment in value]
        else:
            raise ValueError("Expected a string or list of strings.")

        seen = set()
        normalized: List[str] = []
        for item in items:
            if not item:
                continue
            lowered = item.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            normalized.append(lowered)
        return normalized

    @field_validator("style")
    @classmethod
    def normalize_style(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("fallback_behavior")
    @classmethod
    def normalize_fallback(cls, value: str) -> str:
        cleaned = value.strip() if value else "selected_skill"
        return cleaned or "selected_skill"


class SkillPackageManifest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    name: str
    description: Optional[str] = None
    version: int = Field(default=1, ge=1)
    triggers: List[str] = Field(default_factory=list)
    target_types: List[str] = Field(default_factory=list)
    max_chars: Optional[int] = Field(default=None, ge=1)
    style: Optional[str] = None
    fallback_behavior: str = "selected_skill"
    output_mode: SkillOutputMode = "plain_text"

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return SkillDefinition.validate_id(value)

    @field_validator("name")
    @classmethod
    def require_name(cls, value: str) -> str:
        return SkillDefinition.require_text(value)

    @field_validator("triggers", "target_types", mode="before")
    @classmethod
    def normalize_string_list(cls, value: object) -> List[str]:
        return SkillDefinition.normalize_string_list(value)

    @field_validator("style")
    @classmethod
    def normalize_style(cls, value: Optional[str]) -> Optional[str]:
        return SkillDefinition.normalize_style(value)

    @field_validator("fallback_behavior")
    @classmethod
    def normalize_fallback(cls, value: str) -> str:
        return SkillDefinition.normalize_fallback(value)


class SkillPackageDiagnostic(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: Optional[str] = None
    package_path: str
    severity: Literal["warning", "error"] = "warning"
    message: str
