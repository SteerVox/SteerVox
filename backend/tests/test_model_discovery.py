import requests

from providers import model_discovery
from providers.model_discovery import DEFAULT_MODELS, ModelDiscovery


def test_model_discovery_returns_hardcoded_gemini_models_without_api_call(monkeypatch):
    model_discovery._cache.clear()

    def fail_requests(*args, **kwargs):
        raise AssertionError("Gemini model discovery should not make a network request in this pass.")

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", fail_requests)

    result = ModelDiscovery.list_models("gemini")

    assert result == {
        "llm": DEFAULT_MODELS["llm"]["gemini"],
        "stt": [],
        "vision": [],
    }


def test_model_discovery_returns_default_nvidia_models_without_api_key(monkeypatch):
    model_discovery._cache.clear()

    def fail_requests(*args, **kwargs):
        raise AssertionError("NVIDIA model discovery should not make a network request without an API key.")

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", fail_requests)

    result = ModelDiscovery.list_models("nvidia")

    assert result == {
        "llm": DEFAULT_MODELS["llm"]["nvidia"],
        "stt": DEFAULT_MODELS["stt"]["nvidia"],
        "vision": [],
    }


def test_model_discovery_queries_nvidia_models_endpoint_when_key_is_present(monkeypatch):
    model_discovery._cache.clear()
    calls: list[dict[str, object]] = []

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "data": [
                    {"id": "moonshotai/kimi-k2-instruct-0905"},
                    {"id": "qwen/qwen3-coder-480b-a35b-instruct"},
                    {"id": "nvidia/llama-3.1-nemotron-ultra-253b-v1"},
                    {"id": "openai/whisper-large-v3"},
                    {"id": "nvidia/canary-1b-asr"},
                ]
            }

    def fake_get(url, headers=None, timeout=None):
        calls.append({"url": url, "headers": headers, "timeout": timeout})
        return Response()

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "nvidia-key")
    monkeypatch.setattr(model_discovery.requests, "get", fake_get)

    result = ModelDiscovery.list_models("nvidia")

    assert calls == [{
        "url": "https://integrate.api.nvidia.com/v1/models",
        "headers": {"Authorization": "Bearer nvidia-key"},
        "timeout": 10,
    }]
    assert [item["id"] for item in result["llm"]] == [
        "moonshotai/kimi-k2-instruct-0905",
        "qwen/qwen3-coder-480b-a35b-instruct",
        "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    ]
    assert [item["id"] for item in result["stt"]] == [
        "openai/whisper-large-v3",
        "nvidia/canary-1b-asr",
    ]
    assert result["vision"] == []


def test_model_discovery_returns_hardcoded_sarvam_models_without_api_call(monkeypatch):
    model_discovery._cache.clear()

    def fail_requests(*args, **kwargs):
        raise AssertionError("Sarvam model discovery should not make a network request in this pass.")

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "sarvam-key")
    monkeypatch.setattr(model_discovery.requests, "get", fail_requests)

    result = ModelDiscovery.list_models("sarvam")

    assert result == {
        "llm": DEFAULT_MODELS["llm"]["sarvam"],
        "stt": DEFAULT_MODELS["stt"]["sarvam"],
        "vision": [],
    }


def test_model_discovery_returns_lmstudio_placeholder_when_local_server_is_unavailable(monkeypatch):
    model_discovery._cache.clear()

    def raise_connection_error(*args, **kwargs):
        raise requests.exceptions.ConnectionError("connection refused")

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", raise_connection_error)

    result = ModelDiscovery.list_models("lmstudio")

    assert result == {
        "llm": DEFAULT_MODELS["llm"]["lmstudio"],
        "stt": [],
        "vision": [],
    }


def test_model_discovery_get_all_models_includes_gemini_sarvam_and_lmstudio(monkeypatch):
    model_discovery._cache.clear()

    def raise_connection_error(*args, **kwargs):
        raise requests.exceptions.ConnectionError("connection refused")

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", raise_connection_error)

    result = ModelDiscovery.get_all_models()

    assert "gemini" in result["llm"]
    assert result["llm"]["gemini"] == DEFAULT_MODELS["llm"]["gemini"]
    assert "nvidia" in result["llm"]
    assert result["llm"]["nvidia"] == DEFAULT_MODELS["llm"]["nvidia"]
    assert result["stt"]["nvidia"] == DEFAULT_MODELS["stt"]["nvidia"]
    assert "sarvam" in result["llm"]
    assert result["llm"]["sarvam"] == DEFAULT_MODELS["llm"]["sarvam"]
    assert result["stt"]["sarvam"] == DEFAULT_MODELS["stt"]["sarvam"]
    assert "lmstudio" in result["llm"]
    assert result["llm"]["lmstudio"] == DEFAULT_MODELS["llm"]["lmstudio"]


