import { DISPLAY_NAME } from '../shared/branding'

export const SEMANTIC_MEMORY_REQUIREMENTS = `pysqlite3==0.6.0
sqlite-vec==0.1.9
sentence-transformers==5.3.0
`

export const SEMANTIC_MEMORY_HELPER_TEMPLATE = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import traceback
from pathlib import Path

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
MODEL_DIMENSIONS = 384


class SemanticRuntimeError(RuntimeError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def resolve_sqlite_module():
    try:
        import pysqlite3 as sqlite3  # type: ignore

        return sqlite3, "pysqlite3"
    except Exception:
        import sqlite3  # type: ignore

        return sqlite3, "sqlite3"


def encode_embedding(values):
    return struct.pack(f"{len(values)}f", *[float(value) for value in values])


def build_runtime_info(runtime_root: Path):
    sqlite3, sqlite_module = resolve_sqlite_module()
    return {
        "runtime_root": str(runtime_root),
        "python_version": ".".join(str(part) for part in sys.version_info[:3]),
        "sqlite_module": sqlite_module,
        "sqlite_version": getattr(sqlite3, "sqlite_version", None),
        "vec_version": None,
        "model": MODEL_NAME,
        "model_cached": (runtime_root / "model-cache").exists() and any((runtime_root / "model-cache").iterdir()),
    }


def ensure_sqlite_vec_loaded(conn):
    try:
        import sqlite_vec
    except Exception as exc:  # pragma: no cover - imported only inside optional runtime
        raise SemanticRuntimeError("runtime_corrupt", f"sqlite-vec is missing from the semantic runtime: {exc}") from exc

    if not hasattr(conn, "enable_load_extension"):
        raise SemanticRuntimeError(
            "sqlite_extensions_unsupported",
            "The SQLite module in the semantic runtime does not support loading extensions.",
        )

    try:
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
    except Exception as exc:
        raise SemanticRuntimeError(
            "sqlite_vec_load_failed",
            f"${DISPLAY_NAME} could not activate sqlite-vec inside the semantic runtime: {exc}",
        ) from exc
    finally:
        try:
            conn.enable_load_extension(False)
        except Exception:
            pass


def run_doctor(runtime_root: Path):
    sqlite3, sqlite_module = resolve_sqlite_module()
    info = build_runtime_info(runtime_root)

    try:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        ensure_sqlite_vec_loaded(conn)
        row = conn.execute("SELECT vec_version() AS version").fetchone()
        info["vec_version"] = row["version"] if row else None

        conn.execute(
            """
            CREATE VIRTUAL TABLE temp.semantic_vectors USING vec0(
                id INTEGER PRIMARY KEY,
                embedding float[4]
            )
            """
        )
        query_embedding = encode_embedding([0.0, 0.0, 0.0, 0.0])
        conn.execute(
            "INSERT INTO temp.semantic_vectors(id, embedding) VALUES (?, ?)",
            (1, query_embedding),
        )
        conn.execute(
            """
            SELECT id, distance
            FROM temp.semantic_vectors
            WHERE embedding MATCH ? AND k = 1
            ORDER BY distance
            """,
            (query_embedding,),
        ).fetchall()
        conn.close()
    except SemanticRuntimeError:
        raise
    except Exception as exc:
        raise SemanticRuntimeError(
            "sqlite_vec_load_failed",
            f"${DISPLAY_NAME} could not complete the sqlite-vec health check: {exc}",
        ) from exc

    return {
        "ok": True,
        **info,
        "sqlite_module": sqlite_module,
    }


class SemanticRuntime:
    def __init__(self, runtime_root: Path):
        self.runtime_root = runtime_root
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        self.cache_dir = self.runtime_root / "model-cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.runtime_root / "semantic_index.sqlite3"
        self.sqlite3, self.sqlite_module = resolve_sqlite_module()
        self.conn = self.sqlite3.connect(self.db_path)
        self.conn.row_factory = self.sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        ensure_sqlite_vec_loaded(self.conn)
        self._create_schema()
        self._embedder = None

    def _create_schema(self):
        self.conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS memory_items (
                id INTEGER PRIMARY KEY,
                text_hash TEXT NOT NULL,
                retrieval_text TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
                id INTEGER PRIMARY KEY,
                embedding float[{MODEL_DIMENSIONS}]
            );
            """
        )
        self.conn.commit()

    def _get_embedder(self):
        if self._embedder is not None:
            return self._embedder
        try:
            from sentence_transformers import SentenceTransformer
        except Exception as exc:  # pragma: no cover - optional runtime dependency
            raise SemanticRuntimeError(
                "runtime_corrupt",
                f"sentence-transformers is missing from the semantic runtime: {exc}",
            ) from exc
        self._embedder = SentenceTransformer(MODEL_NAME, cache_folder=str(self.cache_dir))
        return self._embedder

    def prepare(self):
        try:
            self._get_embedder().encode(["semantic memory warmup"], normalize_embeddings=True)
        except SemanticRuntimeError:
            raise
        except Exception as exc:
            raise SemanticRuntimeError(
                "model_prepare_failed",
                f"${DISPLAY_NAME} could not prepare the semantic embedding model: {exc}",
            ) from exc
        return {
            **run_doctor(self.runtime_root),
            "event": "prepared",
            "cache_dir": str(self.cache_dir),
        }

    def sync(self, items):
        normalized = {}
        for item in items:
            try:
                item_id = int(item.get("id"))
            except Exception:
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            normalized[item_id] = text

        existing = {
            int(row["id"]): str(row["text_hash"])
            for row in self.conn.execute("SELECT id, text_hash FROM memory_items").fetchall()
        }

        stale_ids = sorted(set(existing) - set(normalized))
        if stale_ids:
            self.conn.executemany("DELETE FROM memory_items WHERE id = ?", [(item_id,) for item_id in stale_ids])
            self.conn.executemany("DELETE FROM memory_vectors WHERE id = ?", [(item_id,) for item_id in stale_ids])

        to_update = []
        for item_id, text in normalized.items():
            text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            if existing.get(item_id) != text_hash:
                to_update.append((item_id, text, text_hash))

        if to_update:
            try:
                embeddings = self._get_embedder().encode(
                    [text for _item_id, text, _hash in to_update],
                    normalize_embeddings=True,
                )
            except SemanticRuntimeError:
                raise
            except Exception as exc:
                raise SemanticRuntimeError(
                    "model_prepare_failed",
                    f"${DISPLAY_NAME} could not encode semantic memory embeddings: {exc}",
                ) from exc
            for (item_id, text, text_hash), embedding in zip(to_update, embeddings):
                packed = encode_embedding(embedding)
                self.conn.execute(
                    """
                    INSERT INTO memory_items (id, text_hash, retrieval_text, updated_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(id) DO UPDATE SET
                        text_hash = excluded.text_hash,
                        retrieval_text = excluded.retrieval_text,
                        updated_at = excluded.updated_at
                    """,
                    (item_id, text_hash, text),
                )
                self.conn.execute("DELETE FROM memory_vectors WHERE id = ?", (item_id,))
                self.conn.execute(
                    "INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)",
                    (item_id, packed),
                )

        self.conn.commit()

    def query(self, query_text: str, limit: int):
        normalized_query = str(query_text or "").strip()
        if not normalized_query:
            return []
        try:
            embedding = self._get_embedder().encode(normalized_query, normalize_embeddings=True)
        except SemanticRuntimeError:
            raise
        except Exception as exc:
            raise SemanticRuntimeError(
                "model_prepare_failed",
                f"${DISPLAY_NAME} could not encode the semantic query embedding: {exc}",
            ) from exc
        packed_query = encode_embedding(embedding)
        rows = self.conn.execute(
            """
            SELECT id, distance
            FROM memory_vectors
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance
            """,
            (packed_query, max(1, int(limit))),
        ).fetchall()
        results = []
        for row in rows:
            distance = float(row["distance"])
            similarity = max(0.0, min(1.0, 1.0 - ((distance * distance) / 2.0)))
            results.append({
                "id": int(row["id"]),
                "distance": distance,
                "score": round(similarity, 6),
            })
        return results


def respond(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def error_payload(exc: Exception, runtime_root: Path):
    if isinstance(exc, SemanticRuntimeError):
        return {
            "ok": False,
            **build_runtime_info(runtime_root),
            "error_code": exc.code,
            "detail": exc.detail,
        }
    return {
        "ok": False,
        **build_runtime_info(runtime_root),
        "error_code": "runtime_corrupt",
        "detail": str(exc) or "The semantic runtime failed unexpectedly.",
    }


def run_status(runtime_root: Path):
    doctor = run_doctor(runtime_root)
    respond({
        "ok": True,
        "event": "status",
        **doctor,
    })
    return 0


def run_prepare(runtime_root: Path):
    runtime = SemanticRuntime(runtime_root)
    payload = runtime.prepare()
    respond(payload)
    return 0


def run_server(runtime_root: Path):
    runtime = SemanticRuntime(runtime_root)
    runtime.prepare()
    respond({
        "ok": True,
        "event": "ready",
        **run_doctor(runtime_root),
    })
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
            command = str(payload.get("command") or "").strip()
            if command == "query":
                items = payload.get("items") if isinstance(payload.get("items"), list) else []
                runtime.sync(items)
                results = runtime.query(str(payload.get("query") or ""), int(payload.get("limit") or 5))
                respond({"ok": True, "results": results})
            elif command == "ping":
                respond({"ok": True, "pong": True})
            else:
                respond({"ok": False, "error_code": "runtime_corrupt", "error": f"Unsupported command: {command}"})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            payload = error_payload(exc, runtime_root)
            payload["error"] = payload["detail"]
            respond(payload)
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--doctor", action="store_true")
    args = parser.parse_args()

    runtime_root = Path(args.runtime_root).expanduser().resolve()

    try:
        if args.doctor:
            respond(run_doctor(runtime_root))
            return 0
        if args.status:
            return run_status(runtime_root)
        if args.prepare:
            return run_prepare(runtime_root)
        if args.serve:
            return run_server(runtime_root)

        respond({"ok": False, "error_code": "runtime_corrupt", "detail": "No command provided."})
        return 1
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        respond(error_payload(exc, runtime_root))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
`
