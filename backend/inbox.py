from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional
from uuid import uuid4

from context_profile import normalize_context
from library_models import InboxNote
from writing_memory import WritingToolsStore


def build_inbox_note(
    text: str,
    *,
    context: Optional[Dict[str, Any]],
    source_mode: str,
    source_kind: str = "spoken_text",
    output_mode: Optional[str] = None,
) -> InboxNote:
    normalized_context = normalize_context(context)
    return InboxNote(
        id=uuid4().hex,
        text=text,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        app_name=normalized_context.get("app_name") or "Unknown",
        bundle_id=normalized_context.get("bundle_id"),
        window_title=normalized_context.get("window_title"),
        page_title=normalized_context.get("page_title"),
        url_host=normalized_context.get("url_host"),
        url_path=normalized_context.get("url_path"),
        surface_kind=normalized_context.get("surface_kind"),
        source_mode=source_mode,
        source_kind=source_kind,
        output_mode=output_mode,
    )


class InboxStore:
    def __init__(self, writing_tools_store: Optional[WritingToolsStore] = None):
        self._store = writing_tools_store or WritingToolsStore()

    def append_note(self, note: InboxNote) -> InboxNote:
        return self._store.append_note(note)

    def list_notes(self):
        return self._store.list_notes()

    def delete_note(self, note_id: str) -> bool:
        return self._store.delete_note(note_id)
