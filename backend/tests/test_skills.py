import json

import pytest
import yaml

from agent.skills.defaults import DefaultSkills, SYSTEM_REGISTRY_PATH
from agent.skills.manager import MAX_SKILL_PROMPT_CHARS, SkillManager, SkillValidationError
from agent.skills.models import SkillDefinition
from agent.skills.packages import load_skill_packages, parse_skill_markdown, render_skill_markdown, write_skill_package


def test_skill_manager_loads_legacy_skills_with_contract_defaults(isolated_steervox_home):
    skills_file = isolated_steervox_home / "skills.json"
    skills_file.parent.mkdir(parents=True, exist_ok=True)
    skills_file.write_text(json.dumps([
        {
            "id": "legacy_chat",
            "name": "Legacy Chat",
            "prompt": "Rewrite like chat.",
        }
    ]))

    manager = SkillManager()
    skill = manager.get_skill("legacy_chat")

    assert skill is not None
    assert skill.triggers == []
    assert skill.target_types == []
    assert skill.fallback_behavior == "selected_skill"
    assert skill.output_mode == "plain_text"


def test_skill_manager_rejects_duplicate_custom_ids():
    manager = SkillManager()

    assert manager.add_custom_skill({
        "id": "custom_reply",
        "name": "Custom Reply",
        "prompt": "Reply helpfully.",
    }) is True

    assert manager.add_custom_skill({
        "id": "custom_reply",
        "name": "Duplicate Reply",
        "prompt": "Should fail.",
    }) is False


def test_default_skill_library_includes_basic_app_presets():
    ids = {skill.id for skill in DefaultSkills.get_defaults()}

    assert {
        "system_dictation",
        "system_grammar",
        "strict_grammar",
        "system_rewrite",
        "system_chat_reply",
        "system_email_draft",
        "system_social_post",
        "system_domain_email",
        "system_terminal",
        "system_code",
        "system_codex_prompt",
        "system_antigravity_prompt",
        "system_cloud_code_prompt",
        "system_ai_chat_prompt",
        "system_prompt_architect",
        "system_agent_action_builder",
        "system_action_execution",
        "system_issue_ticket",
        "system_doc_notes",
        "system_domain_structured_note",
        "system_bullets",
        "system_translate",
    }.issubset(ids)


def test_skill_manager_loads_split_grammar_skills_with_legacy_alias():
    manager = SkillManager()

    assert manager.get_skill("strict_grammar") is not None
    assert manager.get_skill("system_rewrite") is not None
    assert manager.get_skill("system_grammar") is not None


def test_skill_package_roundtrip_preserves_manifest_and_prompt(isolated_steervox_home):
    skill = SkillDefinition(
        id="custom_followup",
        name="Follow Up",
        description="Draft a concise follow-up.",
        prompt="## Purpose\nDraft a short follow-up.\n\n## Output Contract\nReturn plain text only.",
        triggers=["follow up", "nudge"],
        target_types=["chat", "document"],
        max_chars=280,
        style="concise",
        fallback_behavior="selected_skill",
        output_mode="plain_text",
    )

    manifest_text = render_skill_markdown(skill)
    parsed = parse_skill_markdown(manifest_text, package_path=isolated_steervox_home / "SKILL.md")

    assert parsed == skill

    package_dir = write_skill_package(skill, isolated_steervox_home / "skills")
    loaded, diagnostics = load_skill_packages(isolated_steervox_home / "skills")

    assert diagnostics == []
    assert package_dir.name == "custom_followup"
    assert loaded == [skill]


def test_skill_manager_migrates_legacy_json_to_package_storage(isolated_steervox_home):
    skills_file = isolated_steervox_home / "skills.json"
    skills_file.parent.mkdir(parents=True, exist_ok=True)
    skills_file.write_text(json.dumps([
        {
            "id": "legacy_chat",
            "name": "Legacy Chat",
            "description": "Legacy template",
            "prompt": "Rewrite like chat.",
        }
    ]), encoding="utf-8")

    manager = SkillManager()
    package_path = isolated_steervox_home / "skills" / "legacy_chat" / "SKILL.md"

    assert manager.get_skill("legacy_chat") is not None
    assert package_path.exists()
    assert "Rewrite like chat." in package_path.read_text(encoding="utf-8")
    assert json.loads(skills_file.read_text(encoding="utf-8")) == []
    assert (isolated_steervox_home / "skills.json.bak").exists()


