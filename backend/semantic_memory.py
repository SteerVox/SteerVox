from __future__ import annotations

import json
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from utils.logger import get_logger
from utils.paths import (
    ensure_directory,
    get_semantic_memory_helper_path,
    get_semantic_memory_install_log_path,
    get_semantic_memory_log_path,
    get_semantic_memory_runtime_dir,
    get_semantic_memory_runtime_python_path,
    get_semantic_memory_state_path,
)

logger = get_logger()
BOOT_TIMEOUT_SECONDS = 45.0
QUERY_TIMEOUT_SECONDS = 8.0
FAILURE_COOLDOWN_SECONDS = 30.0


@dataclass(frozen=True)
class SemanticMemoryItem:
    id: int
    retrieval_text: str


def _utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class SemanticMemoryClient:
    def __init__(
        self,
        *,
        runtime_dir: Path | None = None,
        python_path: Path | None = None,
        helper_path: Path | None = None,
        log_path: Path | None = None,
        install_log_path: Path | None = None,
        state_path: Path | None = None,
    ):
        self.runtime_dir = runtime_dir or get_semantic_memory_runtime_dir()
        self.python_path = python_path or get_semantic_memory_runtime_python_path()
        self.helper_path = helper_path or get_semantic_memory_helper_path()
        self.log_path = log_path or get_semantic_memory_log_path()
        self.install_log_path = install_log_path or get_semantic_memory_install_log_path()
        self.state_path = state_path or get_semantic_memory_state_path()
        self._lock = threading.RLock()
        self._process: subprocess.Popen[str] | None = None
        self._stderr_thread: threading.Thread | None = None
        self._failure_cooldown_until = 0.0

    def is_available(self) -> bool:
        return self.python_path.exists() and self.helper_path.exists()

    def query(
        self,
        *,
        query: str,
        items: Iterable[SemanticMemoryItem],
        limit: int,
    ) -> dict[int, float]:
        if not self.is_available():
            return {}
        if time.monotonic() < self._failure_cooldown_until:
            return {}

        normalized_query = str(query or "").strip()
        if not normalized_query:
            return {}

        payload_items = [
            {
                "id": int(item.id),
                "text": str(item.retrieval_text or "").strip(),
            }
            for item in items
            if str(item.retrieval_text or "").strip()
        ]
        if not payload_items:
            return {}

        try:
            response = self._request(
                {
                    "command": "query",
                    "query": normalized_query,
                    "limit": max(1, int(limit)),
                    "items": payload_items,
                },
                timeout=QUERY_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning("Semantic memory query failed. Falling back to lexical retrieval: %s", exc)
            self._record_failure(str(exc))
            self.close()
            return {}

        results: dict[int, float] = {}
        for row in response.get("results", []):
            try:
                memory_id = int(row.get("id"))
                score = float(row.get("score"))
            except (TypeError, ValueError):
                continue
            if score > 0:
                results[memory_id] = score
        return results

    def close(self) -> None:
        with self._lock:
            proc = self._process
            self._process = None
            if proc is None:
                return
            try:
                if proc.stdin:
                    proc.stdin.close()
            except OSError:
                pass
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    proc.kill()
            self._stderr_thread = None

    def _write_state(self, patch: dict[str, object]) -> None:
        ensure_directory(self.runtime_dir)
        ensure_directory(self.state_path.parent)

        existing: dict[str, object] = {}
        try:
            existing = json.loads(self.state_path.read_text(encoding="utf-8"))
            if not isinstance(existing, dict):
                existing = {}
        except Exception:
            existing = {}

        state = {
            **existing,
            "runtime_path": str(self.runtime_dir),
            "python_path": str(self.python_path),
            "log_path": str(self.log_path),
            "install_log_path": str(self.install_log_path),
            "last_checked_at": _utc_timestamp(),
            **patch,
        }
        self.state_path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")

    def _record_failure(self, detail: str, error_code: str = "runtime_corrupt") -> None:
        self._failure_cooldown_until = time.monotonic() + FAILURE_COOLDOWN_SECONDS
        try:
            self._write_state({
                "installed": self.is_available(),
                "ready": False,
                "error_code": error_code,
                "detail": detail,
            })
        except Exception as exc:  # pragma: no cover - logging fallback
            logger.warning("Failed to persist semantic runtime failure state: %s", exc)

    def _record_ready(self, payload: dict[str, object]) -> None:
        self._failure_cooldown_until = 0.0
        normalized_python_path = str(self.python_path).replace("\\", "/")
        runtime_source = "system"
        if "semantic-memory/python/" in normalized_python_path:
            runtime_source = "managed"
        elif "backend/.venv/" in normalized_python_path:
            runtime_source = "development"
        try:
            self._write_state({
                "installed": True,
                "ready": True,
                "runtime_source": runtime_source,
                "python_version": payload.get("python_version"),
                "sqlite_module": payload.get("sqlite_module"),
                "sqlite_version": payload.get("sqlite_version"),
                "vec_version": payload.get("vec_version"),
                "selected_model": payload.get("model"),
                "model_ready": payload.get("model_cached", True),
                "error_code": None,
                "detail": "Semantic retrieval is installed and ready for local memory ranking.",
            })
        except Exception as exc:  # pragma: no cover - logging fallback
            logger.warning("Failed to persist semantic runtime ready state: %s", exc)

    def _start_process(self) -> subprocess.Popen[str]:
        ensure_directory(self.runtime_dir)
        ensure_directory(self.log_path.parent)

        proc = subprocess.Popen(
            [
                str(self.python_path),
                str(self.helper_path),
                "--serve",
                "--runtime-root",
                str(self.runtime_dir),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._process = proc
        self._stderr_thread = threading.Thread(target=self._drain_stderr, args=(proc,), daemon=True)
        self._stderr_thread.start()

        ready = self._read_response(proc, timeout=BOOT_TIMEOUT_SECONDS)
        if not ready.get("ok") or ready.get("event") != "ready":
            detail = str(ready.get("detail") or ready.get("error") or "Semantic helper did not become ready.")
            error_code = str(ready.get("error_code") or "runtime_corrupt")
            self.close()
            self._record_failure(detail, error_code)
            raise RuntimeError(detail)
        self._record_ready(ready)
        return proc

    def _ensure_process(self) -> subprocess.Popen[str]:
        proc = self._process
        if proc is not None and proc.poll() is None:
            return proc
        return self._start_process()

    def _request(self, payload: dict[str, object], *, timeout: float) -> dict[str, object]:
        with self._lock:
            proc = self._ensure_process()
            if proc.stdin is None:
                raise RuntimeError("Semantic helper stdin is unavailable.")
            proc.stdin.write(json.dumps(payload, ensure_ascii=True) + "\n")
            proc.stdin.flush()
            response = self._read_response(proc, timeout=timeout)
            if not response.get("ok"):
                raise RuntimeError(str(response.get("error") or "Semantic helper request failed."))
            return response

    def _read_response(self, proc: subprocess.Popen[str], *, timeout: float) -> dict[str, object]:
        if proc.stdout is None:
            raise RuntimeError("Semantic helper stdout is unavailable.")

        box: dict[str, str] = {}
        error_box: dict[str, Exception] = {}

        def _reader() -> None:
            try:
                line = proc.stdout.readline()
                box["line"] = line
            except Exception as exc:  # pragma: no cover - defensive
                error_box["error"] = exc

        reader = threading.Thread(target=_reader, daemon=True)
        reader.start()
        reader.join(timeout)

        if reader.is_alive():
            raise RuntimeError("Semantic helper request timed out.")
        if "error" in error_box:
            raise RuntimeError(str(error_box["error"]))

        line = box.get("line", "")
        if not line:
            stderr_tail = ""
            try:
                if proc.stderr is not None:
                    stderr_tail = proc.stderr.read()[-400:]
            except Exception:
                stderr_tail = ""
            raise RuntimeError(
                "Semantic helper exited unexpectedly."
                + (f" {stderr_tail.strip()}" if stderr_tail.strip() else "")
            )

        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Semantic helper returned invalid JSON: {line.strip()}") from exc

        if not isinstance(parsed, dict):
            raise RuntimeError("Semantic helper returned an unexpected payload.")
        return parsed

    def _drain_stderr(self, proc: subprocess.Popen[str]) -> None:
        if proc.stderr is None:
            return

        try:
            with self.log_path.open("a", encoding="utf-8") as handle:
                for line in proc.stderr:
                    message = line.rstrip()
                    if not message:
                        continue
                    handle.write(message + "\n")
                    handle.flush()
                    logger.warning("Semantic helper: %s", message)
        except OSError as exc:  # pragma: no cover - logging fallback
            logger.warning("Failed to write semantic helper logs: %s", exc)
