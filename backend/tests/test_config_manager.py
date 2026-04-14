from config.manager import ConfigManager


def test_config_manager_normalizes_router_model_to_match_smart_model_on_load(isolated_steervox_home):
    config_path = isolated_steervox_home / "config.json"
    isolated_steervox_home.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        """
{
    "stt": {
        "provider": "mlx-whisper",
        "model": "mlx-community/whisper-large-v3-turbo",
        "language": "en",
        "language_mode": "fixed",
        "preferred_languages": ["en"]
    },
    "llm": {
        "provider": "groq",
        "model": "moonshotai/kimi-k2-instruct-0905",
        "temperature": 0.0,
        "routing": {
            "enabled": true,
            "provider": "groq",
            "model": "groq/compound-mini",
            "temperature": 0.0
        }
    }
}
        """.strip(),
        encoding="utf-8",
    )

    config = ConfigManager().get_config()

    assert config.llm.provider == "groq"
    assert config.llm.model == "moonshotai/kimi-k2-instruct-0905"
    assert config.llm.routing.provider == "groq"
    assert config.llm.routing.model == "moonshotai/kimi-k2-instruct-0905"


def test_config_manager_update_keeps_router_model_mirrored():
    manager = ConfigManager()

    updated = manager.update_config({
        "llm": {
            "provider": "lmstudio",
            "model": "google/medgemma-4b-it",
            "routing": {
                "enabled": True,
                "provider": "groq",
                "model": "groq/compound-mini",
                "temperature": 0.0,
            },
        }
    })

    assert updated is not None
    assert updated.llm.provider == "lmstudio"
    assert updated.llm.model == "google/medgemma-4b-it"
    assert updated.llm.routing.provider == "lmstudio"
    assert updated.llm.routing.model == "google/medgemma-4b-it"
