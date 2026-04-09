from __future__ import annotations

import re
import shutil
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from semantic_memory import SemanticMemoryClient, SemanticMemoryItem
from utils.logger import get_logger
from utils.paths import get_app_home, safe_chmod
from writing_memory import HistoryItem

logger = get_logger()
SCHEMA_VERSION = "2"
LOCK_RETRY_DELAYS = (0.05, 0.1, 0.2)
SQLITE_BUSY_TIMEOUT_SECONDS = 1.5
MEMORY_CHAR_BUDGET = 900
MAX_MEMORY_RESULTS = 5
MAX_HISTORY_SCAN_ITEMS = 5000
MAX_COMBINED_TEXT_CHARS = 64_000
MAX_RETRIEVAL_TEXT_CHARS = 520
MAX_SUPPORT_TEXT_CHARS = 180
MAX_SUPPORT_TEXTS_PER_MEMORY = 4
FTS_QUERY_TOKEN_LIMIT = 12

TOKEN_SYNONYMS: dict[str, tuple[str, ...]] = {
    "concise": ("brief", "short", "compact"),
    "brief": ("concise", "short"),
    "short": ("brief", "concise"),
    "formal": ("professional",),
    "professional": ("formal",),
    "friendly": ("warm", "casual"),
    "direct": ("clear",),
    "clear": ("direct", "simple"),
    "simple": ("plain", "clear"),
    "plain": ("simple",),
    "bullet": ("bullets", "bulleted", "list"),
    "bullets": ("bullet", "bulleted", "list"),
    "bulleted": ("bullet", "bullets", "list"),
    "numbered": ("list", "ordered"),
}

MemoryKind = Literal[
    "writing_preference",
    "user_fact",
    "person_or_project",
    "term_preference",
]

WHITESPACE_PATTERN = re.compile(r"\s+")
TOKEN_PATTERN = re.compile(r"[a-z0-9]{2,}")
PROJECT_ENTITY_PATTERN = re.compile(
    r"(?i:\b(project|client|customer|account|team|vendor|partner|program))[ \t]+([A-Z][A-Za-z0-9&._-]*(?:[ \t]+[A-Z][A-Za-z0-9&._-]*){0,3})\b",
)
MY_NAME_PATTERN = re.compile(r"\bmy name is\s+([A-Z][A-Za-z .'-]{1,60})\b", re.IGNORECASE)
WORK_AT_PATTERN = re.compile(r"\bi work at\s+([A-Z][A-Za-z0-9& .'-]{1,80})\b", re.IGNORECASE)
LIVE_IN_PATTERN = re.compile(r"\b(?:i live in|i am based in)\s+([A-Z][A-Za-z .'-]{1,80})\b", re.IGNORECASE)
WORK_ON_PATTERN = re.compile(r"\bi work on\s+([A-Z][A-Za-z0-9& .'-]{1,80})\b", re.IGNORECASE)
PREFER_PATTERN = re.compile(r"\bi prefer\s+(.{3,100}?)(?:[.!?]|$)", re.IGNORECASE)
PLEASE_USE_PATTERN = re.compile(r"\bplease use\s+(.{3,100}?)(?:[.!?]|$)", re.IGNORECASE)
TERM_PREFERENCE_PATTERN = re.compile(r"\buse\s+(.{2,48}?)\s+instead of\s+(.{2,48}?)(?:[.!?]|$)", re.IGNORECASE)
CALL_AS_PATTERN = re.compile(r"\b(?:call|refer to)\s+(.{2,48}?)\s+as\s+(.{2,48}?)(?:[.!?]|$)", re.IGNORECASE)
WRITING_PREFERENCE_KEYWORDS = (
    "concise",
    "brief",
    "short",
    "formal",
    "professional",
    "friendly",
    "direct",
    "simple",
    "plain language",
    "bullet",
    "bullets",
    "numbered",
    "title case",
)


class MemoryRecord(BaseModel):
    id: int
    kind: MemoryKind
    summary: str
    confidence: float
    enabled: bool
    created_at: str
    updated_at: str
    last_seen_at: str
    evidence_count: int
    source_history_ids: list[int] = Field(default_factory=list)
    app_name: Optional[str] = None
    url_host: Optional[str] = None
    domain_id: Optional[str] = None


class MemoryTogglePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool


@dataclass(frozen=True)
class MemoryCandidate:
    normalized_key: str
    kind: MemoryKind
    summary: str
    confidence: float
    history_id: int
    explicit: bool
    min_occurrences: int
    created_at: str
    app_name: Optional[str] = None
    url_host: Optional[str] = None
    domain_id: Optional[str] = None
    support_text: str = ""


