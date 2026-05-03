from __future__ import annotations

from fastapi import APIRouter, HTTPException

from agent.skills.manager import SkillValidationError
from agent.skills.models import SkillDefinition
from api.state import BackendAppState
from utils.logger import get_logger


logger = get_logger()


def build_skills_router(state: BackendAppState) -> APIRouter:
    router = APIRouter()

    @router.get("/skills")
    def get_skills():
        return {"skills": state.skill_manager.get_all_skills()}

    @router.get("/skills/diagnostics")
    def get_skill_diagnostics():
        return {"items": state.skill_manager.get_diagnostics()}

    @router.post("/skills")
    def add_skill(skill: SkillDefinition):
        try:
            state.skill_manager.add_custom_skill_checked(skill.model_dump(exclude_none=True))
        except SkillValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("skills")
        state.emit_runtime_event(
            "skills_invalidated",
            {"revision": revision, "skill_id": skill.id},
        )
        return {"status": "success", "message": "Skill added successfully"}

    @router.put("/skills/{skill_id}")
    def update_skill(skill_id: str, skill: SkillDefinition):
        if skill_id.startswith("system_"):
            raise HTTPException(status_code=400, detail="Cannot edit system skills.")

        try:
            state.skill_manager.update_custom_skill_checked(
                skill_id,
                skill.model_dump(exclude_none=True),
            )
        except SkillValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        revision = state.bump_runtime_revision("skills")
        state.emit_runtime_event(
            "skills_invalidated",
            {"revision": revision, "skill_id": skill_id},
        )
        return {
            "status": "success",
            "message": f"Skill '{skill_id}' updated successfully",
        }

    @router.delete("/skills/{skill_id}")
    def delete_skill(skill_id: str):
        if skill_id.startswith("system_"):
            raise HTTPException(status_code=400, detail="Cannot delete system skills.")

        success = state.skill_manager.delete_custom_skill(skill_id)
        if not success:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found.")
        revision = state.bump_runtime_revision("skills")
        state.emit_runtime_event(
            "skills_invalidated",
            {"revision": revision, "skill_id": skill_id},
        )
        return {"status": "success", "message": f"Skill '{skill_id}' deleted."}

    @router.get("/inbox")
    def get_inbox():
        return {
            "notes": [
                note.model_dump(exclude_none=True)
                for note in state.inbox_store.list_notes()
            ],
        }

    @router.delete("/inbox/{note_id}")
    def delete_inbox_note(note_id: str):
        if not state.inbox_store.delete_note(note_id):
            raise HTTPException(
                status_code=404,
                detail=f"Inbox note '{note_id}' not found.",
            )
        try:
            state.rebuild_library_memory(reset_tombstones=False)
        except RuntimeError as exc:
            logger.warning("Failed to refresh local memory after inbox delete: %s", exc)
        revision = state.bump_runtime_revision("inbox")
        state.emit_runtime_event(
            "inbox_invalidated",
            {"revision": revision, "note_id": note_id},
        )
        return {
            "status": "success",
            "message": f"Inbox note '{note_id}' deleted.",
        }

    return router
