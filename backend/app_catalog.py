from __future__ import annotations

import os
import plistlib
import re
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from utils.logger import get_logger


logger = get_logger()
APP_SUFFIX_PATTERN = re.compile(r"\.app$", re.IGNORECASE)
NON_ALNUM_PATTERN = re.compile(r"[^a-z0-9]+")
MULTISPACE_PATTERN = re.compile(r"\s+")


def normalize_app_match_text(value: str) -> str:
    cleaned = _clean_display_text(value).lower()
    cleaned = APP_SUFFIX_PATTERN.sub("", cleaned)
    cleaned = NON_ALNUM_PATTERN.sub(" ", cleaned)
    return MULTISPACE_PATTERN.sub(" ", cleaned).strip()


@dataclass(frozen=True)
class InstalledAppRecord:
    display_name: str
    bundle_name: str
    executable_name: Optional[str]
    bundle_id: Optional[str]
    app_path: str
    aliases: tuple[str, ...]


class AppCatalog:
    def __init__(
        self,
        *,
        roots: Optional[Iterable[str | Path]] = None,
        cache_ttl_sec: float = 60.0,
    ) -> None:
        default_roots = (
            Path("/Applications"),
            Path("/System/Applications"),
            Path("/Applications/Utilities"),
            Path.home() / "Applications",
        )
        self._roots = tuple(Path(root).expanduser() for root in (roots or default_roots))
        self._cache_ttl_sec = max(cache_ttl_sec, 0.0)
        self._cached_apps: list[InstalledAppRecord] | None = None
        self._cached_at = 0.0

    def list_apps(self, *, force_refresh: bool = False) -> list[InstalledAppRecord]:
        now = time.monotonic()
        if (
            not force_refresh
            and self._cached_apps is not None
            and (now - self._cached_at) <= self._cache_ttl_sec
        ):
            return list(self._cached_apps)

        apps = self._discover_apps()
        self._cached_apps = apps
        self._cached_at = now
        return list(apps)

    def clear_cache(self) -> None:
        self._cached_apps = None
        self._cached_at = 0.0

    def _discover_apps(self) -> list[InstalledAppRecord]:
        records: list[InstalledAppRecord] = []
        seen_paths: set[str] = set()

        for root in self._roots:
            if not root.exists():
                continue

            for app_path in self._iter_app_bundles(root):
                app_path_str = str(app_path)
                if app_path_str in seen_paths:
                    continue
                seen_paths.add(app_path_str)
                record = self._load_app_record(app_path)
                if record is not None:
                    records.append(record)

        records.sort(key=lambda record: (record.display_name.lower(), record.app_path.lower()))
        logger.info("[AppCatalog] Discovered %d installed apps.", len(records))
        return records

    def _iter_app_bundles(self, root: Path):
        for current_root, dirnames, _ in os.walk(root):
            app_dirnames = [dirname for dirname in dirnames if dirname.endswith(".app")]
            for dirname in app_dirnames:
                yield Path(current_root) / dirname
            dirnames[:] = [dirname for dirname in dirnames if not dirname.endswith(".app")]

    def _load_app_record(self, app_path: Path) -> Optional[InstalledAppRecord]:
        info_plist_path = app_path / "Contents" / "Info.plist"
        info: dict[str, object] = {}

        if info_plist_path.exists():
            try:
                with info_plist_path.open("rb") as handle:
                    loaded = plistlib.load(handle)
                    if isinstance(loaded, dict):
                        info = loaded
            except Exception as exc:
                logger.debug("[AppCatalog] Failed to read %s: %s", info_plist_path, exc)

        bundle_name = _clean_display_text(info.get("CFBundleName") or app_path.stem) or app_path.stem
        display_name = _clean_display_text(info.get("CFBundleDisplayName") or bundle_name or app_path.stem) or app_path.stem
        executable_name = _clean_display_text(info.get("CFBundleExecutable") or "") or None
        bundle_id = str(info.get("CFBundleIdentifier") or "").strip() or None

        alias_candidates = {
            display_name,
            bundle_name,
            app_path.stem,
        }
        if executable_name:
            alias_candidates.add(executable_name)

        normalized_aliases = sorted({
            normalized
            for candidate in alias_candidates
            for normalized in (normalize_app_match_text(candidate), normalize_app_match_text(candidate.replace("-", " ")))
            if normalized
        })

        return InstalledAppRecord(
            display_name=display_name,
            bundle_name=bundle_name,
            executable_name=executable_name,
            bundle_id=bundle_id,
            app_path=str(app_path),
            aliases=tuple(normalized_aliases),
        )


def _clean_display_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Cf")
    return text.strip()