def test_skill_manager_reports_invalid_package_without_blocking_startup(isolated_steervox_home):
    broken_dir = isolated_steervox_home / "skills" / "broken_template"
    broken_dir.mkdir(parents=True, exist_ok=True)
    (broken_dir / "SKILL.md").write_text("---\nid: broken_template\nname: Broken template\n---\n", encoding="utf-8")

    manager = SkillManager()
    diagnostics = manager.get_diagnostics()

    assert manager.get_skill("system_dictation") is not None
    assert any(
        item["id"] == "broken_template"
        and "must include markdown instructions" in item["message"]
        for item in diagnostics
    )


def test_skill_manager_update_persists_skill_package(isolated_steervox_home):
    manager = SkillManager()

    assert manager.add_custom_skill({
        "id": "custom_reply",
        "name": "Custom Reply",
        "prompt": "Draft a reply.",
        "description": "Original",
    }) is True

    assert manager.update_custom_skill("custom_reply", {
        "id": "custom_reply",
        "name": "Custom Reply",
        "prompt": "## Purpose\nDraft a polished reply.\n\n## Output Contract\nReturn polished prose.",
        "description": "Updated",
        "output_mode": "plain_text",
    }) is True

    package_path = isolated_steervox_home / "skills" / "custom_reply" / "SKILL.md"
    persisted = package_path.read_text(encoding="utf-8")

    assert "description: Updated" in persisted
    assert "Draft a polished reply." in persisted
    assert manager.get_skill("custom_reply").description == "Updated"


def test_system_skill_registry_matches_python_defaults():
    payload = yaml.safe_load(SYSTEM_REGISTRY_PATH.read_text(encoding="utf-8"))
    registry_skills = [SkillDefinition.model_validate(item) for item in payload["skills"]]

    assert {skill.id for skill in registry_skills} == {skill.id for skill in DefaultSkills.get_defaults()}


def test_skill_manager_rejects_blank_prompt():
    manager = SkillManager()

    with pytest.raises(SkillValidationError) as exc_info:
        manager.add_custom_skill_checked({
            "id": "custom_blank_prompt",
            "name": "Blank prompt",
            "prompt": "   \n\t",
        })

    assert "empty" in str(exc_info.value).lower()


def test_skill_manager_rejects_oversized_prompt():
    manager = SkillManager()

    huge_prompt = "x" * (MAX_SKILL_PROMPT_CHARS + 5)
    with pytest.raises(SkillValidationError) as exc_info:
        manager.add_custom_skill_checked({
            "id": "custom_huge_prompt",
            "name": "Huge prompt",
            "prompt": huge_prompt,
        })

    assert "too long" in str(exc_info.value).lower()


def test_skill_manager_rejects_unbalanced_braces_in_prompt():
    manager = SkillManager()

    with pytest.raises(SkillValidationError) as exc_info:
        manager.add_custom_skill_checked({
            "id": "custom_broken_template",
            "name": "Broken template",
            "prompt": "Hello {name and welcome.",
        })

    assert "brace" in str(exc_info.value).lower()


def test_skill_manager_rejects_system_prefix_on_create():
    manager = SkillManager()

    with pytest.raises(SkillValidationError) as exc_info:
        manager.add_custom_skill_checked({
            "id": "system_intruder",
            "name": "System intruder",
            "prompt": "Should not be allowed.",
        })

    assert "system_" in str(exc_info.value)


def test_skill_manager_rejects_duplicate_id_with_clear_error():
    manager = SkillManager()

    manager.add_custom_skill_checked({
        "id": "custom_duplicate",
        "name": "First",
        "prompt": "First version of the prompt.",
    })

    with pytest.raises(SkillValidationError) as exc_info:
        manager.add_custom_skill_checked({
            "id": "custom_duplicate",
            "name": "Second",
            "prompt": "Second version of the prompt.",
        })

    assert "already exists" in str(exc_info.value).lower()


def test_skill_manager_update_rejects_system_prefix_on_path():
    manager = SkillManager()

    with pytest.raises(SkillValidationError):
        manager.update_custom_skill_checked(
            "system_dictation",
            {
                "id": "system_dictation",
                "name": "Hijack",
                "prompt": "Should be rejected.",
            },
        )
