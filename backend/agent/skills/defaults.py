from __future__ import annotations

from pathlib import Path
from typing import ClassVar, List

import yaml

from utils.paths import resolve_runtime_path

from .models import SkillDefinition


SYSTEM_REGISTRY_PATH = Path(__file__).with_name("system_registry.yaml")


def get_system_registry_path() -> Path:
    return resolve_runtime_path("agent", "skills", "system_registry.yaml")


class DefaultSkills:
    """
    Loads the built-in, un-deletable system skills from the bundled registry.
    """

    _ALIAS_TO_ID: ClassVar[dict[str, str]] = {
        "DICTATION": "system_dictation",
        "GRAMMAR_FIX": "system_grammar",
        "STRICT_GRAMMAR": "strict_grammar",
        "SYSTEM_REWRITE": "system_rewrite",
        "CHAT_REPLY": "system_chat_reply",
        "EMAIL_DRAFT": "system_email_draft",
        "SOCIAL_POST": "system_social_post",
        "DOMAIN_EMAIL": "system_domain_email",
        "TERMINAL_COMMAND": "system_terminal",
        "CODE_SNIPPET": "system_code",
        "ISSUE_TICKET": "system_issue_ticket",
        "DOC_NOTES": "system_doc_notes",
        "DOMAIN_STRUCTURED_NOTE": "system_domain_structured_note",
        "BULLET_SUMMARY": "system_bullets",
        "CODEX_PROMPT": "system_codex_prompt",
        "ANTIGRAVITY_PROMPT": "system_antigravity_prompt",
        "CLOUD_CODE_PROMPT": "system_cloud_code_prompt",
        "AI_CHAT_PROMPT": "system_ai_chat_prompt",
        "PROMPT_ARCHITECT": "system_prompt_architect",
        "AGENT_ACTION_BUILDER": "system_agent_action_builder",
        "ACTION_EXECUTION": "system_action_execution",
        "TRANSLATE": "system_translate",
    }
    _SKILLS: ClassVar[list[SkillDefinition] | None] = None
    _SKILLS_BY_ID: ClassVar[dict[str, SkillDefinition] | None] = None

    @classmethod
    def _load_registry(cls) -> list[SkillDefinition]:
        registry_path = get_system_registry_path()
        payload = yaml.safe_load(registry_path.read_text(encoding="utf-8")) or {}
        raw_skills = payload.get("skills")
        if not isinstance(raw_skills, list):
            raise ValueError(f"{registry_path} must define a top-level 'skills' list.")
        return [SkillDefinition.model_validate(item) for item in raw_skills]

    @classmethod
    def _ensure_loaded(cls) -> None:
        if cls._SKILLS is not None and cls._SKILLS_BY_ID is not None:
            return
        skills = cls._load_registry()
        skills_by_id = {skill.id: skill for skill in skills}
        missing_ids = sorted(set(cls._ALIAS_TO_ID.values()) - set(skills_by_id))
        if missing_ids:
            raise ValueError(f"Missing bundled system skill ids in {get_system_registry_path()}: {', '.join(missing_ids)}")
        cls._SKILLS = skills
        cls._SKILLS_BY_ID = skills_by_id
        cls._bind_aliases()

    @classmethod
    def _bind_aliases(cls) -> None:
        assert cls._SKILLS_BY_ID is not None
        for alias, skill_id in cls._ALIAS_TO_ID.items():
            setattr(cls, alias, cls._SKILLS_BY_ID[skill_id])

    @classmethod
    def get_defaults(cls) -> List[SkillDefinition]:
        cls._ensure_loaded()
        return list(cls._SKILLS or [])

    @classmethod
    def get_skill(cls, skill_id: str) -> SkillDefinition | None:
        cls._ensure_loaded()
        return (cls._SKILLS_BY_ID or {}).get(skill_id)


DefaultSkills._ensure_loaded()
