from __future__ import annotations

import json
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, ValidationError

from context_profile import normalize_context
from utils.logger import get_logger
from utils.paths import ensure_directory, get_app_home, safe_chmod

logger = get_logger()


class InboxNote(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    text: str
    created_at: str
    app_name: str = "Unknown"
    bundle_id: Optional[str] = None
    window_title: Optional[str] = None
    source_mode: str = "dictation"
    source_kind: str = "spoken_text"
    output_mode: Optional[str] = None


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
        source_mode=source_mode,
        source_kind=source_kind,
        output_mode=output_mode,
    )


class InboxStore:
    _instance: Optional["InboxStore"] = None
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
        self._lock = threading.RLock()
        self._initialized = True

    def _file_path(self) -> Path:
        return get_app_home() / "inbox.jsonl"

    def _ensure_parent(self) -> Path:
        path = self._file_path()
        ensure_directory(path.parent)
        return path

    def append_note(self, note: InboxNote) -> InboxNote:
        path = self._ensure_parent()
        payload = json.dumps(note.model_dump(exclude_none=True), ensure_ascii=True)
        with self._lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(payload)
                handle.write("\n")
            safe_chmod(path, 0o600)
        return note

    def list_notes(self) -> List[InboxNote]:
        path = self._ensure_parent()
        if not path.exists():
            return []

        with self._lock:
            notes: List[InboxNote] = []
            with path.open("r", encoding="utf-8") as handle:
                for raw_line in handle:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        notes.append(InboxNote.model_validate_json(line))
                    except ValidationError as exc:
                        logger.warning("Skipping invalid inbox entry: %s", exc)
            notes.sort(key=lambda item: item.created_at, reverse=True)
            return notes

    def delete_note(self, note_id: str) -> bool:
        path = self._ensure_parent()
        if not path.exists():
            return False

        with self._lock:
            notes = self.list_notes()
            remaining = [note for note in notes if note.id != note_id]
            if len(remaining) == len(notes):
                return False

            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=path.parent,
                prefix="inbox_",
                suffix=".jsonl",
                delete=False,
            ) as handle:
                temp_path = Path(handle.name)
                for note in sorted(remaining, key=lambda item: item.created_at):
                    handle.write(json.dumps(note.model_dump(exclude_none=True), ensure_ascii=True))
                    handle.write("\n")

            safe_chmod(temp_path, 0o600)
            temp_path.replace(path)
            safe_chmod(path, 0o600)
            return True