def test_model_discovery_includes_hardcoded_mlx_whisper_models(monkeypatch):
    model_discovery._cache.clear()

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)

    result = ModelDiscovery.list_models("mlx-whisper")

    assert result == {
        "llm": [],
        "stt": DEFAULT_MODELS["stt"]["mlx-whisper"],
        "vision": [],
    }


def test_model_discovery_prefers_groq_turbo_and_mlx_turbo_defaults(monkeypatch):
    model_discovery._cache.clear()

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)

    groq_models = ModelDiscovery.list_models("groq")
    mlx_models = ModelDiscovery.list_models("mlx-whisper")

    assert groq_models["stt"][0]["id"] == "whisper-large-v3-turbo"
    assert mlx_models["stt"][0]["id"] == "mlx-community/whisper-large-v3-turbo"


def test_model_discovery_cache_miss_after_api_key_changes(monkeypatch):
    model_discovery._cache.clear()
    current_key = ""

    def get_api_key(_provider):
        return current_key or None

    def fake_requests(_url, headers=None, timeout=None):
        if headers and headers.get("Authorization") == "Bearer real-key":
            class Response:
                status_code = 200

                @staticmethod
                def json():
                    return {"data": [{"id": "gpt-4.1-mini"}]}

            return Response()

        raise AssertionError("Unexpected network call without the updated API key.")

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", get_api_key)
    monkeypatch.setattr(model_discovery.requests, "get", fake_requests)

    first = ModelDiscovery.list_models("openai")
    assert first == {
        "llm": DEFAULT_MODELS["llm"]["openai"],
        "stt": DEFAULT_MODELS["stt"]["openai"],
        "vision": [],
    }

    current_key = "real-key"
    second = ModelDiscovery.list_models("openai")
    assert second["llm"][0]["id"] == "gpt-4.1-mini"


def test_model_discovery_does_not_cache_unavailable_lmstudio_fallback(monkeypatch):
    model_discovery._cache.clear()
    calls = {"count": 0}

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)

    def fake_requests(*_args, **_kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            raise requests.exceptions.ConnectionError("connection refused")

        class Response:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "models": [
                        {
                            "type": "llm",
                            "key": "qwen2.5-coder",
                            "display_name": "Qwen 2.5 Coder",
                        }
                    ]
                }

        return Response()

    monkeypatch.setattr(model_discovery.requests, "get", fake_requests)

    unavailable = ModelDiscovery.list_models("lmstudio")
    assert unavailable["llm"] == DEFAULT_MODELS["llm"]["lmstudio"]

    available = ModelDiscovery.list_models("lmstudio")
    assert available["llm"][0]["id"] == "qwen2.5-coder"


def test_model_discovery_uses_native_lmstudio_models_endpoint(monkeypatch):
    model_discovery._cache.clear()
    calls: list[dict[str, object]] = []

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "models": [
                    {
                        "type": "llm",
                        "key": "nemotron-4b",
                        "display_name": "Nemotron 4B",
                    },
                    {
                        "type": "embedding",
                        "key": "nomic-embed",
                        "display_name": "Nomic Embed",
                    },
                ]
            }

    def fake_get(url, headers=None, timeout=None):
        calls.append({"url": url, "headers": headers, "timeout": timeout})
        return Response()

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", fake_get)

    result = ModelDiscovery.list_models("lmstudio")

    assert result == {
        "llm": [{
            "id": "nemotron-4b",
            "name": "Nemotron 4B",
            "loaded": False,
            "vision": False,
            "tool_use": False,
            "reasoning": False,
            "smart_capable": False,
            "recommended_for_smart": False,
            "max_context_length": None,
        }],
        "stt": [],
        "vision": [],
    }
    assert calls == [{
        "url": "http://localhost:1234/api/v1/models",
        "headers": {},
        "timeout": 6,
    }]


