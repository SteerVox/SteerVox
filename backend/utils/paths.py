from __future__ import annotations

import logging
import os
import sys
import tempfile
from pathlib import Path

from utils.branding import APP_HOME_DIR_NAME, APP_HOME_ENV_VAR, FALLBACK_LOG_FILE_NAME

APP_HOME_ENV = APP_HOME_ENV_VAR
FFMPEG_BIN_DIR_ENV_VAR = "STEERVOX_FFMPEG_BIN_DIR"

# Use stdlib logging directly to avoid a circular import with utils.logger.
_paths_logger = logging.getLogger(__name__)


def get_app_home() -> Path:
    override = os.environ.get(APP_HOME_ENV)
    if override:
        return Path(override).expanduser()
    return Path.home() / APP_HOME_DIR_NAME


def is_frozen_runtime() -> bool:
    return bool(getattr(sys, "frozen", False))


def get_runtime_root() -> Path:
    if is_frozen_runtime():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def resolve_runtime_path(*parts: str | Path) -> Path:
    root = get_runtime_root()
    for part in parts:
        root = root / part
    return root


def ensure_directory(path: Path, mode: int = 0o700) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    safe_chmod(path, mode)
    return path


def safe_chmod(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError as exc:
        # Permission mode changes are advisory on some filesystems (e.g. FAT,
        # SMB shares). Record the failure at debug so we do not lose the signal
        # if it turns out to be a real issue.
        _paths_logger.debug("safe_chmod failed for %s (mode=%o): %s", path, mode, exc)


def get_temp_dir() -> Path:
    return ensure_directory(get_app_home() / "temp")


def get_logs_dir() -> Path:
    return ensure_directory(get_app_home() / "logs")


def get_recordings_dir() -> Path:
    return ensure_directory(get_app_home() / "recordings")


def get_models_dir() -> Path:
    return ensure_directory(get_app_home() / "models")


def get_hf_cache_dir() -> Path:
    return ensure_directory(get_app_home() / ".hf-cache")


def get_mlx_whisper_models_dir() -> Path:
    return ensure_directory(get_models_dir() / "mlx-whisper")


def get_mlx_whisper_hf_cache_dir() -> Path:
    return ensure_directory(get_hf_cache_dir() / "mlx-whisper")


def get_semantic_memory_runtime_dir() -> Path:
    return ensure_directory(get_app_home() / "semantic-memory")


def get_semantic_memory_runtime_python_path() -> Path:
    return get_semantic_memory_runtime_dir() / "venv" / "bin" / "python3"


def get_semantic_memory_helper_path() -> Path:
    return get_semantic_memory_runtime_dir() / "semantic_memory_helper.py"


def get_semantic_memory_log_path() -> Path:
    return get_semantic_memory_runtime_dir() / "runtime.log"


def get_semantic_memory_install_log_path() -> Path:
    return get_semantic_memory_runtime_dir() / "install.log"


def get_semantic_memory_state_path() -> Path:
    return get_semantic_memory_runtime_dir() / "state.json"


def get_fallback_log_file() -> Path:
    return Path(tempfile.gettempdir()) / FALLBACK_LOG_FILE_NAME


def get_bundled_ffmpeg_bin_dir() -> Path | None:
    override = os.environ.get(FFMPEG_BIN_DIR_ENV_VAR)
    if override:
        return Path(override).expanduser()

    if not is_frozen_runtime():
        return None

    executable_parent = Path(sys.executable).resolve().parent
    return executable_parent.parent / "ffmpeg" / "bin"