@dataclass
class _CandidateAggregate:
    normalized_key: str
    kind: MemoryKind
    summary: str
    base_confidence: float
    history_ids: set[int] = field(default_factory=set)
    explicit: bool = False
    min_occurrences: int = 2
    last_seen_at: str = ""
    app_name: Optional[str] = None
    url_host: Optional[str] = None
    domain_id: Optional[str] = None
    support_texts: list[str] = field(default_factory=list)


def _utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _normalize_spaces(value: Any) -> str:
    return WHITESPACE_PATTERN.sub(" ", str(value or "")).strip()


def _normalize_key_fragment(value: str) -> str:
    cleaned = _normalize_spaces(value).lower()
    cleaned = re.sub(r"[^a-z0-9]+", "_", cleaned)
    return cleaned.strip("_")


def _normalize_scope_value(value: Any) -> Optional[str]:
    cleaned = _normalize_spaces(value).lower()
    return cleaned or None


def _tokenize(value: str) -> set[str]:
    return set(TOKEN_PATTERN.findall(str(value or "").lower()))


def _expand_tokens(tokens: Iterable[str]) -> set[str]:
    expanded = {token for token in tokens if token}
    for token in list(expanded):
        expanded.update(TOKEN_SYNONYMS.get(token, ()))
    return expanded


def _build_support_text(transcript: str, final_output: str) -> str:
    pieces = [
        _clip_sentence(transcript, max_chars=MAX_SUPPORT_TEXT_CHARS),
        _clip_sentence(final_output, max_chars=MAX_SUPPORT_TEXT_CHARS),
    ]
    deduped: list[str] = []
    for piece in pieces:
        if piece and piece not in deduped:
            deduped.append(piece)
    return " ".join(deduped).strip()


def _build_retrieval_text(summary: str, support_texts: Iterable[str]) -> str:
    segments: list[str] = []
    for value in [summary, *support_texts]:
        cleaned = _normalize_spaces(value)
        if cleaned and cleaned not in segments:
            segments.append(cleaned)
        if len(segments) >= 1 + MAX_SUPPORT_TEXTS_PER_MEMORY:
            break

    retrieval_text = " ".join(segments).strip()
    if not retrieval_text:
        retrieval_text = _normalize_spaces(summary)

    expanded_tokens = sorted(_expand_tokens(_tokenize(retrieval_text)))
    if expanded_tokens:
        retrieval_text = f"{retrieval_text} {' '.join(expanded_tokens)}".strip()

    return retrieval_text[:MAX_RETRIEVAL_TEXT_CHARS].strip()


def _build_fts_query(transcript: str) -> str:
    tokens = sorted(_expand_tokens(_tokenize(transcript)))
    if not tokens:
        return ""
    return " OR ".join(tokens[:FTS_QUERY_TOKEN_LIMIT])


def _clip_sentence(value: str, *, max_chars: int = 140) -> str:
    cleaned = _normalize_spaces(value).strip(" .")
    if len(cleaned) <= max_chars:
        return cleaned
    clipped = cleaned[: max_chars - 3].rstrip()
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0].rstrip() or clipped
    return f"{clipped}..."


def _extract_scope(item: HistoryItem) -> tuple[Optional[str], Optional[str], Optional[str]]:
    context = item.context or {}
    telemetry = item.telemetry or {}
    return (
        _normalize_scope_value(context.get("app_name")),
        _normalize_scope_value(context.get("url_host")),
        _normalize_scope_value(telemetry.get("domain_id") or context.get("domain_id")),
    )


def _writing_preference_summary(value: str) -> Optional[str]:
    cleaned = _clip_sentence(value)
    if not cleaned:
        return None
    lowered = cleaned.lower()
    if not any(keyword in lowered for keyword in WRITING_PREFERENCE_KEYWORDS):
        return None
    return f"Writing preference: {cleaned}."


def _term_preference_summary(preferred: str, previous: str) -> Optional[str]:
    preferred_clean = _clip_sentence(preferred, max_chars=48)
    previous_clean = _clip_sentence(previous, max_chars=48)
    if not preferred_clean or not previous_clean:
        return None
    return f'Prefer "{preferred_clean}" instead of "{previous_clean}".'


