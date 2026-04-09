from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, TypeVar

import yaml

from utils.logger import get_logger
from utils.paths import get_app_home, resolve_runtime_path, safe_chmod

from .models import (
    DomainControls,
    DomainExportPayload,
    DomainId,
    DomainPack,
    DomainPackContent,
    DomainPackDetail,
    DomainPackOverlay,
    DomainPackSummary,
    DomainOverlayContent,
    ExampleEntry,
    GlossaryEntry,
    TemplateEntry,
)


logger = get_logger()
SCHEMA_VERSION = "2"
BUNDLED_REGISTRY_PATH = Path(__file__).resolve().parent / "bundled_registry.yaml"
LOCK_RETRY_DELAYS = (0.05, 0.1, 0.2)
ResultT = TypeVar("ResultT")


def get_bundled_registry_path() -> Path:
    return resolve_runtime_path("domains", "bundled_registry.yaml")


@dataclass(frozen=True)
class DomainPromptContext:
    block: str
    template_id: Optional[str]
    example_id: Optional[str]
    glossary_hits: List[str]


class DomainMemoryStore:
    def __init__(self, path: Optional[Path] = None):
        self.path = path or (get_app_home() / "domain_memory.sqlite3")
        self._lock = threading.RLock()
        self._runtime_cache: Dict[str, DomainPack] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        safe_chmod(self.path.parent, 0o700)
        self._initialize()

    def list_packs(self) -> List[DomainPackSummary]:
        with self._lock:
            try:
                with self._connect() as conn:
                    rows = conn.execute(
                        """
                        SELECT id, label, description, documentation_only, overlay_present, last_imported_at
                        FROM packs
                        ORDER BY id
                        """
                    ).fetchall()
                summaries: List[DomainPackSummary] = []
                for row in rows:
                    runtime_pack = self.get_runtime_pack(str(row["id"]))
                    summaries.append(DomainPackSummary(
                        id=str(row["id"]),
                        label=str(row["label"]),
                        description=str(row["description"]),
                        documentation_only=bool(row["documentation_only"]),
                        bundled=True,
                        overlay_present=bool(row["overlay_present"]),
                        last_imported_at=row["last_imported_at"],
                        glossary_count=len(runtime_pack.glossary) if runtime_pack else 0,
                        template_count=len(runtime_pack.templates) if runtime_pack else 0,
                        example_count=len(runtime_pack.examples) if runtime_pack else 0,
                        controls=runtime_pack.controls if runtime_pack else DomainControls(),
                    ))
                return summaries
            except Exception as exc:
                logger.warning("Failed to list domain packs: %s", exc)
                return []

    def list_pack_details(self) -> List[DomainPackDetail]:
        details: List[DomainPackDetail] = []
        for summary in self.list_packs():
            runtime_pack = self.get_runtime_pack(summary.id)
            if runtime_pack is None:
                continue
            overlay_pack = self.get_overlay_pack(summary.id)
            details.append(DomainPackDetail(
                id=runtime_pack.id,
                label=runtime_pack.label,
                description=runtime_pack.description,
                documentation_only=runtime_pack.documentation_only,
                default_intent=runtime_pack.default_intent,
                bundled=summary.bundled,
                overlay_present=summary.overlay_present,
                last_imported_at=summary.last_imported_at,
                effective=self._pack_to_content(runtime_pack),
                overlay=self._pack_overlay_to_content(overlay_pack) if overlay_pack is not None else DomainOverlayContent(),
            ))
        return details

    def get_runtime_pack(self, domain_id: str) -> Optional[DomainPack]:
        with self._lock:
            cached = self._runtime_cache.get(domain_id)
            if cached is not None:
                return cached

            try:
                with self._connect() as conn:
                    metadata = conn.execute(
                        """
                        SELECT id, label, description, documentation_only, default_intent
                        FROM packs
                        WHERE id = ?
                        """,
                        (domain_id,),
                    ).fetchone()
                    if metadata is None:
                        return None

                    glossary = self._merge_glossary_rows(conn, domain_id)
                    templates = self._merge_templates(conn, domain_id)
                    examples = self._merge_examples(conn, domain_id)
                    styles = self._merge_styles(conn, domain_id)
                    controls = self._merge_controls(conn, domain_id)
            except Exception as exc:
                logger.warning("Failed to load runtime domain pack %s: %s", domain_id, exc)
                return None

            pack = DomainPack(
                id=str(metadata["id"]),
                label=str(metadata["label"]),
                description=str(metadata["description"]),
                documentation_only=bool(metadata["documentation_only"]),
                default_intent=str(metadata["default_intent"]),
                glossary=glossary,
                templates=templates,
                examples=examples,
                styles=styles,
                controls=controls,
            )
            self._runtime_cache[domain_id] = pack
            return pack

    def import_overlay(self, domain_id: DomainId, overlay: DomainPackOverlay) -> DomainPackSummary:
        if overlay.id != domain_id:
            raise ValueError("Imported domain pack id does not match the selected domain.")

        def _write(conn: sqlite3.Connection) -> None:
            self._write_overlay_unlocked(conn, domain_id, overlay)

        with self._lock:
            self._run_with_lock_retries(_write)
            self._runtime_cache.pop(domain_id, None)
            summary = next((pack for pack in self.list_packs() if pack.id == domain_id), None)
            if summary is None:
                raise RuntimeError("Imported domain overlay but could not reload pack metadata.")
            return summary

    def export_overlay(self, domain_id: DomainId) -> DomainExportPayload:
        with self._lock:
            try:
                def _read(conn: sqlite3.Connection) -> DomainExportPayload:
                    metadata = conn.execute(
                        """
                        SELECT id, label, description, documentation_only, default_intent
                        FROM packs
                        WHERE id = ?
                        """,
                        (domain_id,),
                    ).fetchone()
                    if metadata is None:
                        raise ValueError(f"Unknown domain {domain_id!r}.")

                    overlay = self._read_overlay_pack(conn, domain_id, metadata)
                    return DomainExportPayload(domain_id=domain_id, overlay=overlay)

                return self._run_read_with_lock_retries(_read)
            except sqlite3.OperationalError as exc:
                raise RuntimeError("Failed to export the selected domain overlay.") from exc

    def get_overlay_pack(self, domain_id: DomainId) -> Optional[DomainPackOverlay]:
        with self._lock:
            try:
                def _read(conn: sqlite3.Connection) -> Optional[DomainPackOverlay]:
                    metadata = conn.execute(
                        """
                        SELECT id, label, description, documentation_only, default_intent, overlay_present
                        FROM packs
                        WHERE id = ?
                        """,
                        (domain_id,),
                    ).fetchone()
                    if metadata is None or not metadata["overlay_present"]:
                        return None
                    return self._read_overlay_pack(conn, domain_id, metadata)

                return self._run_read_with_lock_retries(_read)
            except sqlite3.OperationalError as exc:
                raise RuntimeError("Failed to load the selected domain overlay.") from exc

    def _initialize(self) -> None:
        try:
            self._initialize_or_upgrade()
        except Exception as exc:
            logger.warning("Domain database initialization failed, rebuilding from seeds: %s", exc)
            self._rebuild_database()

    def _initialize_or_upgrade(self) -> None:
        existing_overlays: Dict[str, DomainPackOverlay] = {}
        if self.path.exists():
            try:
                with self._connect() as conn:
                    version_row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
                    current_version = str(version_row["value"]) if version_row else None
                    if current_version == SCHEMA_VERSION:
                        return
                    existing_overlays = self._export_all_overlays_unlocked(conn)
            except Exception as exc:
                logger.warning("Failed to inspect existing domain database, rebuilding: %s", exc)

        self._rebuild_database(existing_overlays)

    def _rebuild_database(self, overlays: Optional[Dict[str, DomainPackOverlay]] = None) -> None:
        overlays = overlays or {}
        if self.path.exists():
            backup_path = self.path.with_name(f"{self.path.name}.bak-{int(time.time())}")
            try:
                shutil.move(self.path, backup_path)
            except Exception as exc:
                logger.warning("Failed to back up old domain database %s: %s", self.path, exc)

        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._create_schema(conn)
            self._seed_bundled_packs(conn)
            for domain_id, overlay in overlays.items():
                if overlay.id not in {"shipping", "medical"}:
                    continue
                self._write_overlay_unlocked(conn, overlay.id, overlay)
            conn.commit()
        self._runtime_cache.clear()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=0.25, isolation_level=None)
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
            CREATE TABLE IF NOT EXISTS packs (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                description TEXT NOT NULL,
                documentation_only INTEGER NOT NULL DEFAULT 0,
                default_intent TEXT NOT NULL,
                overlay_present INTEGER NOT NULL DEFAULT 0,
                last_imported_at TEXT
            );
            CREATE TABLE IF NOT EXISTS glossary_terms (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                term TEXT NOT NULL,
                aliases_json TEXT NOT NULL,
                kind TEXT,
                priority INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (domain_id, source, term)
            );
            CREATE TABLE IF NOT EXISTS templates (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                id TEXT NOT NULL,
                label TEXT NOT NULL,
                intent TEXT NOT NULL,
                body TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (domain_id, source, id)
            );
            CREATE TABLE IF NOT EXISTS examples (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                id TEXT NOT NULL,
                label TEXT NOT NULL,
                intent TEXT NOT NULL,
                output TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (domain_id, source, id)
            );
            CREATE TABLE IF NOT EXISTS styles (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (domain_id, source, key)
            );
            CREATE TABLE IF NOT EXISTS controls (
                domain_id TEXT NOT NULL,
                source TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (domain_id, source, key)
            );
            """,
        )
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", (SCHEMA_VERSION,))
        safe_chmod(self.path, 0o600)

    def _seed_bundled_packs(self, conn: sqlite3.Connection) -> None:
        bundled_registry_path = get_bundled_registry_path()
        payload = yaml.safe_load(bundled_registry_path.read_text(encoding="utf-8")) or {}
        raw_packs = payload.get("packs")
        if not isinstance(raw_packs, list):
            raise ValueError(f"{bundled_registry_path} must define a top-level 'packs' list.")

        for raw_pack in raw_packs:
            seed_pack = DomainPack.model_validate(raw_pack)
            conn.execute(
                """
                INSERT OR REPLACE INTO packs (id, label, description, documentation_only, default_intent, overlay_present, last_imported_at)
                VALUES (?, ?, ?, ?, ?, COALESCE((SELECT overlay_present FROM packs WHERE id = ?), 0), COALESCE((SELECT last_imported_at FROM packs WHERE id = ?), NULL))
                """,
                (
                    seed_pack.id,
                    seed_pack.label,
                    seed_pack.description,
                    1 if seed_pack.documentation_only else 0,
                    seed_pack.default_intent,
                    seed_pack.id,
                    seed_pack.id,
                ),
            )
            conn.execute("DELETE FROM glossary_terms WHERE domain_id = ? AND source = 'seed'", (seed_pack.id,))
            conn.execute("DELETE FROM templates WHERE domain_id = ? AND source = 'seed'", (seed_pack.id,))
            conn.execute("DELETE FROM examples WHERE domain_id = ? AND source = 'seed'", (seed_pack.id,))
            conn.execute("DELETE FROM styles WHERE domain_id = ? AND source = 'seed'", (seed_pack.id,))
            conn.execute("DELETE FROM controls WHERE domain_id = ? AND source = 'seed'", (seed_pack.id,))

            for entry in seed_pack.glossary:
                conn.execute(
                    """
                    INSERT INTO glossary_terms (domain_id, source, term, aliases_json, kind, priority)
                    VALUES (?, 'seed', ?, ?, ?, ?)
                    """,
                    (seed_pack.id, entry.term, json.dumps(entry.aliases), entry.kind, entry.priority),
                )

            for template in seed_pack.templates:
                conn.execute(
                    """
                    INSERT INTO templates (domain_id, source, id, label, intent, body, priority)
                    VALUES (?, 'seed', ?, ?, ?, ?, ?)
                    """,
                    (seed_pack.id, template.id, template.label, template.intent, template.body, template.priority),
                )

            for example in seed_pack.examples:
                conn.execute(
                    """
                    INSERT INTO examples (domain_id, source, id, label, intent, output, priority)
                    VALUES (?, 'seed', ?, ?, ?, ?, ?)
                    """,
                    (seed_pack.id, example.id, example.label, example.intent, example.output, example.priority),
                )

            for key, value in seed_pack.styles.items():
                conn.execute(
                    """
                    INSERT INTO styles (domain_id, source, key, value)
                    VALUES (?, 'seed', ?, ?)
                    """,
                    (seed_pack.id, key, value),
                )

            for key, value in seed_pack.controls.model_dump(mode="json").items():
                conn.execute(
                    """
                    INSERT INTO controls (domain_id, source, key, value)
                    VALUES (?, 'seed', ?, ?)
                    """,
                    (seed_pack.id, key, json.dumps(value) if isinstance(value, bool) else str(value)),
                )

    def _merge_glossary_rows(self, conn: sqlite3.Connection, domain_id: str):
        rows = conn.execute(
            """
            SELECT source, term, aliases_json, kind, priority
            FROM glossary_terms
            WHERE domain_id = ?
            ORDER BY CASE source WHEN 'overlay' THEN 0 ELSE 1 END, priority DESC, term ASC
            """,
            (domain_id,),
        ).fetchall()
        merged: Dict[str, dict] = {}
        for row in rows:
            key = str(row["term"]).lower()
            if key in merged:
                continue
            merged[key] = {
                "term": str(row["term"]),
                "aliases": json.loads(row["aliases_json"] or "[]"),
                "kind": row["kind"],
                "priority": int(row["priority"] or 0),
            }
        return [GlossaryEntry.model_validate(item) for item in merged.values()]

    def _merge_templates(self, conn: sqlite3.Connection, domain_id: str):
        rows = conn.execute(
            """
            SELECT source, id, label, intent, body, priority
            FROM templates
            WHERE domain_id = ?
            ORDER BY CASE source WHEN 'overlay' THEN 0 ELSE 1 END, priority DESC, id ASC
            """,
            (domain_id,),
        ).fetchall()
        merged: Dict[str, dict] = {}
        for row in rows:
            key = str(row["id"])
            if key in merged:
                continue
            merged[key] = {
                "id": key,
                "label": str(row["label"]),
                "intent": str(row["intent"]),
                "body": str(row["body"]),
                "priority": int(row["priority"] or 0),
            }
        return [TemplateEntry.model_validate(item) for item in merged.values()]

    def _merge_examples(self, conn: sqlite3.Connection, domain_id: str):
        rows = conn.execute(
            """
            SELECT source, id, label, intent, output, priority
            FROM examples
            WHERE domain_id = ?
            ORDER BY CASE source WHEN 'overlay' THEN 0 ELSE 1 END, priority DESC, id ASC
            """,
            (domain_id,),
        ).fetchall()
        merged: Dict[str, dict] = {}
        for row in rows:
            key = str(row["id"])
            if key in merged:
                continue
            merged[key] = {
                "id": key,
                "label": str(row["label"]),
                "intent": str(row["intent"]),
                "output": str(row["output"]),
                "priority": int(row["priority"] or 0),
            }
        return [ExampleEntry.model_validate(item) for item in merged.values()]

    def _merge_styles(self, conn: sqlite3.Connection, domain_id: str) -> Dict[str, str]:
        rows = conn.execute(
            """
            SELECT source, key, value
            FROM styles
            WHERE domain_id = ?
            ORDER BY CASE source WHEN 'overlay' THEN 0 ELSE 1 END, key ASC
            """,
            (domain_id,),
        ).fetchall()
        merged: Dict[str, str] = {}
        for row in rows:
            key = str(row["key"])
            if key in merged:
                continue
            merged[key] = str(row["value"])
        return merged

    def _merge_controls(self, conn: sqlite3.Connection, domain_id: str) -> DomainControls:
        rows = conn.execute(
            """
            SELECT source, key, value
            FROM controls
            WHERE domain_id = ?
            ORDER BY CASE source WHEN 'overlay' THEN 0 ELSE 1 END, key ASC
            """,
            (domain_id,),
        ).fetchall()
        merged: Dict[str, object] = {}
        for row in rows:
            key = str(row["key"])
            if key in merged:
                continue
            raw_value = row["value"]
            if key in {"suppress_external_text", "minimize_context_capture"}:
                merged[key] = str(raw_value).lower() in {"1", "true", "yes"}
            else:
                merged[key] = str(raw_value)
        return DomainControls.model_validate(merged)

    def _read_overlay_pack(self, conn: sqlite3.Connection, domain_id: DomainId, metadata: sqlite3.Row) -> DomainPackOverlay:
        glossary = [
            {
                "term": str(row["term"]),
                "aliases": json.loads(row["aliases_json"] or "[]"),
                "kind": row["kind"],
                "priority": int(row["priority"] or 0),
            }
            for row in conn.execute(
                """
                SELECT term, aliases_json, kind, priority
                FROM glossary_terms
                WHERE domain_id = ? AND source = 'overlay'
                ORDER BY priority DESC, term ASC
                """,
                (domain_id,),
            ).fetchall()
        ]
        templates = [
            {
                "id": str(row["id"]),
                "label": str(row["label"]),
                "intent": str(row["intent"]),
                "body": str(row["body"]),
                "priority": int(row["priority"] or 0),
            }
            for row in conn.execute(
                """
                SELECT id, label, intent, body, priority
                FROM templates
                WHERE domain_id = ? AND source = 'overlay'
                ORDER BY priority DESC, id ASC
                """,
                (domain_id,),
            ).fetchall()
        ]
        examples = [
            {
                "id": str(row["id"]),
                "label": str(row["label"]),
                "intent": str(row["intent"]),
                "output": str(row["output"]),
                "priority": int(row["priority"] or 0),
            }
            for row in conn.execute(
                """
                SELECT id, label, intent, output, priority
                FROM examples
                WHERE domain_id = ? AND source = 'overlay'
                ORDER BY priority DESC, id ASC
                """,
                (domain_id,),
            ).fetchall()
        ]
        styles = {
            str(row["key"]): str(row["value"])
            for row in conn.execute(
                """
                SELECT key, value
                FROM styles
                WHERE domain_id = ? AND source = 'overlay'
                ORDER BY key ASC
                """,
                (domain_id,),
            ).fetchall()
        }
        controls = {
            str(row["key"]): (
                str(row["value"]).lower() in {"1", "true", "yes"}
                if str(row["key"]) in {"suppress_external_text", "minimize_context_capture"}
                else str(row["value"])
            )
            for row in self._select_overlay_rows(
                conn,
                "controls",
                """
                SELECT key, value
                FROM controls
                WHERE domain_id = ? AND source = 'overlay'
                ORDER BY key ASC
                """,
                (domain_id,),
            )
        }
        return DomainPackOverlay(
            id=domain_id,
            label=str(metadata["label"]),
            description=str(metadata["description"]),
            documentation_only=bool(metadata["documentation_only"]),
            default_intent=str(metadata["default_intent"]),
            glossary=glossary,
            templates=templates,
            examples=examples,
            styles=styles,
            controls=controls,
        )

    def _select_overlay_rows(
        self,
        conn: sqlite3.Connection,
        table_name: str,
        query: str,
        params: tuple[object, ...],
    ) -> List[sqlite3.Row]:
        if not self._table_exists(conn, table_name):
            return []
        return conn.execute(query, params).fetchall()

    def _table_exists(self, conn: sqlite3.Connection, table_name: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        return row is not None

    def _pack_to_content(self, pack: DomainPack) -> DomainPackContent:
        return DomainPackContent(
            glossary=pack.glossary,
            templates=pack.templates,
            examples=pack.examples,
            styles=pack.styles,
            controls=pack.controls,
        )

    def _pack_overlay_to_content(self, pack: DomainPackOverlay) -> DomainOverlayContent:
        return DomainOverlayContent(
            glossary=pack.glossary,
            templates=pack.templates,
            examples=pack.examples,
            styles=pack.styles,
            controls=pack.controls,
        )

    def _export_all_overlays_unlocked(self, conn: sqlite3.Connection) -> Dict[str, DomainPackOverlay]:
        overlays: Dict[str, DomainPackOverlay] = {}
        metadata_rows = conn.execute(
            """
            SELECT id, label, description, documentation_only, default_intent, overlay_present
            FROM packs
            """
        ).fetchall()
        for row in metadata_rows:
            domain_id = str(row["id"])
            if not row["overlay_present"]:
                continue
            overlays[domain_id] = self._read_overlay_pack(conn, domain_id, row)
        return overlays

    def _run_with_lock_retries(self, callback) -> None:
        attempt = 0
        while True:
            try:
                with self._connect() as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    callback(conn)
                    conn.commit()
                    safe_chmod(self.path, 0o600)
                    return
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt >= len(LOCK_RETRY_DELAYS):
                    raise RuntimeError("Domain memory is temporarily busy. Try again.") from exc
                time.sleep(LOCK_RETRY_DELAYS[attempt])
                attempt += 1

    def _run_read_with_lock_retries(self, callback: Callable[[sqlite3.Connection], ResultT]) -> ResultT:
        attempt = 0
        while True:
            try:
                with self._connect() as conn:
                    return callback(conn)
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt >= len(LOCK_RETRY_DELAYS):
                    raise RuntimeError("Domain memory is temporarily busy. Try again.") from exc
                time.sleep(LOCK_RETRY_DELAYS[attempt])
                attempt += 1

    def _write_overlay_unlocked(self, conn: sqlite3.Connection, domain_id: DomainId, overlay: DomainPackOverlay) -> None:
        overlay_present = bool(
            overlay.glossary
            or overlay.templates
            or overlay.examples
            or overlay.styles
            or overlay.controls
        )
        imported_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) if overlay_present else None

        conn.execute("DELETE FROM glossary_terms WHERE domain_id = ? AND source = 'overlay'", (domain_id,))
        conn.execute("DELETE FROM templates WHERE domain_id = ? AND source = 'overlay'", (domain_id,))
        conn.execute("DELETE FROM examples WHERE domain_id = ? AND source = 'overlay'", (domain_id,))
        conn.execute("DELETE FROM styles WHERE domain_id = ? AND source = 'overlay'", (domain_id,))
        conn.execute("DELETE FROM controls WHERE domain_id = ? AND source = 'overlay'", (domain_id,))

        for entry in overlay.glossary:
            conn.execute(
                """
                INSERT INTO glossary_terms (domain_id, source, term, aliases_json, kind, priority)
                VALUES (?, 'overlay', ?, ?, ?, ?)
                """,
                (domain_id, entry.term, json.dumps(entry.aliases), entry.kind, entry.priority),
            )

        for template in overlay.templates:
            conn.execute(
                """
                INSERT INTO templates (domain_id, source, id, label, intent, body, priority)
                VALUES (?, 'overlay', ?, ?, ?, ?, ?)
                """,
                (domain_id, template.id, template.label, template.intent, template.body, template.priority),
            )

        for example in overlay.examples:
            conn.execute(
                """
                INSERT INTO examples (domain_id, source, id, label, intent, output, priority)
                VALUES (?, 'overlay', ?, ?, ?, ?, ?)
                """,
                (domain_id, example.id, example.label, example.intent, example.output, example.priority),
            )

        for key, value in overlay.styles.items():
            conn.execute(
                """
                INSERT INTO styles (domain_id, source, key, value)
                VALUES (?, 'overlay', ?, ?)
                """,
                (domain_id, key, value),
            )

        for key, value in overlay.controls.items():
            conn.execute(
                """
                INSERT INTO controls (domain_id, source, key, value)
                VALUES (?, 'overlay', ?, ?)
                """,
                (domain_id, key, json.dumps(value) if isinstance(value, bool) else str(value)),
            )

        conn.execute(
            """
            UPDATE packs
            SET overlay_present = ?, last_imported_at = ?
            WHERE id = ?
            """,
            (1 if overlay_present else 0, imported_at, domain_id),
        )
