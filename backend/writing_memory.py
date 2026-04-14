from __future__ import annotations

import json
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from utils.logger import get_logger
from utils.paths import get_app_home, safe_chmod


logger = get_logger()
SCHEMA_VERSION = "2"
LOCK_RETRY_DELAYS = (0.05, 0.1, 0.2)
SQLITE_BUSY_TIMEOUT_SECONDS = 1.5
WORD_BOUNDARY_TEMPLATE = r"(?<!\w){pattern}(?!\w)"
WHITESPACE_PATTERN = re.compile(r"\s+")

MAX_SOURCE_TEXT_CHARS = 256
MAX_CANONICAL_TEXT_CHARS = 512
MAX_REPLACEMENT_TEXT_CHARS = 2048
MAX_SNIPPET_TRIGGER_CHARS = 256
MAX_SNIPPET_EXPANSION_CHARS = 8192
MAX_HISTORY_TRANSCRIPT_CHARS = 32_000
MAX_HISTORY_FINAL_OUTPUT_CHARS = 32_000
MAX_HISTORY_JSON_BLOB_CHARS = 32_000
MAX_HISTORY_ITEMS = 1000


def _validate_required_text(value: str, *, field: str, max_chars: int) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field} cannot be empty.")
    if len(cleaned) > max_chars:
        raise ValueError(f"{field} must be {max_chars} characters or fewer.")
    return cleaned


