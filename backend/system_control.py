from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Literal

from utils.branding import DISPLAY_NAME, SYSTEM_CONTROL_HELPER_BINARY_NAME, SYSTEM_CONTROL_HELPER_ENV_VAR
from utils.logger import get_logger
from utils.paths import ensure_directory, get_app_home


logger = get_logger()

HELPER_BINARY_NAME = SYSTEM_CONTROL_HELPER_BINARY_NAME
HELPER_SOURCE_FILE_NAME = f"{DISPLAY_NAME.replace(' ', '')}SystemControlHelper.swift"
DEFAULT_TIMEOUT_SEC = 2.5


class SystemControlError(RuntimeError):
    pass


class SystemControlUnavailableError(SystemControlError):
    pass


class SystemControlService:
    def __init__(self, *, timeout_sec: float = DEFAULT_TIMEOUT_SEC) -> None:
        self.timeout_sec = timeout_sec
        self._repo_root = Path(__file__).resolve().parents[1]
        self._source_path = self._repo_root / "frontend" / "native" / HELPER_SOURCE_FILE_NAME
        self._development_binary_path = self._repo_root / "frontend" / "native" / "bin" / HELPER_BINARY_NAME

    def media_transport(
        self,
        action_type: Literal["play_pause", "next_track", "previous_track"],
    ) -> None:
        self._run_helper([action_type])

    def pause_playback(self) -> None:
        self._run_helper(["pause_playback"])

    def brightness_up(self) -> None:
        self._run_helper(["brightness_up"])

    def brightness_down(self) -> None:
        self._run_helper(["brightness_down"])

    def set_brightness_percent(self, value_percent: int) -> None:
        self._run_helper(["set_brightness_percent", str(max(0, min(100, value_percent)))])

    def _run_helper(self, args: list[str]) -> None:
        helper_path = self._resolve_binary_path()
        try:
            result = subprocess.run(
                [str(helper_path), *args],
                check=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_sec,
            )
        except FileNotFoundError as exc:
            raise SystemControlUnavailableError("The macOS system control helper is unavailable.") from exc
        except subprocess.TimeoutExpired as exc:
            raise SystemControlError("The macOS system control helper timed out.") from exc

        if result.returncode == 0:
            return

        detail = result.stderr.strip() or result.stdout.strip() or "The macOS system control helper failed."
        raise SystemControlError(detail)

    def _resolve_binary_path(self) -> Path:
        if sys.platform != "darwin":
            raise SystemControlUnavailableError("Global system controls are available on macOS only.")

        configured_path = os.environ.get(SYSTEM_CONTROL_HELPER_ENV_VAR)
        if configured_path:
            candidate = Path(configured_path).expanduser()
            if candidate.exists():
                return candidate

        if self._development_binary_path.exists():
            return self._development_binary_path

        if self._source_path.exists():
            return self._compile_development_binary()

        if configured_path:
            raise SystemControlUnavailableError(
                f"The macOS system control helper was not found at {configured_path}."
            )
        raise SystemControlUnavailableError("The macOS system control helper is unavailable.")

    def _compile_development_binary(self) -> Path:
        output_dir = ensure_directory(get_app_home() / "bin")
        module_cache_path = ensure_directory(output_dir / ".swift-module-cache")
        output_path = output_dir / HELPER_BINARY_NAME

        source_stats = self._source_path.stat()
        output_stats = output_path.stat() if output_path.exists() else None
        if output_stats is not None and output_stats.st_mtime_ns >= source_stats.st_mtime_ns:
            return output_path

        logger.info("[SystemControl] Compiling helper from %s", self._source_path)
        compile_command = [
            "xcrun",
            "swiftc",
            str(self._source_path),
            "-parse-as-library",
            "-o",
            str(output_path),
            "-module-cache-path",
            str(module_cache_path),
            "-framework",
            "Foundation",
            "-framework",
            "AppKit",
            "-framework",
            "IOKit",
            "-framework",
            "CoreGraphics",
        ]
        try:
            subprocess.run(
                compile_command,
                check=True,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except FileNotFoundError as exc:
            raise SystemControlUnavailableError("Xcode command line tools are required to build the macOS system control helper.") from exc
        except subprocess.TimeoutExpired as exc:
            raise SystemControlUnavailableError("Building the macOS system control helper timed out.") from exc
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
            raise SystemControlUnavailableError(f"Failed to build the macOS system control helper: {detail}") from exc

        try:
            os.chmod(output_path, 0o755)
        except OSError as exc:
            logger.warning(
                "Unable to mark system control helper %s as executable: %s",
                output_path,
                exc,
            )

        return output_path
