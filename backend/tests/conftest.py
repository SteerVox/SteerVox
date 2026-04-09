from __future__ import annotations

import sys
from pathlib import Path

import pytest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@pytest.fixture(autouse=True)
def isolated_steervox_home(monkeypatch, tmp_path):
    app_home = tmp_path / ".steervox"
    monkeypatch.setenv("STEERVOX_HOME", str(app_home))

    from agent.skills.manager import SkillManager
    from config.manager import ConfigManager
    from providers.llm_factory import LLMFactory
    from providers.model_discovery import ModelDiscovery
    from utils.logger import LoggerSetup

    LoggerSetup.reset()
    SkillManager._instance = None
    ConfigManager._instance = None
    ConfigManager._config = None
    LLMFactory._client_cache.clear()
    ModelDiscovery.clear_cache()

    yield app_home

    LoggerSetup.reset()
    SkillManager._instance = None
    ConfigManager._instance = None
    ConfigManager._config = None
    LLMFactory._client_cache.clear()
    ModelDiscovery.clear_cache()
