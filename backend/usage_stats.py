from __future__ import annotations

import json
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

from utils.logger import get_logger
from utils.paths import get_app_home, safe_chmod


TYPING_SPEED_CHARS_PER_MINUTE = 200
logger = get_logger()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class UsageStats(BaseModel):
    tracking_started_at: str = Field(default_factory=_utc_now_iso)
    dictation_runs: int = 0
    smart_runs: int = 0
    fastest_dictation_stt_ms: Optional[int] = None
    fastest_smart_stt_ms: Optional[int] = None
    time_saved_seconds_total: int = 0


class UsageStatsStore:
    def __init__(self, path: Optional[Path] = None):
        self.path = path or (get_app_home() / "usage.json")
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        safe_chmod(self.path.parent, 0o700)
        self._ensure_exists()

    def _default_stats(self) -> UsageStats:
        return UsageStats()

    def _ensure_exists(self) -> None:
        if self.path.exists():
            return
        self._save_unlocked(self._default_stats())

    def _load_unlocked(self) -> UsageStats:
        try:
            with open(self.path, "r") as handle:
                data = json.load(handle)
            return UsageStats(**data)
        except Exception as exc:
            logger.warning("Failed to read usage stats from %s: %s", self.path, exc)
            return self._default_stats()

    def _save_unlocked(self, stats: UsageStats) -> None:
        with tempfile.NamedTemporaryFile(
            mode="w",
            dir=self.path.parent,
            prefix="usage_",
            suffix=".json",
            delete=False,
        ) as handle:
            json.dump(stats.model_dump(), handle, indent=2)
            temp_path = Path(handle.name)
        safe_chmod(temp_path, 0o600)
        temp_path.replace(self.path)
        safe_chmod(self.path, 0o600)

    def get_stats(self) -> UsageStats:
        with self._lock:
            return self._load_unlocked()

    def reset(self) -> UsageStats:
        with self._lock:
            stats = self._default_stats()
            self._save_unlocked(stats)
            return stats

    def record_success(
        self,
        *,
        mode: Literal["dictation", "smart_transform"],
        output_text: str,
        stt_latency_ms: Optional[int],
        recording_duration_ms: int,
        pipeline_duration_ms: int,
    ) -> UsageStats:
        output_chars = len(output_text.strip())
        if output_chars <= 0:
            return self.get_stats()

        typing_seconds = (output_chars / TYPING_SPEED_CHARS_PER_MINUTE) * 60
        time_saved_seconds = max(
            0,
            int(round(typing_seconds - (recording_duration_ms / 1000) - (pipeline_duration_ms / 1000))),
        )

        with self._lock:
            stats = self._load_unlocked()
            if mode == "dictation":
                stats.dictation_runs += 1
                if stt_latency_ms is not None and (
                    stats.fastest_dictation_stt_ms is None or stt_latency_ms < stats.fastest_dictation_stt_ms
                ):
                    stats.fastest_dictation_stt_ms = stt_latency_ms
            else:
                stats.smart_runs += 1
                if stt_latency_ms is not None and (
                    stats.fastest_smart_stt_ms is None or stt_latency_ms < stats.fastest_smart_stt_ms
                ):
                    stats.fastest_smart_stt_ms = stt_latency_ms

            stats.time_saved_seconds_total += time_saved_seconds
            self._save_unlocked(stats)
            return stats