def test_model_discovery_exposes_lmstudio_vision_models_separately(monkeypatch):
    model_discovery._cache.clear()

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "models": [
                    {
                        "type": "llm",
                        "key": "granite-vision",
                        "display_name": "Granite Vision",
                        "loaded_instances": [{"id": "instance-1"}],
                        "capabilities": {"vision": True},
                    },
                    {
                        "type": "llm",
                        "key": "nemotron-4b",
                        "display_name": "Nemotron 4B",
                        "loaded_instances": [],
                        "capabilities": {"vision": False},
                    },
                ]
            }

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", lambda *_args, **_kwargs: Response())

    result = ModelDiscovery.list_models("lmstudio")

    assert result["llm"] == [
        {
            "id": "granite-vision",
            "name": "Granite Vision",
            "loaded": True,
            "vision": True,
            "tool_use": False,
            "reasoning": False,
            "smart_capable": False,
            "recommended_for_smart": False,
            "max_context_length": None,
        },
        {
            "id": "nemotron-4b",
            "name": "Nemotron 4B",
            "loaded": False,
            "vision": False,
            "tool_use": False,
            "reasoning": False,
            "smart_capable": False,
            "recommended_for_smart": False,
            "max_context_length": None,
        },
    ]
    assert result["vision"] == [{
        "id": "granite-vision",
        "name": "Granite Vision",
        "loaded": True,
        "vision": True,
        "tool_use": False,
        "reasoning": False,
        "smart_capable": False,
        "recommended_for_smart": False,
        "max_context_length": None,
    }]


def test_model_discovery_can_require_loaded_vision_models(monkeypatch):
    model_discovery._cache.clear()

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "models": [
                    {
                        "type": "llm",
                        "key": "broken-vision",
                        "display_name": "Broken Vision",
                        "loaded_instances": [],
                        "capabilities": {"vision": True},
                    },
                    {
                        "type": "llm",
                        "key": "loaded-vision",
                        "display_name": "Loaded Vision",
                        "loaded_instances": [{"id": "instance-1"}],
                        "capabilities": {"vision": True},
                    },
                ]
            }

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", lambda *_args, **_kwargs: Response())

    assert ModelDiscovery.lmstudio_supports_vision("broken-vision") is True
    assert ModelDiscovery.lmstudio_supports_vision("broken-vision", require_loaded=True) is False
    assert ModelDiscovery.resolve_lmstudio_vision_model("broken-vision", require_loaded=True) == "loaded-vision"


def test_model_discovery_marks_tool_use_local_models_as_smart_ready(monkeypatch):
    model_discovery._cache.clear()

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "models": [
                    {
                        "type": "llm",
                        "key": "qwen2.5-7b-instruct",
                        "display_name": "Qwen2.5 7B Instruct",
                        "trainedForToolUse": True,
                        "paramsString": "7B",
                        "maxContextLength": 32768,
                        "loaded_instances": [{"id": "instance-1"}],
                        "capabilities": {"vision": False},
                    },
                ]
            }

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", lambda *_args, **_kwargs: Response())

    result = ModelDiscovery.list_models("lmstudio")

    assert result["llm"] == [{
        "id": "qwen2.5-7b-instruct",
        "name": "Qwen2.5 7B Instruct",
        "loaded": True,
        "vision": False,
        "tool_use": True,
        "reasoning": False,
        "smart_capable": True,
        "recommended_for_smart": True,
        "max_context_length": 32768,
    }]
    assert ModelDiscovery.resolve_lmstudio_smart_model(require_loaded=True) == "qwen2.5-7b-instruct"


def test_model_discovery_resolves_medgemma_models_by_pattern(monkeypatch):
    model_discovery._cache.clear()

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "models": [
                    {
                        "type": "llm",
                        "key": "google/med-gemma-27b-it",
                        "display_name": "Med-Gemma 27B IT",
                        "paramsString": "27B",
                        "loaded_instances": [],
                        "capabilities": {"vision": False},
                    },
                    {
                        "type": "llm",
                        "key": "google/medgemma-4b-it",
                        "display_name": "MedGemma 4B IT",
                        "paramsString": "4B",
                        "loaded_instances": [{"id": "instance-1"}],
                        "capabilities": {"vision": False},
                    },
                ]
            }

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr(model_discovery.requests, "get", lambda *_args, **_kwargs: Response())

    assert ModelDiscovery.resolve_lmstudio_model_by_pattern("medgemma", require_loaded=True) == "google/medgemma-4b-it"
    assert ModelDiscovery.resolve_lmstudio_model_by_pattern("med-gemma", require_loaded=False) == "google/medgemma-4b-it"