def _normalize_alias_list(value: object) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        candidates = [segment.strip() for segment in value.split(",")]
    elif isinstance(value, list):
        candidates = [str(segment).strip() for segment in value]
    else:
        raise ValueError("Aliases must be a string or a list of strings.")

    aliases: List[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate:
            continue
        cleaned = _validate_required_text(candidate, field="Alias", max_chars=MAX_SOURCE_TEXT_CHARS)
        lowered = cleaned.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        aliases.append(cleaned)
    return aliases


class DictionaryEntryPayload(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    canonical_text: str
    aliases: List[str] = Field(default_factory=list)
    enabled: bool = True

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_source_text(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value

        payload = dict(value)
        legacy_source_text = payload.get("source_text")
        aliases = payload.get("aliases")
        if legacy_source_text is not None and (aliases is None or aliases == "" or aliases == []):
            payload["aliases"] = [legacy_source_text]
        return payload

    @field_validator("aliases", mode="before")
    @classmethod
    def validate_aliases(cls, value: object) -> List[str]:
        return _normalize_alias_list(value)

    @field_validator("canonical_text")
    @classmethod
    def validate_canonical_text(cls, value: str) -> str:
        return _validate_required_text(value, field="Canonical text", max_chars=MAX_CANONICAL_TEXT_CHARS)

    @model_validator(mode="after")
    def normalize_entry(self) -> "DictionaryEntryPayload":
        filtered_aliases: List[str] = []
        seen: set[str] = set()
        for alias in self.aliases:
            lowered = alias.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            filtered_aliases.append(alias)
        self.aliases = filtered_aliases
        return self


class ReplacementEntryPayload(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    source_text: str
    replacement_text: str
    match_type: Literal["exact", "inline"] = "inline"
    enabled: bool = True

    @field_validator("source_text")
    @classmethod
    def validate_source_text(cls, value: str) -> str:
        return _validate_required_text(value, field="Source text", max_chars=MAX_SOURCE_TEXT_CHARS)

    @field_validator("replacement_text")
    @classmethod
    def validate_replacement_text(cls, value: str) -> str:
        return _validate_required_text(value, field="Replacement text", max_chars=MAX_REPLACEMENT_TEXT_CHARS)


class SnippetEntryPayload(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    trigger: str
    expansion: str
    match_type: Literal["exact", "inline"] = "exact"
    enabled: bool = True

    @field_validator("trigger")
    @classmethod
    def validate_trigger(cls, value: str) -> str:
        return _validate_required_text(value, field="Trigger", max_chars=MAX_SNIPPET_TRIGGER_CHARS)

    @field_validator("expansion")
    @classmethod
    def validate_expansion(cls, value: str) -> str:
        return _validate_required_text(value, field="Expansion", max_chars=MAX_SNIPPET_EXPANSION_CHARS)


class DictionaryEntry(DictionaryEntryPayload):
    id: int
    updated_at: str


class ReplacementEntry(ReplacementEntryPayload):
    id: int
    updated_at: str


class SnippetEntry(SnippetEntryPayload):
    id: int
    updated_at: str


class WritingToolsSnapshot(BaseModel):
    dictionary: List[DictionaryEntry] = Field(default_factory=list)
    replacements: List[ReplacementEntry] = Field(default_factory=list)
    snippets: List[SnippetEntry] = Field(default_factory=list)


class HistoryItem(BaseModel):
    id: int
    mode: Literal["dictation", "smart_transform", "local_task"]
    transcript: str
    final_output: str
    created_at: str
    telemetry: Dict[str, Any] = Field(default_factory=dict)
    context: Dict[str, Any] = Field(default_factory=dict)
    stt_provider: Optional[str] = None
    stt_model: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None


def _utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _normalize_spaces(value: str) -> str:
    return WHITESPACE_PATTERN.sub(" ", value).strip()


def _safe_json_loads(raw: Any, *, context: str, row_id: Any = None) -> Dict[str, Any]:
    if raw is None or raw == "":
        return {}
    try:
        loaded = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.warning(
            "Writing memory: failed to parse %s for history row %s: %s",
            context,
            row_id,
            exc,
        )
        return {}
    if isinstance(loaded, dict):
        return loaded
    return {}


def _truncate_history_text(value: Optional[str], *, max_chars: int) -> str:
    if value is None:
        return ""
    text = str(value)
    if len(text) <= max_chars:
        return text
    return text[:max_chars]


def _serialize_history_blob(value: Any, *, context: str, max_chars: int) -> str:
    try:
        encoded = json.dumps(value or {}, ensure_ascii=False, default=str)
    except (TypeError, ValueError) as exc:
        logger.warning("Writing memory: dropping unserializable %s: %s", context, exc)
        return "{}"
    if len(encoded) > max_chars:
        logger.info(
            "Writing memory: truncating %s payload (%d chars > %d)",
            context,
            len(encoded),
            max_chars,
        )
        return "{}"
    return encoded


def _normalize_output_text(value: str) -> str:
    lines = [str(line).rstrip() for line in str(value or "").splitlines()]
    normalized_lines: list[str] = []
    previous_blank = False
    for line in lines:
        if not line.strip():
            if previous_blank:
                continue
            normalized_lines.append("")
            previous_blank = True
            continue
        normalized_lines.append(line)
        previous_blank = False
    return "\n".join(normalized_lines).strip()


def _build_inline_pattern(text: str) -> re.Pattern[str]:
    return re.compile(WORD_BOUNDARY_TEMPLATE.format(pattern=re.escape(text)), re.IGNORECASE)


def apply_dictionary_entries(text: str, entries: List[DictionaryEntry]) -> str:
    working = text
    replacements: list[tuple[str, str]] = []
    for entry in entries:
        if not entry.enabled:
            continue
        seen: set[str] = set()
        for candidate in [*entry.aliases, entry.canonical_text]:
            cleaned = _normalize_spaces(candidate)
            if not cleaned:
                continue
            lowered = cleaned.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            replacements.append((cleaned, entry.canonical_text))

    for source_text, canonical_text in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        pattern = _build_inline_pattern(source_text)
        if not pattern.search(working):
            continue
        working = pattern.sub(canonical_text, working)
    return _normalize_output_text(working)


def apply_replacement_entries(text: str, entries: List[ReplacementEntry]) -> str:
    working = text
    normalized_working = _normalize_spaces(working).lower()
    for entry in sorted((item for item in entries if item.enabled), key=lambda item: len(item.source_text), reverse=True):
        source = _normalize_spaces(entry.source_text)
        if entry.match_type == "exact":
            if normalized_working == source.lower():
                working = entry.replacement_text
                normalized_working = _normalize_spaces(working).lower()
            continue
        pattern = _build_inline_pattern(source)
        if not pattern.search(working):
            continue
        working = pattern.sub(entry.replacement_text, working)
        normalized_working = _normalize_spaces(working).lower()
    return _normalize_output_text(working)


def apply_snippet_entries(text: str, entries: List[SnippetEntry]) -> str:
    working = text
    normalized_working = _normalize_spaces(working)
    for entry in sorted((item for item in entries if item.enabled), key=lambda item: len(item.trigger), reverse=True):
        trigger = _normalize_spaces(entry.trigger)
        if entry.match_type == "exact":
            if normalized_working.lower() == trigger.lower():
                return _normalize_output_text(entry.expansion)
            continue
        pattern = _build_inline_pattern(trigger)
        if not pattern.search(working):
            continue
        working = pattern.sub(entry.expansion, working)
        normalized_working = _normalize_spaces(working)
    return _normalize_output_text(working)


class WritingToolsStore:
    def __init__(self, path: Optional[Path] = None):
        self.path = path or (get_app_home() / "writing_memory.sqlite3")
        self._lock = threading.RLock()
        self._runtime_cache: Optional[WritingToolsSnapshot] = None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        safe_chmod(self.path.parent, 0o700)
        self._initialize()

    def get_tools(self) -> WritingToolsSnapshot:
        with self._lock:
            return self._load_tools(enabled_only=False)

    def get_runtime_tools(self) -> WritingToolsSnapshot:
        with self._lock:
            if self._runtime_cache is not None:
                return self._runtime_cache
            snapshot = self._load_tools(enabled_only=True)
            self._runtime_cache = snapshot
            return snapshot

    def create_dictionary_entry(self, payload: DictionaryEntryPayload) -> DictionaryEntry:
        def _write(conn: sqlite3.Connection) -> int:
            self._assert_dictionary_entry_is_unique(conn, payload)
            cursor = conn.execute(
                """
                INSERT INTO dictionary_entries (canonical_text, aliases_json, enabled, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    payload.canonical_text,
                    json.dumps(payload.aliases, ensure_ascii=False),
                    1 if payload.enabled else 0,
                    _utc_timestamp(),
                ),
            )
            return int(cursor.lastrowid)

        entry_id = self._run_write_with_lock_retries(_write)
        self._runtime_cache = None
        return self._find_tool_entry("dictionary_entries", entry_id)

    def update_dictionary_entry(self, entry_id: int, payload: DictionaryEntryPayload) -> DictionaryEntry:
        def _write(conn: sqlite3.Connection) -> None:
            self._assert_dictionary_entry_is_unique(conn, payload, ignore_entry_id=entry_id)
            cursor = conn.execute(
                """
                UPDATE dictionary_entries
                SET canonical_text = ?, aliases_json = ?, enabled = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.canonical_text,
                    json.dumps(payload.aliases, ensure_ascii=False),
                    1 if payload.enabled else 0,
                    _utc_timestamp(),
                    entry_id,
                ),
            )
            if cursor.rowcount == 0:
                raise ValueError("Requested item was not found.")

        self._run_write_with_lock_retries(_write)
        self._runtime_cache = None
        return self._find_tool_entry("dictionary_entries", entry_id)

    def delete_dictionary_entry(self, entry_id: int) -> None:
        self._delete_tool_entry("dictionary_entries", entry_id)

    def create_replacement_entry(self, payload: ReplacementEntryPayload) -> ReplacementEntry:
        return self._create_tool_entry(
            table="replacement_entries",
            key_column="source_text",
            key_value=payload.source_text,
            values={
                "source_text": payload.source_text,
                "replacement_text": payload.replacement_text,
                "match_type": payload.match_type,
                "enabled": 1 if payload.enabled else 0,
                "updated_at": _utc_timestamp(),
            },
        )

    def update_replacement_entry(self, entry_id: int, payload: ReplacementEntryPayload) -> ReplacementEntry:
        return self._update_tool_entry(
            table="replacement_entries",
            entry_id=entry_id,
            key_column="source_text",
            key_value=payload.source_text,
            values={
                "source_text": payload.source_text,
                "replacement_text": payload.replacement_text,
                "match_type": payload.match_type,
                "enabled": 1 if payload.enabled else 0,
                "updated_at": _utc_timestamp(),
            },
        )

    def delete_replacement_entry(self, entry_id: int) -> None:
        self._delete_tool_entry("replacement_entries", entry_id)

    def create_snippet_entry(self, payload: SnippetEntryPayload) -> SnippetEntry:
        return self._create_tool_entry(
            table="snippet_entries",
            key_column="trigger",
            key_value=payload.trigger,
            values={
                "trigger": payload.trigger,
                "expansion": payload.expansion,
                "match_type": payload.match_type,
                "enabled": 1 if payload.enabled else 0,
                "updated_at": _utc_timestamp(),
            },
        )

    def update_snippet_entry(self, entry_id: int, payload: SnippetEntryPayload) -> SnippetEntry:
        return self._update_tool_entry(
            table="snippet_entries",
            entry_id=entry_id,
            key_column="trigger",
            key_value=payload.trigger,
            values={
                "trigger": payload.trigger,
                "expansion": payload.expansion,
                "match_type": payload.match_type,
                "enabled": 1 if payload.enabled else 0,
                "updated_at": _utc_timestamp(),
            },
        )

    def delete_snippet_entry(self, entry_id: int) -> None:
        self._delete_tool_entry("snippet_entries", entry_id)

    def list_history(self, limit: int = 100) -> List[HistoryItem]:
        with self._lock:
            return self._run_read_with_lock_retries(lambda conn: self._read_history(conn, limit))

    def get_history_item(self, item_id: int) -> Optional[HistoryItem]:
        with self._lock:
            return self._run_read_with_lock_retries(lambda conn: self._read_history_item(conn, item_id))

    def record_history(
        self,
        *,
        mode: Literal["dictation", "smart_transform", "local_task"],
        transcript: str,
        final_output: str,
        telemetry: Dict[str, Any],
        context: Dict[str, Any],
        stt_provider: Optional[str],
        stt_model: Optional[str],
        llm_provider: Optional[str],
        llm_model: Optional[str],
    ) -> HistoryItem:
        timestamp = _utc_timestamp()
        safe_transcript = _truncate_history_text(transcript, max_chars=MAX_HISTORY_TRANSCRIPT_CHARS)
        safe_final_output = _truncate_history_text(final_output, max_chars=MAX_HISTORY_FINAL_OUTPUT_CHARS)
        telemetry_blob = _serialize_history_blob(telemetry, context="telemetry", max_chars=MAX_HISTORY_JSON_BLOB_CHARS)
        context_blob = _serialize_history_blob(context, context="context", max_chars=MAX_HISTORY_JSON_BLOB_CHARS)

        def _write(conn: sqlite3.Connection) -> HistoryItem:
            cursor = conn.execute(
                """
                INSERT INTO history_items (
                    mode, transcript, final_output, created_at, telemetry_json, context_json,
                    stt_provider, stt_model, llm_provider, llm_model
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mode,
                    safe_transcript,
                    safe_final_output,
                    timestamp,
                    telemetry_blob,
                    context_blob,
                    stt_provider,
                    stt_model,
                    llm_provider,
                    llm_model,
                ),
            )
            row = conn.execute("SELECT * FROM history_items WHERE id = ?", (cursor.lastrowid,)).fetchone()
            if row is None:
                raise RuntimeError("History entry was written but could not be reloaded.")
            self._enforce_history_cap(conn)
            return self._row_to_history_item(row)

        return self._run_write_with_lock_retries(_write)

    def _enforce_history_cap(self, conn: sqlite3.Connection) -> None:
        row = conn.execute("SELECT COUNT(*) AS total FROM history_items").fetchone()
        if row is None:
            return
        total = int(row["total"]) if row["total"] is not None else 0
        if total <= MAX_HISTORY_ITEMS:
            return
        excess = total - MAX_HISTORY_ITEMS
        conn.execute(
            """
            DELETE FROM history_items
            WHERE id IN (
                SELECT id FROM history_items ORDER BY id ASC LIMIT ?
            )
            """,
            (excess,),
        )

    def delete_history_item(self, item_id: int) -> None:
        self._run_write_with_lock_retries(lambda conn: conn.execute("DELETE FROM history_items WHERE id = ?", (item_id,)))

    def clear_history(self) -> None:
        self._run_write_with_lock_retries(lambda conn: conn.execute("DELETE FROM history_items"))

    def _initialize(self) -> None:
        try:
            self._initialize_or_upgrade()
        except Exception as exc:
            logger.warning("Writing memory initialization failed, rebuilding: %s", exc)
            self._rebuild_database()

    def _initialize_or_upgrade(self) -> None:
        legacy_state: Optional[Dict[str, list[Dict[str, Any]]]] = None
        if self.path.exists():
            try:
                with self._connect() as conn:
                    version_row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
                    current_version = str(version_row["value"]) if version_row else None
                    if current_version == SCHEMA_VERSION:
                        return
                    if current_version == "1":
                        legacy_state = self._export_legacy_state(conn)
            except Exception as exc:
                logger.warning("Failed to inspect writing memory database, rebuilding: %s", exc)
        self._rebuild_database(legacy_state)

    def _rebuild_database(self, legacy_state: Optional[Dict[str, list[Dict[str, Any]]]] = None) -> None:
        if self.path.exists():
            backup_path = self.path.with_name(f"{self.path.name}.bak-{int(time.time())}")
            try:
                shutil.move(self.path, backup_path)
            except Exception as exc:
                logger.warning("Failed to back up old writing memory database %s: %s", self.path, exc)

        with self._connect() as conn:
            self._create_schema(conn)
            if legacy_state is not None:
                self._import_legacy_state(conn, legacy_state)
            conn.commit()
        self._runtime_cache = None

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=SQLITE_BUSY_TIMEOUT_SECONDS, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _create_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dictionary_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                canonical_text TEXT NOT NULL,
                aliases_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS replacement_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_text TEXT NOT NULL COLLATE NOCASE UNIQUE,
                replacement_text TEXT NOT NULL,
                match_type TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snippet_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trigger TEXT NOT NULL COLLATE NOCASE UNIQUE,
                expansion TEXT NOT NULL,
                match_type TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS history_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL,
                transcript TEXT NOT NULL,
                final_output TEXT NOT NULL,
                created_at TEXT NOT NULL,
                telemetry_json TEXT NOT NULL,
                context_json TEXT NOT NULL,
                stt_provider TEXT,
                stt_model TEXT,
                llm_provider TEXT,
                llm_model TEXT
            );
            """
        )
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", (SCHEMA_VERSION,))
        safe_chmod(self.path, 0o600)

    def _load_tools(self, *, enabled_only: bool) -> WritingToolsSnapshot:
        where_clause = "WHERE enabled = 1" if enabled_only else ""

        def _read(conn: sqlite3.Connection) -> WritingToolsSnapshot:
            return WritingToolsSnapshot(
                dictionary=[
                    self._row_to_dictionary_entry(row)
                    for row in conn.execute(
                        f"SELECT * FROM dictionary_entries {where_clause} ORDER BY updated_at DESC, id DESC"
                    ).fetchall()
                ],
                replacements=[
                    ReplacementEntry(
                        id=int(row["id"]),
                        source_text=str(row["source_text"]),
                        replacement_text=str(row["replacement_text"]),
                        match_type=str(row["match_type"]),
                        enabled=bool(row["enabled"]),
                        updated_at=str(row["updated_at"]),
                    )
                    for row in conn.execute(
                        f"SELECT * FROM replacement_entries {where_clause} ORDER BY updated_at DESC, id DESC"
                    ).fetchall()
                ],
                snippets=[
                    SnippetEntry(
                        id=int(row["id"]),
                        trigger=str(row["trigger"]),
                        expansion=str(row["expansion"]),
                        match_type=str(row["match_type"]),
                        enabled=bool(row["enabled"]),
                        updated_at=str(row["updated_at"]),
                    )
                    for row in conn.execute(
                        f"SELECT * FROM snippet_entries {where_clause} ORDER BY updated_at DESC, id DESC"
                    ).fetchall()
                ],
            )

        return self._run_read_with_lock_retries(_read)

    def _create_tool_entry(self, *, table: str, key_column: str, key_value: str, values: Dict[str, Any]) -> Any:
        columns = ", ".join(values.keys())
        placeholders = ", ".join(["?"] * len(values))
        params = tuple(values.values())

        def _write(conn: sqlite3.Connection) -> int:
            cursor = conn.execute(
                f"INSERT INTO {table} ({columns}) VALUES ({placeholders})",
                params,
            )
            return int(cursor.lastrowid)

        entry_id = self._run_write_with_lock_retries(_write)
        self._runtime_cache = None
        return self._find_tool_entry(table, entry_id)

    def _update_tool_entry(self, *, table: str, entry_id: int, key_column: str, key_value: str, values: Dict[str, Any]) -> Any:
        assignments = ", ".join(f"{column} = ?" for column in values.keys())
        params = tuple(values.values()) + (entry_id,)

        def _write(conn: sqlite3.Connection) -> None:
            cursor = conn.execute(
                f"UPDATE {table} SET {assignments} WHERE id = ?",
                params,
            )
            if cursor.rowcount == 0:
                raise ValueError("Requested item was not found.")

        self._run_write_with_lock_retries(_write)
        self._runtime_cache = None
        return self._find_tool_entry(table, entry_id)

    def _delete_tool_entry(self, table: str, entry_id: int) -> None:
        def _write(conn: sqlite3.Connection) -> None:
            conn.execute(f"DELETE FROM {table} WHERE id = ?", (entry_id,))

        self._run_write_with_lock_retries(_write)
        self._runtime_cache = None

    def _find_tool_entry(self, table: str, entry_id: int) -> Any:
        def _read(conn: sqlite3.Connection) -> Any:
            row = conn.execute(
                f"SELECT * FROM {table} WHERE id = ?",
                (entry_id,),
            ).fetchone()
            if row is None:
                return None
            if table == "dictionary_entries":
                return self._row_to_dictionary_entry(row)
            if table == "replacement_entries":
                return ReplacementEntry(
                    id=int(row["id"]),
                    source_text=str(row["source_text"]),
                    replacement_text=str(row["replacement_text"]),
                    match_type=str(row["match_type"]),
                    enabled=bool(row["enabled"]),
                    updated_at=str(row["updated_at"]),
                )
            if table == "snippet_entries":
                return SnippetEntry(
                    id=int(row["id"]),
                    trigger=str(row["trigger"]),
                    expansion=str(row["expansion"]),
                    match_type=str(row["match_type"]),
                    enabled=bool(row["enabled"]),
                    updated_at=str(row["updated_at"]),
                )
            return None

        entry = self._run_read_with_lock_retries(_read)
        if entry is None:
            raise ValueError("Requested item was not found.")
        return entry

    def _row_to_dictionary_entry(self, row: sqlite3.Row) -> DictionaryEntry:
        try:
            raw_aliases = json.loads(str(row["aliases_json"]))
            aliases = _normalize_alias_list(raw_aliases)
        except (TypeError, ValueError, json.JSONDecodeError):
            aliases = []
        return DictionaryEntry(
            id=int(row["id"]),
            canonical_text=str(row["canonical_text"]),
            aliases=aliases,
            enabled=bool(row["enabled"]),
            updated_at=str(row["updated_at"]),
        )

    def _assert_dictionary_entry_is_unique(
        self,
        conn: sqlite3.Connection,
        payload: DictionaryEntryPayload,
        *,
        ignore_entry_id: Optional[int] = None,
    ) -> None:
        requested_terms = {payload.canonical_text.lower(), *(alias.lower() for alias in payload.aliases)}
        rows = conn.execute("SELECT id, canonical_text, aliases_json FROM dictionary_entries").fetchall()
        for row in rows:
            row_id = int(row["id"])
            if ignore_entry_id is not None and row_id == ignore_entry_id:
                continue
            existing_terms = {str(row["canonical_text"]).strip().lower()}
            try:
                existing_aliases = _normalize_alias_list(json.loads(str(row["aliases_json"])))
            except (TypeError, ValueError, json.JSONDecodeError):
                existing_aliases = []
            existing_terms.update(alias.lower() for alias in existing_aliases)
            if requested_terms & existing_terms:
                raise ValueError("A matching entry already exists.")

    def _export_legacy_state(self, conn: sqlite3.Connection) -> Dict[str, list[Dict[str, Any]]]:
        return {
            "dictionary": [
                {
                    "id": int(row["id"]),
                    "canonical_text": str(row["canonical_text"]),
                    "aliases": [str(row["source_text"])],
                    "enabled": int(row["enabled"]),
                    "updated_at": str(row["updated_at"]),
                }
                for row in conn.execute("SELECT * FROM dictionary_entries ORDER BY id").fetchall()
            ],
            "replacements": [dict(row) for row in conn.execute("SELECT * FROM replacement_entries ORDER BY id").fetchall()],
            "snippets": [dict(row) for row in conn.execute("SELECT * FROM snippet_entries ORDER BY id").fetchall()],
            "history": [dict(row) for row in conn.execute("SELECT * FROM history_items ORDER BY id").fetchall()],
        }

    def _import_legacy_state(self, conn: sqlite3.Connection, state: Dict[str, list[Dict[str, Any]]]) -> None:
        for entry in state.get("dictionary", []):
            conn.execute(
                """
                INSERT INTO dictionary_entries (id, canonical_text, aliases_json, enabled, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    entry["id"],
                    entry["canonical_text"],
                    json.dumps(entry.get("aliases", []), ensure_ascii=False),
                    entry["enabled"],
                    entry["updated_at"],
                ),
            )

        for row in state.get("replacements", []):
            conn.execute(
                """
                INSERT INTO replacement_entries (id, source_text, replacement_text, match_type, enabled, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["source_text"],
                    row["replacement_text"],
                    row["match_type"],
                    row["enabled"],
                    row["updated_at"],
                ),
            )

        for row in state.get("snippets", []):
            conn.execute(
                """
                INSERT INTO snippet_entries (id, trigger, expansion, match_type, enabled, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["trigger"],
                    row["expansion"],
                    row["match_type"],
                    row["enabled"],
                    row["updated_at"],
                ),
            )

        for row in state.get("history", []):
            conn.execute(
                """
                INSERT INTO history_items (
                    id, mode, transcript, final_output, created_at, telemetry_json, context_json,
                    stt_provider, stt_model, llm_provider, llm_model
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["mode"],
                    row["transcript"],
                    row["final_output"],
                    row["created_at"],
                    row["telemetry_json"],
                    row["context_json"],
                    row["stt_provider"],
                    row["stt_model"],
                    row["llm_provider"],
                    row["llm_model"],
                ),
            )

    def _read_history(self, conn: sqlite3.Connection, limit: int) -> List[HistoryItem]:
        rows = conn.execute(
            "SELECT * FROM history_items ORDER BY id DESC LIMIT ?",
            (max(1, min(limit, 500)),),
        ).fetchall()
        return [self._row_to_history_item(row) for row in rows]

    def _read_history_item(self, conn: sqlite3.Connection, item_id: int) -> Optional[HistoryItem]:
        row = conn.execute("SELECT * FROM history_items WHERE id = ?", (item_id,)).fetchone()
        return self._row_to_history_item(row) if row is not None else None

    def _row_to_history_item(self, row: sqlite3.Row) -> HistoryItem:
        return HistoryItem(
            id=int(row["id"]),
            mode=str(row["mode"]),
            transcript=str(row["transcript"]),
            final_output=str(row["final_output"]),
            created_at=str(row["created_at"]),
            telemetry=_safe_json_loads(row["telemetry_json"], context="telemetry_json", row_id=row["id"]),
            context=_safe_json_loads(row["context_json"], context="context_json", row_id=row["id"]),
            stt_provider=row["stt_provider"],
            stt_model=row["stt_model"],
            llm_provider=row["llm_provider"],
            llm_model=row["llm_model"],
        )

    def _run_write_with_lock_retries(self, callback):
        attempt = 0
        while True:
            try:
                with self._lock, self._connect() as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    result = callback(conn)
                    conn.commit()
                    safe_chmod(self.path, 0o600)
                    return result
            except sqlite3.IntegrityError as exc:
                if "unique" in str(exc).lower():
                    raise ValueError("A matching entry already exists.") from exc
                raise RuntimeError("Writing tools could not save the requested change.") from exc
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt >= len(LOCK_RETRY_DELAYS):
                    raise RuntimeError("Writing tools are temporarily busy. Try again.") from exc
                time.sleep(LOCK_RETRY_DELAYS[attempt])
                attempt += 1

    def _run_read_with_lock_retries(self, callback):
        attempt = 0
        while True:
            try:
                with self._connect() as conn:
                    return callback(conn)
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt >= len(LOCK_RETRY_DELAYS):
                    raise RuntimeError("Writing memory is temporarily busy. Try again.") from exc
                time.sleep(LOCK_RETRY_DELAYS[attempt])
                attempt += 1
