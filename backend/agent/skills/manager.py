from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import ValidationError

from utils.logger import get_logger
from utils.paths import ensure_directory, get_app_home, safe_chmod

from .defaults import DefaultSkills
from .models import SkillDefinition, SkillPackageDiagnostic
from .packages import load_skill_packages, write_skill_package

logger = get_logger()

MAX_SKILL_PROMPT_CHARS = 32_000


class SkillValidationError(ValueError):
    """Raised when a custom skill fails sanity checks before being persisted."""


def _format_validation_error(exc: ValidationError) -> str:
    """Turn a pydantic ValidationError into a compact user-facing string."""
    parts: list[str] = []
    for err in exc.errors():
        location = ".".join(str(loc) for loc in err.get("loc", ()) if loc != "__root__") or "skill"
        message = err.get("msg", "is invalid")
        parts.append(f"{location}: {message}")
    return "; ".join(parts) or "Skill failed validation."


def _sanity_check_skill(skill: SkillDefinition) -> None:
    """Reject pathological prompts before we write them to disk."""
    prompt = skill.prompt or ""
    stripped_prompt = prompt.strip()
    if not stripped_prompt:
        raise SkillValidationError("Skill prompt cannot be empty after trimming whitespace.")

    if len(prompt) > MAX_SKILL_PROMPT_CHARS:
        raise SkillValidationError(
            f"Skill prompt is too long ({len(prompt)} characters). Keep it under {MAX_SKILL_PROMPT_CHARS} characters."
        )

    open_braces = prompt.count("{")
    close_braces = prompt.count("}")
    if open_braces != close_braces:
        raise SkillValidationError(
            "Skill prompt has unbalanced curly braces. Check any placeholder syntax and remove stray braces."
        )


