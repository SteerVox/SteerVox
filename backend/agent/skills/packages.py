from __future__ import annotations

import shutil
from pathlib import Path
from typing import Iterable

import yaml

from utils.paths import ensure_directory, resolve_runtime_path, safe_chmod

from .models import SkillDefinition, SkillPackageDiagnostic, SkillPackageManifest


SKILL_MANIFEST_NAME = "SKILL.md"
SYSTEM_SKILLS_DIR = Path(__file__).with_name("system_packages")


def get_system_skills_dir() -> Path:
    return resolve_runtime_path("agent", "skills", "system_packages")


def split_skill_frontmatter(text: str) -> tuple[str, str]:
    normalized = text.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        raise ValueError("SKILL.md must start with YAML frontmatter.")

    marker = "\n---\n"
    end_index = normalized.find(marker, 4)
    if end_index < 0:
        raise ValueError("SKILL.md frontmatter is missing its closing --- marker.")

    frontmatter = normalized[4:end_index]
    body = normalized[end_index + len(marker):].strip()
    if not body:
        raise ValueError("SKILL.md must include markdown instructions after the frontmatter.")
    return frontmatter, body


def build_skill_definition(manifest: SkillPackageManifest, body: str) -> SkillDefinition:
    return SkillDefinition(
        id=manifest.id,
        name=manifest.name,
        prompt=body.strip(),
        description=manifest.description,
        triggers=manifest.triggers,
        target_types=manifest.target_types,
        max_chars=manifest.max_chars,
        style=manifest.style,
        fallback_behavior=manifest.fallback_behavior,
        output_mode=manifest.output_mode,
    )


def parse_skill_markdown(text: str, *, package_path: Path) -> SkillDefinition:
    frontmatter, body = split_skill_frontmatter(text)
    payload = yaml.safe_load(frontmatter) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"{package_path} frontmatter must be a YAML object.")
    manifest = SkillPackageManifest.model_validate(payload)
    return build_skill_definition(manifest, body)


def read_skill_package(package_dir: Path) -> SkillDefinition:
    manifest_path = package_dir / SKILL_MANIFEST_NAME
    return parse_skill_markdown(manifest_path.read_text(encoding="utf-8"), package_path=manifest_path)


def load_skill_packages(root_dir: Path) -> tuple[list[SkillDefinition], list[SkillPackageDiagnostic]]:
    if not root_dir.exists():
        return [], []

    loaded: list[SkillDefinition] = []
    diagnostics: list[SkillPackageDiagnostic] = []

    for package_dir in sorted(path for path in root_dir.iterdir() if path.is_dir()):
        manifest_path = package_dir / SKILL_MANIFEST_NAME
        if not manifest_path.exists():
            diagnostics.append(SkillPackageDiagnostic(
                id=package_dir.name,
                package_path=str(package_dir),
                severity="warning",
                message="Package directory is missing SKILL.md.",
            ))
            continue

        try:
            loaded.append(read_skill_package(package_dir))
        except Exception as exc:
            diagnostics.append(SkillPackageDiagnostic(
                id=package_dir.name,
                package_path=str(manifest_path),
                severity="error",
                message=str(exc),
            ))

    return loaded, diagnostics


def skill_to_manifest(skill: SkillDefinition) -> SkillPackageManifest:
    return SkillPackageManifest(
        id=skill.id,
        name=skill.name,
        description=skill.description,
        version=1,
        triggers=skill.triggers,
        target_types=skill.target_types,
        max_chars=skill.max_chars,
        style=skill.style,
        fallback_behavior=skill.fallback_behavior,
        output_mode=skill.output_mode,
    )


def render_skill_markdown(skill: SkillDefinition) -> str:
    manifest = skill_to_manifest(skill).model_dump(exclude_none=True)
    frontmatter = yaml.safe_dump(
        manifest,
        sort_keys=False,
        allow_unicode=False,
        default_flow_style=False,
    ).strip()
    body = skill.prompt.strip()
    return f"---\n{frontmatter}\n---\n\n{body}\n"


def write_skill_package(skill: SkillDefinition, root_dir: Path, *, overwrite: bool = True) -> Path:
    ensure_directory(root_dir)
    package_dir = root_dir / skill.id
    temp_dir = root_dir / f".{skill.id}.tmp"

    if temp_dir.exists():
        shutil.rmtree(temp_dir, ignore_errors=True)
    if package_dir.exists() and not overwrite:
        raise FileExistsError(f"Skill package {skill.id!r} already exists.")

    ensure_directory(temp_dir)
    manifest_path = temp_dir / SKILL_MANIFEST_NAME
    manifest_path.write_text(render_skill_markdown(skill), encoding="utf-8")
    safe_chmod(manifest_path, 0o600)

    if package_dir.exists():
        shutil.rmtree(package_dir)
    temp_dir.rename(package_dir)
    safe_chmod(package_dir, 0o700)
    safe_chmod(package_dir / SKILL_MANIFEST_NAME, 0o600)
    return package_dir


def write_skill_packages(skills: Iterable[SkillDefinition], root_dir: Path, *, overwrite: bool = True) -> list[Path]:
    written: list[Path] = []
    for skill in skills:
        written.append(write_skill_package(skill, root_dir, overwrite=overwrite))
    return written