class LocalMemoryStore:
    def __init__(self, path: Optional[Path] = None):
        self.path = path or (get_app_home() / "local_memory.sqlite3")
        self._lock = threading.RLock()
        self.semantic_client = SemanticMemoryClient()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        safe_chmod(self.path.parent, 0o700)
        self._initialize()

    def list_memories(self, limit: int = 500) -> list[MemoryRecord]:
        return self._run_read_with_lock_retries(
            lambda conn: self._read_memories(conn, limit=max(1, min(limit, 500)))
        )

    def update_memory_enabled(self, memory_id: int, enabled: bool) -> MemoryRecord:
        def _write(conn: sqlite3.Connection) -> None:
            cursor = conn.execute(
                "UPDATE memories SET enabled = ?, updated_at = ? WHERE id = ?",
                (1 if enabled else 0, _utc_timestamp(), memory_id),
            )
            if cursor.rowcount == 0:
                raise ValueError("Requested memory was not found.")

        self._run_write_with_lock_retries(_write)
        return self._find_memory(memory_id)

    def delete_memory(self, memory_id: int) -> None:
        def _write(conn: sqlite3.Connection) -> None:
            row = conn.execute(
                "SELECT id, normalized_key FROM memories WHERE id = ?",
                (memory_id,),
            ).fetchone()
            if row is None:
                raise ValueError("Requested memory was not found.")
            normalized_key = str(row["normalized_key"])
            conn.execute(
                "INSERT OR REPLACE INTO memory_tombstones (normalized_key, deleted_at) VALUES (?, ?)",
                (normalized_key, _utc_timestamp()),
            )
            conn.execute("DELETE FROM memory_observations WHERE normalized_key = ?", (normalized_key,))
            self._delete_memory_row(conn, int(row["id"]))

        self._run_write_with_lock_retries(_write)

    def clear_memories(self) -> None:
        def _write(conn: sqlite3.Connection) -> None:
            rows = conn.execute("SELECT normalized_key FROM memories").fetchall()
            deleted_at = _utc_timestamp()
            for row in rows:
                normalized_key = str(row["normalized_key"])
                conn.execute(
                    "INSERT OR REPLACE INTO memory_tombstones (normalized_key, deleted_at) VALUES (?, ?)",
                    (normalized_key, deleted_at),
                )
                conn.execute("DELETE FROM memory_observations WHERE normalized_key = ?", (normalized_key,))
            conn.execute("DELETE FROM memory_fts")
            conn.execute("DELETE FROM memory_evidence")
            conn.execute("DELETE FROM memories")

        self._run_write_with_lock_retries(_write)

    def rebuild_from_history(
        self,
        history_items: Iterable[HistoryItem],
        *,
        reset_tombstones: bool = False,
    ) -> list[MemoryRecord]:
        observations = self._extract_memory_candidates(history_items)
        aggregates = self._aggregate_candidates(observations)

        def _write(conn: sqlite3.Connection) -> None:
            if reset_tombstones:
                conn.execute("DELETE FROM memory_tombstones")

            existing_rows = conn.execute(
                "SELECT id, normalized_key, enabled, created_at FROM memories"
            ).fetchall()
            existing_by_key = {
                str(row["normalized_key"]): row
                for row in existing_rows
            }
            tombstones = {
                str(row["normalized_key"])
                for row in conn.execute("SELECT normalized_key FROM memory_tombstones").fetchall()
            }

            conn.execute("DELETE FROM memory_observations")
            for candidate in observations:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO memory_observations (
                        normalized_key,
                        history_item_id,
                        kind,
                        summary,
                        confidence,
                        explicit,
                        min_occurrences,
                        created_at,
                        app_name,
                        url_host,
                        domain_id,
                        support_text
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        candidate.normalized_key,
                        candidate.history_id,
                        candidate.kind,
                        candidate.summary,
                        candidate.confidence,
                        1 if candidate.explicit else 0,
                        candidate.min_occurrences,
                        candidate.created_at,
                        candidate.app_name,
                        candidate.url_host,
                        candidate.domain_id,
                        candidate.support_text,
                    ),
                )

            conn.execute("DELETE FROM memory_evidence")
            conn.execute("DELETE FROM memory_fts")
            active_keys: list[str] = []

            for aggregate in aggregates:
                if aggregate.normalized_key in tombstones:
                    continue

                evidence_count = len(aggregate.history_ids)
                if not aggregate.explicit and evidence_count < aggregate.min_occurrences:
                    continue

                memory_id = self._upsert_memory_aggregate(
                    conn,
                    aggregate,
                    existing_row=existing_by_key.get(aggregate.normalized_key),
                )
                active_keys.append(aggregate.normalized_key)
                self._sync_memory_evidence(conn, memory_id, aggregate.history_ids)
                self._sync_memory_fts(
                    conn,
                    memory_id=memory_id,
                    retrieval_text=_build_retrieval_text(aggregate.summary, aggregate.support_texts),
                )

            active_key_set = set(active_keys)
            for normalized_key, row in existing_by_key.items():
                if normalized_key not in active_key_set:
                    self._delete_memory_row(conn, int(row["id"]))

        self._run_write_with_lock_retries(_write)
        return self.list_memories()

    def learn_from_history_item(self, history_item: HistoryItem) -> list[MemoryRecord]:
        candidates = self._extract_candidates(history_item)
        if not candidates:
            return self.list_memories()

        def _write(conn: sqlite3.Connection) -> None:
            tombstones = {
                str(row["normalized_key"])
                for row in conn.execute("SELECT normalized_key FROM memory_tombstones").fetchall()
            }
            affected_keys: set[str] = set()

            for candidate in candidates:
                if candidate.normalized_key in tombstones:
                    continue
                affected_keys.add(candidate.normalized_key)
                conn.execute(
                    """
                    INSERT OR REPLACE INTO memory_observations (
                        normalized_key,
                        history_item_id,
                        kind,
                        summary,
                        confidence,
                        explicit,
                        min_occurrences,
                        created_at,
                        app_name,
                        url_host,
                        domain_id,
                        support_text
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        candidate.normalized_key,
                        candidate.history_id,
                        candidate.kind,
                        candidate.summary,
                        candidate.confidence,
                        1 if candidate.explicit else 0,
                        candidate.min_occurrences,
                        candidate.created_at,
                        candidate.app_name,
                        candidate.url_host,
                        candidate.domain_id,
                        candidate.support_text,
                    ),
                )

            if not affected_keys:
                return

            existing_rows = conn.execute(
                """
                SELECT id, normalized_key, enabled, created_at
                FROM memories
                WHERE normalized_key IN ({})
                """.format(", ".join(["?"] * len(affected_keys))),
                tuple(sorted(affected_keys)),
            ).fetchall()
            existing_by_key = {
                str(row["normalized_key"]): row
                for row in existing_rows
            }

            observation_rows = conn.execute(
                """
                SELECT *
                FROM memory_observations
                WHERE normalized_key IN ({})
                ORDER BY created_at ASC, history_item_id ASC
                """.format(", ".join(["?"] * len(affected_keys))),
                tuple(sorted(affected_keys)),
            ).fetchall()
            grouped_rows: dict[str, list[sqlite3.Row]] = {}
            for row in observation_rows:
                grouped_rows.setdefault(str(row["normalized_key"]), []).append(row)

            for normalized_key in sorted(affected_keys):
                aggregate = self._aggregate_candidates(
                    self._rows_to_candidates(grouped_rows.get(normalized_key, []))
                )
                if not aggregate:
                    if normalized_key in existing_by_key:
                        self._delete_memory_row(conn, int(existing_by_key[normalized_key]["id"]))
                    continue

                memory_aggregate = aggregate[0]
                evidence_count = len(memory_aggregate.history_ids)
                if not memory_aggregate.explicit and evidence_count < memory_aggregate.min_occurrences:
                    if normalized_key in existing_by_key:
                        self._delete_memory_row(conn, int(existing_by_key[normalized_key]["id"]))
                    continue

                memory_id = self._upsert_memory_aggregate(
                    conn,
                    memory_aggregate,
                    existing_row=existing_by_key.get(normalized_key),
                )
                self._sync_memory_evidence(conn, memory_id, memory_aggregate.history_ids)
                self._sync_memory_fts(
                    conn,
                    memory_id=memory_id,
                    retrieval_text=_build_retrieval_text(memory_aggregate.summary, memory_aggregate.support_texts),
                )

        self._run_write_with_lock_retries(_write)
        return self.list_memories()

    def build_context_block(
        self,
        *,
        transcript: str,
        context: Optional[dict[str, Any]] = None,
        max_items: int = MAX_MEMORY_RESULTS,
        char_budget: int = MEMORY_CHAR_BUDGET,
        semantic_retrieval_enabled: bool = True,
    ) -> str:
        selected = self.retrieve_memories(
            transcript=transcript,
            context=context,
            max_items=max_items,
            char_budget=char_budget,
            semantic_retrieval_enabled=semantic_retrieval_enabled,
        )
        if not selected:
            return ""

        lines = [
            "Use these stable local user preferences and recurring facts only when they are directly relevant:",
        ]
        for memory in selected:
            lines.append(f"- {memory.summary}")
        return "\n".join(lines)

    def retrieve_memories(
        self,
        *,
        transcript: str,
        context: Optional[dict[str, Any]] = None,
        max_items: int = MAX_MEMORY_RESULTS,
        char_budget: int = MEMORY_CHAR_BUDGET,
        semantic_retrieval_enabled: bool = True,
    ) -> list[MemoryRecord]:
        query_tokens = _expand_tokens(_tokenize(transcript))
        context = context or {}
        app_name = _normalize_scope_value(context.get("app_name"))
        url_host = _normalize_scope_value(context.get("url_host"))
        domain_id = _normalize_scope_value(context.get("domain_id"))
        scored: list[tuple[float, MemoryRecord]] = []
        memories = [memory for memory in self.list_memories(limit=500) if memory.enabled]
        if not memories:
            return []

        fts_scores = self._query_fts_scores(transcript, limit=max(max_items * 3, 12))
        retrieval_texts = self._read_retrieval_texts([memory.id for memory in memories])
        semantic_scores = (
            self.semantic_client.query(
                query=transcript,
                items=[
                    SemanticMemoryItem(
                        id=memory.id,
                        retrieval_text=retrieval_texts.get(memory.id, memory.summary),
                    )
                    for memory in memories
                ],
                limit=max(max_items * 3, 10),
            )
            if semantic_retrieval_enabled
            else {}
        )

        for memory in memories:
            if not memory.enabled:
                continue
            summary_tokens = _expand_tokens(_tokenize(memory.summary))
            lexical_overlap = len(query_tokens & summary_tokens)
            scope_score = 0.0
            memory_app = _normalize_scope_value(memory.app_name)
            memory_host = _normalize_scope_value(memory.url_host)
            memory_domain = _normalize_scope_value(memory.domain_id)
            if app_name and memory_app and memory_app == app_name:
                scope_score += 1.0
            if url_host and memory_host and memory_host == url_host:
                scope_score += 1.0
            if domain_id and memory_domain and memory_domain == domain_id:
                scope_score += 1.2

            fts_bonus = fts_scores.get(memory.id, 0.0)
            semantic_bonus = semantic_scores.get(memory.id, 0.0) * 12.0

            if lexical_overlap == 0 and scope_score == 0 and fts_bonus == 0.0 and semantic_bonus == 0.0:
                continue

            score = (
                lexical_overlap * 12.0
                + scope_score * 8.0
                + fts_bonus
                + semantic_bonus
                + memory.confidence * 10.0
                + min(memory.evidence_count, 5)
            )
            scored.append((score, memory))

        scored.sort(
            key=lambda item: (
                item[0],
                item[1].confidence,
                item[1].evidence_count,
                item[1].last_seen_at,
            ),
            reverse=True,
        )

        effective_budget = max(80, char_budget)
        selected: list[MemoryRecord] = []
        used_chars = 0
        for _score, memory in scored:
            line_cost = len(memory.summary) + 3
            if used_chars + line_cost > effective_budget:
                continue
            selected.append(memory)
            used_chars += line_cost
            if len(selected) >= max_items:
                break
        return selected

    def _extract_memory_candidates(self, history_items: Iterable[HistoryItem]) -> list[MemoryCandidate]:
        observations: list[MemoryCandidate] = []
        scanned = 0
        for item in history_items:
            if scanned >= MAX_HISTORY_SCAN_ITEMS:
                logger.info(
                    "Local memory: stopped scanning history at %d items (cap)", MAX_HISTORY_SCAN_ITEMS
                )
                break
            scanned += 1
            try:
                observations.extend(self._extract_candidates(item))
            except Exception as exc:
                logger.warning("Local memory: failed to extract candidates for history item: %s", exc)
                continue
        return observations

    def _aggregate_candidates(self, candidates: Iterable[MemoryCandidate]) -> list[_CandidateAggregate]:
        grouped: dict[str, _CandidateAggregate] = {}
        for candidate in candidates:
            aggregate = grouped.get(candidate.normalized_key)
            if aggregate is None:
                aggregate = _CandidateAggregate(
                    normalized_key=candidate.normalized_key,
                    kind=candidate.kind,
                    summary=candidate.summary,
                    base_confidence=candidate.confidence,
                    explicit=candidate.explicit,
                    min_occurrences=candidate.min_occurrences,
                    last_seen_at=candidate.created_at,
                    app_name=candidate.app_name,
                    url_host=candidate.url_host,
                    domain_id=candidate.domain_id,
                )
                grouped[candidate.normalized_key] = aggregate
            aggregate.history_ids.add(candidate.history_id)
            aggregate.base_confidence = max(aggregate.base_confidence, candidate.confidence)
            aggregate.explicit = aggregate.explicit or candidate.explicit
            aggregate.min_occurrences = min(aggregate.min_occurrences, candidate.min_occurrences)
            if candidate.support_text and candidate.support_text not in aggregate.support_texts:
                aggregate.support_texts.append(candidate.support_text)
            if candidate.created_at > aggregate.last_seen_at:
                aggregate.last_seen_at = candidate.created_at
                aggregate.summary = candidate.summary
                aggregate.app_name = candidate.app_name or aggregate.app_name
                aggregate.url_host = candidate.url_host or aggregate.url_host
                aggregate.domain_id = candidate.domain_id or aggregate.domain_id
        return list(grouped.values())

    def _extract_candidates(self, item: HistoryItem) -> list[MemoryCandidate]:
        transcript = str(item.transcript or "").strip()
        final_output = str(item.final_output or "").strip()
        combined = "\n".join(part for part in (transcript, final_output) if part).strip()
        if not combined:
            return []
        if len(combined) > MAX_COMBINED_TEXT_CHARS:
            combined = combined[:MAX_COMBINED_TEXT_CHARS]

        app_name, url_host, domain_id = _extract_scope(item)
        created_at = str(item.created_at or _utc_timestamp())
        support_text = _build_support_text(transcript, final_output)
        candidates: list[MemoryCandidate] = []

        def add_candidate(
            *,
            normalized_key: str,
            kind: MemoryKind,
            summary: str,
            confidence: float,
            explicit: bool,
            min_occurrences: int,
        ) -> None:
            key = _normalize_key_fragment(normalized_key)
            summary_text = _clip_sentence(summary, max_chars=160).strip()
            if not key or not summary_text:
                return
            candidates.append(
                MemoryCandidate(
                    normalized_key=f"{kind}:{key}",
                    kind=kind,
                    summary=summary_text if summary_text.endswith(".") else f"{summary_text}.",
                    confidence=confidence,
                    history_id=item.id,
                    explicit=explicit,
                    min_occurrences=min_occurrences,
                    created_at=created_at,
                    app_name=app_name,
                    url_host=url_host,
                    domain_id=domain_id,
                    support_text=support_text,
                )
            )

        for pattern, template in (
            (MY_NAME_PATTERN, lambda value: ("user_fact", f"name:{value}", f"User name: {_clip_sentence(value, max_chars=60)}", 0.92)),
            (WORK_AT_PATTERN, lambda value: ("user_fact", f"work_at:{value}", f"User works at {_clip_sentence(value, max_chars=80)}", 0.88)),
            (LIVE_IN_PATTERN, lambda value: ("user_fact", f"live_in:{value}", f"User is based in {_clip_sentence(value, max_chars=80)}", 0.85)),
            (WORK_ON_PATTERN, lambda value: ("person_or_project", f"work_on:{value}", f"Project or initiative: {_clip_sentence(value, max_chars=80)}", 0.82)),
        ):
            for match in pattern.finditer(combined):
                value = _normalize_spaces(match.group(1))
                if not value:
                    continue
                kind, key, summary, confidence = template(value)
                add_candidate(
                    normalized_key=key,
                    kind=kind,  # type: ignore[arg-type]
                    summary=summary,
                    confidence=confidence,
                    explicit=True,
                    min_occurrences=1,
                )

        for pattern in (PREFER_PATTERN, PLEASE_USE_PATTERN):
            for match in pattern.finditer(combined):
                summary = _writing_preference_summary(match.group(1))
                if not summary:
                    continue
                add_candidate(
                    normalized_key=f"writing:{summary}",
                    kind="writing_preference",
                    summary=summary,
                    confidence=0.84,
                    explicit=True,
                    min_occurrences=1,
                )

        for match in TERM_PREFERENCE_PATTERN.finditer(combined):
            summary = _term_preference_summary(match.group(1), match.group(2))
            if not summary:
                continue
            add_candidate(
                normalized_key=f"term:{match.group(1)}:{match.group(2)}",
                kind="term_preference",
                summary=summary,
                confidence=0.9,
                explicit=True,
                min_occurrences=1,
            )

        for match in CALL_AS_PATTERN.finditer(combined):
            old_value = _clip_sentence(match.group(1), max_chars=48)
            new_value = _clip_sentence(match.group(2), max_chars=48)
            if not old_value or not new_value:
                continue
            add_candidate(
                normalized_key=f"term:{old_value}:{new_value}",
                kind="term_preference",
                summary=f'Refer to "{old_value}" as "{new_value}".',
                confidence=0.88,
                explicit=True,
                min_occurrences=1,
            )

        for match in PROJECT_ENTITY_PATTERN.finditer(combined):
            prefix = _normalize_spaces(match.group(1)).title()
            label = _normalize_spaces(match.group(2))
            if not label:
                continue
            add_candidate(
                normalized_key=f"{prefix}:{label}",
                kind="person_or_project",
                summary=f"{prefix}: {_clip_sentence(label, max_chars=70)}",
                confidence=0.7,
                explicit=False,
                min_occurrences=2,
            )

        deduped: dict[str, MemoryCandidate] = {}
        for candidate in candidates:
            if candidate.normalized_key not in deduped:
                deduped[candidate.normalized_key] = candidate
        return list(deduped.values())

    def _resolve_confidence(self, aggregate: _CandidateAggregate, evidence_count: int) -> float:
        bonus = 0.04 * max(0, evidence_count - 1)
        base = aggregate.base_confidence + bonus
        if aggregate.explicit:
            return min(0.96, base)
        return min(0.9, base)

    def _rows_to_candidates(self, rows: Iterable[sqlite3.Row]) -> list[MemoryCandidate]:
        candidates: list[MemoryCandidate] = []
        for row in rows:
            candidates.append(
                MemoryCandidate(
                    normalized_key=str(row["normalized_key"]),
                    kind=str(row["kind"]),  # type: ignore[arg-type]
                    summary=str(row["summary"]),
                    confidence=float(row["confidence"]),
                    history_id=int(row["history_item_id"]),
                    explicit=bool(row["explicit"]),
                    min_occurrences=int(row["min_occurrences"]),
                    created_at=str(row["created_at"]),
                    app_name=row["app_name"],
                    url_host=row["url_host"],
                    domain_id=row["domain_id"],
                    support_text=str(row["support_text"] or ""),
                )
            )
        return candidates

    def _upsert_memory_aggregate(
        self,
        conn: sqlite3.Connection,
        aggregate: _CandidateAggregate,
        *,
        existing_row: sqlite3.Row | None,
    ) -> int:
        evidence_count = len(aggregate.history_ids)
        enabled = bool(existing_row["enabled"]) if existing_row is not None else True
        created_at = (
            str(existing_row["created_at"])
            if existing_row is not None
            else aggregate.last_seen_at or _utc_timestamp()
        )
        confidence = self._resolve_confidence(aggregate, evidence_count)
        updated_at = _utc_timestamp()
        retrieval_text = _build_retrieval_text(aggregate.summary, aggregate.support_texts)

        conn.execute(
            """
            INSERT INTO memories (
                normalized_key,
                kind,
                summary,
                retrieval_text,
                confidence,
                enabled,
                evidence_count,
                created_at,
                updated_at,
                last_seen_at,
                app_name,
                url_host,
                domain_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(normalized_key) DO UPDATE SET
                kind = excluded.kind,
                summary = excluded.summary,
                retrieval_text = excluded.retrieval_text,
                confidence = excluded.confidence,
                enabled = excluded.enabled,
                evidence_count = excluded.evidence_count,
                updated_at = excluded.updated_at,
                last_seen_at = excluded.last_seen_at,
                app_name = excluded.app_name,
                url_host = excluded.url_host,
                domain_id = excluded.domain_id
            """,
            (
                aggregate.normalized_key,
                aggregate.kind,
                aggregate.summary,
                retrieval_text,
                confidence,
                1 if enabled else 0,
                evidence_count,
                created_at,
                updated_at,
                aggregate.last_seen_at or updated_at,
                aggregate.app_name,
                aggregate.url_host,
                aggregate.domain_id,
            ),
        )
        memory_row = conn.execute(
            "SELECT id FROM memories WHERE normalized_key = ?",
            (aggregate.normalized_key,),
        ).fetchone()
        if memory_row is None:
            raise RuntimeError(f"Memory row could not be loaded for key {aggregate.normalized_key}.")
        return int(memory_row["id"])

    def _sync_memory_evidence(
        self,
        conn: sqlite3.Connection,
        memory_id: int,
        history_ids: Iterable[int],
    ) -> None:
        updated_at = _utc_timestamp()
        conn.execute("DELETE FROM memory_evidence WHERE memory_id = ?", (memory_id,))
        for history_id in sorted(set(int(value) for value in history_ids)):
            conn.execute(
                """
                INSERT INTO memory_evidence (
                    memory_id,
                    history_item_id,
                    created_at
                ) VALUES (?, ?, ?)
                """,
                (memory_id, history_id, updated_at),
            )

    def _sync_memory_fts(self, conn: sqlite3.Connection, *, memory_id: int, retrieval_text: str) -> None:
        conn.execute("DELETE FROM memory_fts WHERE memory_id = ?", (memory_id,))
        cleaned = _normalize_spaces(retrieval_text)
        if cleaned:
            conn.execute(
                "INSERT INTO memory_fts (memory_id, retrieval_text) VALUES (?, ?)",
                (memory_id, cleaned),
            )

    def _delete_memory_row(self, conn: sqlite3.Connection, memory_id: int) -> None:
        conn.execute("DELETE FROM memory_fts WHERE memory_id = ?", (memory_id,))
        conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))

    def _query_fts_scores(self, transcript: str, *, limit: int) -> dict[int, float]:
        query = _build_fts_query(transcript)
        if not query:
            return {}

        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                """
                SELECT memory_id, bm25(memory_fts) AS rank
                FROM memory_fts
                WHERE memory_fts MATCH ?
                LIMIT ?
                """,
                (query, max(1, int(limit))),
            ).fetchall()

        try:
            rows = self._run_read_with_lock_retries(_read)
        except RuntimeError:
            raise
        except Exception as exc:  # pragma: no cover - defensive fallback
            logger.warning("Local memory FTS lookup failed: %s", exc)
            return {}

        scores: dict[int, float] = {}
        for index, row in enumerate(rows):
            memory_id = int(row["memory_id"])
            scores[memory_id] = max(scores.get(memory_id, 0.0), max(1.0, 6.0 - float(index)))
        return scores

    def _read_retrieval_texts(self, memory_ids: Iterable[int]) -> dict[int, str]:
        ids = sorted({int(value) for value in memory_ids})
        if not ids:
            return {}

        def _read(conn: sqlite3.Connection) -> list[sqlite3.Row]:
            return conn.execute(
                """
                SELECT id, retrieval_text
                FROM memories
                WHERE id IN ({})
                """.format(", ".join(["?"] * len(ids))),
                tuple(ids),
            ).fetchall()

        rows = self._run_read_with_lock_retries(_read)
        return {
            int(row["id"]): str(row["retrieval_text"] or "")
            for row in rows
        }

    def _find_memory(self, memory_id: int) -> MemoryRecord:
        records = self._run_read_with_lock_retries(
            lambda conn: self._read_memories(
                conn,
                limit=500,
                where_clause="WHERE m.id = ?",
                params=(memory_id,),
            )
        )
        if not records:
            raise ValueError("Requested memory was not found.")
        return records[0]

    def _initialize(self) -> None:
        try:
            self._initialize_or_upgrade()
        except Exception as exc:
            logger.warning("Local memory initialization failed, rebuilding: %s", exc)
            self._rebuild_database()

    def _initialize_or_upgrade(self) -> None:
        if self.path.exists():
            try:
                with self._connect() as conn:
                    version_row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
                    current_version = str(version_row["value"]) if version_row else None
                    if current_version == SCHEMA_VERSION:
                        return
            except Exception as exc:
                logger.warning("Failed to inspect local memory database, rebuilding: %s", exc)
        self._rebuild_database()

    def _rebuild_database(self) -> None:
        if self.path.exists():
            backup_path = self.path.with_name(f"{self.path.name}.bak-{int(time.time())}")
            try:
                shutil.move(self.path, backup_path)
            except Exception as exc:
                logger.warning("Failed to back up old local memory database %s: %s", self.path, exc)

        with self._connect() as conn:
            self._create_schema(conn)
            conn.commit()

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
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                normalized_key TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                summary TEXT NOT NULL,
                retrieval_text TEXT NOT NULL DEFAULT '',
                confidence REAL NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                evidence_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                app_name TEXT,
                url_host TEXT,
                domain_id TEXT
            );
            CREATE TABLE IF NOT EXISTS memory_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_id INTEGER NOT NULL,
                history_item_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(memory_id, history_item_id),
                FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS memory_observations (
                normalized_key TEXT NOT NULL,
                history_item_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                summary TEXT NOT NULL,
                confidence REAL NOT NULL,
                explicit INTEGER NOT NULL DEFAULT 0,
                min_occurrences INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                app_name TEXT,
                url_host TEXT,
                domain_id TEXT,
                support_text TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (normalized_key, history_item_id)
            );
            CREATE TABLE IF NOT EXISTS memory_tombstones (
                normalized_key TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
            USING fts5(memory_id UNINDEXED, retrieval_text)
            """
        )
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
            (SCHEMA_VERSION,),
        )
        safe_chmod(self.path, 0o600)

    def _read_memories(
        self,
        conn: sqlite3.Connection,
        *,
        limit: int,
        where_clause: str = "",
        params: tuple[Any, ...] = (),
    ) -> list[MemoryRecord]:
        rows = conn.execute(
            f"""
            SELECT
                m.*,
                COALESCE(
                    GROUP_CONCAT(me.history_item_id, ','),
                    ''
                ) AS source_history_ids
            FROM memories m
            LEFT JOIN memory_evidence me ON me.memory_id = m.id
            {where_clause}
            GROUP BY m.id
            ORDER BY m.last_seen_at DESC, m.id DESC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
        return [self._row_to_memory(row) for row in rows]

    def _row_to_memory(self, row: sqlite3.Row) -> MemoryRecord:
        history_ids = [
            int(segment)
            for segment in str(row["source_history_ids"] or "").split(",")
            if str(segment).strip()
        ]
        history_ids.sort()
        return MemoryRecord(
            id=int(row["id"]),
            kind=str(row["kind"]),
            summary=str(row["summary"]),
            confidence=float(row["confidence"]),
            enabled=bool(row["enabled"]),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            last_seen_at=str(row["last_seen_at"]),
            evidence_count=int(row["evidence_count"]),
            source_history_ids=history_ids,
            app_name=row["app_name"],
            url_host=row["url_host"],
            domain_id=row["domain_id"],
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
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt >= len(LOCK_RETRY_DELAYS):
                    raise RuntimeError("Local memory is temporarily busy. Try again.") from exc
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
                    raise RuntimeError("Local memory is temporarily busy. Try again.") from exc
                time.sleep(LOCK_RETRY_DELAYS[attempt])
                attempt += 1