class SkillManager:
    """
    Manages loading, migrating, and persisting skill packages.
    User skills primarily live under ~/.steervox/skills/<id>/SKILL.md.
    Legacy ~/.steervox/skills.json is migrated automatically and kept as a backup.
    """

    _instance = None
    _instance_lock = threading.RLock()

    def __new__(cls):
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if getattr(self, "_initialized", False):
            return
        self._skills: List[SkillDefinition] = []
        self._skills_by_id: Dict[str, SkillDefinition] = {}
        self._diagnostics: List[SkillPackageDiagnostic] = []
        self._storage_lock = threading.RLock()
        self._ensure_storage()
        self.load_skills()
        self._initialized = True

    def _skills_file(self) -> Path:
        return get_app_home() / "skills.json"

    def _skills_dir(self) -> Path:
        return get_app_home() / "skills"

    def _skills_backup_file(self) -> Path:
        return get_app_home() / "skills.json.bak"

    def _ensure_storage(self):
        app_home = ensure_directory(get_app_home())
        safe_chmod(app_home, 0o700)
        ensure_directory(self._skills_dir())
        legacy_file = self._skills_file()
        if not legacy_file.exists():
            legacy_file.write_text("[]", encoding="utf-8")
            safe_chmod(legacy_file, 0o600)

    def _load_legacy_custom_skills(self) -> List[SkillDefinition]:
        legacy_file = self._skills_file()
        try:
            payload = json.loads(legacy_file.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.error("Error loading legacy skills from %s: %s", legacy_file, exc)
            return []

        if not isinstance(payload, list):
            logger.error("Legacy skills file %s is not a list. Ignoring it.", legacy_file)
            return []

        parsed_skills: List[SkillDefinition] = []
        for item in payload:
            try:
                parsed_skills.append(SkillDefinition.model_validate(item))
            except ValidationError as exc:
                logger.warning("Skipping invalid legacy custom skill: %s", exc)
        return [skill for skill in parsed_skills if not skill.id.startswith("system_")]

    def _persist_legacy_placeholder(self):
        legacy_file = self._skills_file()
        legacy_file.write_text("[]", encoding="utf-8")
        safe_chmod(legacy_file, 0o600)

    def _backup_legacy_json(self):
        legacy_file = self._skills_file()
        backup_file = self._skills_backup_file()
        shutil.copy2(legacy_file, backup_file)
        safe_chmod(backup_file, 0o600)

    def _migrate_legacy_custom_skills(self, existing_ids: set[str]) -> List[SkillPackageDiagnostic]:
        diagnostics: List[SkillPackageDiagnostic] = []
        user_dir = self._skills_dir()
        if any(path.is_dir() for path in user_dir.iterdir()):
            return diagnostics

        legacy_skills = self._load_legacy_custom_skills()
        if not legacy_skills:
            return diagnostics

        try:
            self._backup_legacy_json()
            seen_ids = set(existing_ids)
            for skill in legacy_skills:
                if skill.id in seen_ids:
                    diagnostics.append(SkillPackageDiagnostic(
                        id=skill.id,
                        package_path=str(self._skills_file()),
                        severity="warning",
                        message="Skipped a duplicate legacy skill during migration.",
                    ))
                    continue
                write_skill_package(skill, user_dir, overwrite=True)
                seen_ids.add(skill.id)
            self._persist_legacy_placeholder()
        except Exception as exc:
            diagnostics.append(SkillPackageDiagnostic(
                id=None,
                package_path=str(self._skills_file()),
                severity="error",
                message=f"Legacy skill migration failed: {exc}",
            ))
            logger.error("Legacy skill migration failed: %s", exc, exc_info=True)
        return diagnostics

    def load_skills(self):
        with self._storage_lock:
            skills_by_id: Dict[str, SkillDefinition] = {}
            diagnostics: List[SkillPackageDiagnostic] = []
            system_skills = DefaultSkills.get_defaults()

            for skill in system_skills:
                if skill.id in skills_by_id:
                    diagnostics.append(SkillPackageDiagnostic(
                        id=skill.id,
                        package_path=str(self._skills_dir()),
                        severity="warning",
                        message="Skipped a duplicate system skill definition.",
                    ))
                    continue
                skills_by_id[skill.id] = skill

            diagnostics.extend(self._migrate_legacy_custom_skills(set(skills_by_id)))

            user_skills, user_diagnostics = load_skill_packages(self._skills_dir())
            diagnostics.extend(user_diagnostics)
            if not user_skills:
                for skill in self._load_legacy_custom_skills():
                    if skill.id in skills_by_id:
                        diagnostics.append(SkillPackageDiagnostic(
                            id=skill.id,
                            package_path=str(self._skills_file()),
                            severity="warning",
                            message="Skipped a duplicate legacy skill id.",
                        ))
                        continue
                    skills_by_id[skill.id] = skill

            for skill in user_skills:
                if skill.id.startswith("system_"):
                    diagnostics.append(SkillPackageDiagnostic(
                        id=skill.id,
                        package_path=str(self._skills_dir() / skill.id),
                        severity="warning",
                        message="Skipped a user skill because the system_ prefix is reserved.",
                    ))
                    continue
                if skill.id in skills_by_id:
                    diagnostics.append(SkillPackageDiagnostic(
                        id=skill.id,
                        package_path=str(self._skills_dir() / skill.id),
                        severity="warning",
                        message="Skipped a duplicate user skill id.",
                    ))
                    continue
                skills_by_id[skill.id] = skill

            self._skills = list(skills_by_id.values())
            self._skills_by_id = skills_by_id
            self._diagnostics = diagnostics
            logger.info("Loaded %d skills.", len(self._skills))

    def get_all_skills(self) -> List[Dict[str, Any]]:
        with self._storage_lock:
            return [skill.model_dump(exclude_none=True) for skill in self._skills]

    def get_router_skill_catalog(self) -> List[Dict[str, Any]]:
        with self._storage_lock:
            return [
                {
                    "id": skill.id,
                    "name": skill.name,
                    "description": skill.description,
                    "target_types": list(skill.target_types),
                    "output_mode": skill.output_mode,
                }
                for skill in self._skills
            ]

    def get_diagnostics(self) -> List[Dict[str, Any]]:
        with self._storage_lock:
            return [diagnostic.model_dump(exclude_none=True) for diagnostic in self._diagnostics]

    def get_skill(self, skill_id: str) -> Optional[SkillDefinition]:
        with self._storage_lock:
            return self._skills_by_id.get(skill_id)

    def add_custom_skill(self, skill: Dict[str, Any]) -> bool:
        try:
            self.add_custom_skill_checked(skill)
            return True
        except SkillValidationError as exc:
            logger.error("Failed to add custom skill: %s", exc)
            return False

    def add_custom_skill_checked(self, skill: Dict[str, Any]) -> None:
        try:
            parsed_skill = SkillDefinition.model_validate(skill)
        except ValidationError as exc:
            raise SkillValidationError(_format_validation_error(exc)) from exc

        if parsed_skill.id.startswith("system_"):
            raise SkillValidationError("Skill id cannot use the reserved 'system_' prefix.")

        _sanity_check_skill(parsed_skill)

        with self._storage_lock:
            if parsed_skill.id in self._skills_by_id:
                raise SkillValidationError(
                    f"A skill with id {parsed_skill.id!r} already exists. Choose a unique id or edit the existing skill."
                )

            try:
                write_skill_package(parsed_skill, self._skills_dir(), overwrite=False)
            except Exception as exc:
                logger.error("Failed to save custom skill: %s", exc, exc_info=True)
                raise SkillValidationError("Failed to save the custom skill to disk. See backend logs for details.") from exc

            self.load_skills()

    def update_custom_skill(self, skill_id: str, skill: Dict[str, Any]) -> bool:
        try:
            self.update_custom_skill_checked(skill_id, skill)
            return True
        except SkillValidationError as exc:
            logger.error("Failed to update custom skill %s: %s", skill_id, exc)
            return False

    def update_custom_skill_checked(self, skill_id: str, skill: Dict[str, Any]) -> None:
        try:
            parsed_skill = SkillDefinition.model_validate(skill)
        except ValidationError as exc:
            raise SkillValidationError(_format_validation_error(exc)) from exc

        if skill_id.startswith("system_") or parsed_skill.id.startswith("system_"):
            raise SkillValidationError("Cannot edit system skills.")
        if parsed_skill.id != skill_id:
            raise SkillValidationError(
                f"Updated skill id {parsed_skill.id!r} must match the existing id {skill_id!r}."
            )

        _sanity_check_skill(parsed_skill)

        with self._storage_lock:
            existing_dir = self._skills_dir() / skill_id
            if not existing_dir.exists():
                raise SkillValidationError(f"Skill {skill_id!r} does not exist.")

            try:
                write_skill_package(parsed_skill, self._skills_dir(), overwrite=True)
            except Exception as exc:
                logger.error("Failed to update skill %r: %s", skill_id, exc, exc_info=True)
                raise SkillValidationError(
                    f"Failed to save updates for skill {skill_id!r}. See backend logs for details."
                ) from exc

            self.load_skills()

    def delete_custom_skill(self, skill_id: str) -> bool:
        if skill_id.startswith("system_"):
            logger.error("Cannot delete system skills.")
            return False

        with self._storage_lock:
            skill_dir = self._skills_dir() / skill_id
            if skill_dir.exists():
                try:
                    shutil.rmtree(skill_dir)
                    self.load_skills()
                    return True
                except Exception as exc:
                    logger.error("Failed to delete skill %r: %s", skill_id, exc)
                    return False

            legacy_skills = self._load_legacy_custom_skills()
            remaining = [skill for skill in legacy_skills if skill.id != skill_id]
            if len(remaining) == len(legacy_skills):
                logger.warning("Skill %r not found for deletion.", skill_id)
                return False

            try:
                self._skills_file().write_text(
                    json.dumps([skill.model_dump(exclude_none=True) for skill in remaining], indent=4),
                    encoding="utf-8",
                )
                safe_chmod(self._skills_file(), 0o600)
                self.load_skills()
                return True
            except Exception as exc:
                logger.error("Failed to delete legacy skill %r: %s", skill_id, exc)
                return False
