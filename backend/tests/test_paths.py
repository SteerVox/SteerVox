from pathlib import Path

from agent.skills.defaults import SYSTEM_REGISTRY_PATH, get_system_registry_path
from domains.store import BUNDLED_REGISTRY_PATH, get_bundled_registry_path
from utils import paths


def test_runtime_paths_default_to_repo_layout():
    assert paths.get_runtime_root() == Path(paths.__file__).resolve().parents[1]
    assert paths.resolve_runtime_path("agent", "skills", "system_registry.yaml") == SYSTEM_REGISTRY_PATH
    assert get_system_registry_path() == SYSTEM_REGISTRY_PATH
    assert get_bundled_registry_path() == BUNDLED_REGISTRY_PATH


def test_runtime_paths_use_meipass_when_frozen(monkeypatch, tmp_path):
    monkeypatch.setattr(paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(paths.sys, "_MEIPASS", str(tmp_path), raising=False)

    assert paths.get_runtime_root() == tmp_path
    assert paths.resolve_runtime_path("agent", "skills") == tmp_path / "agent" / "skills"
    assert get_system_registry_path() == tmp_path / "agent" / "skills" / "system_registry.yaml"
    assert get_bundled_registry_path() == tmp_path / "domains" / "bundled_registry.yaml"


def test_bundled_ffmpeg_dir_prefers_env_override(monkeypatch, tmp_path):
    override_dir = tmp_path / "ffmpeg" / "bin"
    monkeypatch.setenv(paths.FFMPEG_BIN_DIR_ENV_VAR, str(override_dir))

    assert paths.get_bundled_ffmpeg_bin_dir() == override_dir


def test_bundled_ffmpeg_dir_uses_frozen_sibling_layout(monkeypatch, tmp_path):
    executable_path = tmp_path / "Resources" / "steervox-engine" / "steervox-engine"
    executable_path.parent.mkdir(parents=True)
    executable_path.write_text("")
    monkeypatch.delenv(paths.FFMPEG_BIN_DIR_ENV_VAR, raising=False)
    monkeypatch.setattr(paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(paths.sys, "executable", str(executable_path), raising=False)

    assert paths.get_bundled_ffmpeg_bin_dir() == tmp_path / "Resources" / "ffmpeg" / "bin"
