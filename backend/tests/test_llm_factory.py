from __future__ import annotations

import sys
import types

from langchain_core.prompts import ChatPromptTemplate

from providers.llm_factory import LLMFactory


def test_llm_factory_reuses_cached_client_for_same_configuration(monkeypatch):
    calls: list[dict[str, object]] = []

    class FakeChatGroq:
        def __init__(self, *, model: str, temperature: float, api_key: str | None):
            calls.append({
                "model": model,
                "temperature": temperature,
                "api_key": api_key,
            })

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "groq-key")
    monkeypatch.setitem(sys.modules, "langchain_groq", types.SimpleNamespace(ChatGroq=FakeChatGroq))

    first = LLMFactory.get_llm("groq", "llama3-70b-8192", 0.0)
    second = LLMFactory.get_llm("groq", "llama3-70b-8192", 0.0)

    assert first is second
    assert len(calls) == 1


def test_llm_factory_rebuilds_client_when_api_key_changes(monkeypatch):
    calls: list[dict[str, object]] = []
    current_key = {"value": "key-one"}

    class FakeChatGroq:
        def __init__(self, *, model: str, temperature: float, api_key: str | None):
            calls.append({
                "model": model,
                "temperature": temperature,
                "api_key": api_key,
            })

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: current_key["value"])
    monkeypatch.setitem(sys.modules, "langchain_groq", types.SimpleNamespace(ChatGroq=FakeChatGroq))

    first = LLMFactory.get_llm("groq", "llama3-70b-8192", 0.0)
    current_key["value"] = "key-two"
    second = LLMFactory.get_llm("groq", "llama3-70b-8192", 0.0)

    assert first is not second
    assert [call["api_key"] for call in calls] == ["key-one", "key-two"]


def test_llm_factory_builds_gemini_client_via_openai_compat(monkeypatch):
    calls: list[dict[str, object]] = []

    class FakeChatOpenAI:
        def __init__(self, *, model: str, temperature: float, api_key: str | None, base_url: str, **kwargs):
            calls.append({
                "model": model,
                "temperature": temperature,
                "api_key": api_key,
                "base_url": base_url,
                **kwargs,
            })

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "gemini-key")
    monkeypatch.setitem(sys.modules, "langchain_openai", types.SimpleNamespace(ChatOpenAI=FakeChatOpenAI))

    client = LLMFactory.get_llm("gemini", "gemini-2.5-flash", 0.1)

    assert client is not None
    assert calls == [{
        "model": "gemini-2.5-flash",
        "temperature": 0.1,
        "api_key": "gemini-key",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
    }]


def test_llm_factory_builds_nvidia_client_via_openai_compat(monkeypatch):
    calls: list[dict[str, object]] = []

    class FakeChatOpenAI:
        def __init__(self, *, model: str, temperature: float, api_key: str | None, base_url: str, **kwargs):
            calls.append({
                "model": model,
                "temperature": temperature,
                "api_key": api_key,
                "base_url": base_url,
                **kwargs,
            })

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "nvidia-key")
    monkeypatch.setitem(sys.modules, "langchain_openai", types.SimpleNamespace(ChatOpenAI=FakeChatOpenAI))

    client = LLMFactory.get_llm("nvidia", "minimaxai/minimax-m2.7", 0.0)

    assert client is not None
    assert calls == [{
        "model": "minimaxai/minimax-m2.7",
        "temperature": 0.0,
        "api_key": "nvidia-key",
        "base_url": "https://integrate.api.nvidia.com/v1",
    }]


def test_llm_factory_forwards_timeout_controls_to_remote_openai_family_clients(monkeypatch):
    calls: list[dict[str, object]] = []

    class FakeChatOpenAI:
        def __init__(self, *, model: str, temperature: float, api_key: str | None, base_url: str, **kwargs):
            calls.append({
                "model": model,
                "temperature": temperature,
                "api_key": api_key,
                "base_url": base_url,
                **kwargs,
            })

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "nvidia-key")
    monkeypatch.setitem(sys.modules, "langchain_openai", types.SimpleNamespace(ChatOpenAI=FakeChatOpenAI))

    LLMFactory.get_llm(
        "nvidia",
        "minimaxai/minimax-m2.7",
        0.0,
        timeout=18.0,
        max_retries=0,
        max_tokens=1200,
    )

    assert calls == [{
        "model": "minimaxai/minimax-m2.7",
        "temperature": 0.0,
        "api_key": "nvidia-key",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "request_timeout": 18.0,
        "max_retries": 0,
        "max_tokens": 1200,
    }]


def test_llm_factory_builds_sarvam_client_via_openai_compat(monkeypatch):
    calls: list[dict[str, object]] = []

    class FakeChatOpenAI:
        def __init__(self, *, model: str, temperature: float, api_key: str | None, base_url: str, **kwargs):
            calls.append({
                "model": model,
                "temperature": temperature,
                "api_key": api_key,
                "base_url": base_url,
                **kwargs,
            })

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "sarvam-key")
    monkeypatch.setitem(sys.modules, "langchain_openai", types.SimpleNamespace(ChatOpenAI=FakeChatOpenAI))

    client = LLMFactory.get_llm("sarvam", "sarvam-30b", 0.2)

    assert client is not None
    assert calls == [{
        "model": "sarvam-30b",
        "temperature": 0.2,
        "api_key": "sarvam-key",
        "base_url": "https://api.sarvam.ai/v1",
        "default_headers": {"api-subscription-key": "sarvam-key"},
    }]


def test_llm_factory_builds_lmstudio_client_without_user_key(monkeypatch):
    calls: list[dict[str, object]] = []

    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        @staticmethod
        def json():
            return {
                "output": [
                    {"type": "message", "content": "Local reply."},
                ],
                "stats": {"tokens_per_second": 42.0},
            }

    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        calls.append({
            "method": method,
            "url": url,
            "json": json,
            "headers": headers,
            "timeout": timeout,
        })
        return Response()

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    client = LLMFactory.get_llm("lmstudio", "qwen2.5-0.5b-instruct-mlx", 0.0)
    response = client.invoke("Hello from local LM Studio.")

    assert client is not None
    assert response.content == "Local reply."
    assert calls == [{
        "method": "POST",
        "url": "http://localhost:1234/v1/chat/completions",
        "json": {
            "model": "qwen2.5-0.5b-instruct-mlx",
            "messages": [{"role": "user", "content": "Hello from local LM Studio."}],
            "temperature": 0.0,
            "stream": False,
            "context_length": 8192,
        },
        "headers": {"Content-Type": "application/json"},
        "timeout": 30.0,
    }]


def test_llm_factory_forwards_timeout_controls_to_groq(monkeypatch):
    calls: list[dict[str, object]] = []

    class FakeChatGroq:
        def __init__(self, *, model: str, temperature: float, api_key: str | None, **kwargs):
            calls.append({
                "model": model,
                "temperature": temperature,
                "api_key": api_key,
                **kwargs,
            })

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "groq-key")
    monkeypatch.setitem(sys.modules, "langchain_groq", types.SimpleNamespace(ChatGroq=FakeChatGroq))

    LLMFactory.get_llm(
        "groq",
        "llama-3.3-70b-versatile",
        0.1,
        timeout=18.0,
        max_retries=0,
        max_tokens=900,
    )

    assert calls == [{
        "model": "llama-3.3-70b-versatile",
        "temperature": 0.1,
        "api_key": "groq-key",
        "request_timeout": 18.0,
        "max_retries": 0,
        "max_tokens": 900,
    }]


def test_llm_factory_forwards_retry_controls_to_anthropic(monkeypatch):
    calls: list[dict[str, object]] = []

    class FakeChatAnthropic:
        def __init__(self, *, model: str, temperature: float, api_key: str | None, **kwargs):
            calls.append({
                "model": model,
                "temperature": temperature,
                "api_key": api_key,
                **kwargs,
            })

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "anthropic-key")
    monkeypatch.setitem(sys.modules, "langchain_anthropic", types.SimpleNamespace(ChatAnthropic=FakeChatAnthropic))

    LLMFactory.get_llm(
        "anthropic",
        "claude-sonnet-4-20250514",
        0.0,
        timeout=18.0,
        max_retries=0,
        max_tokens=800,
    )

    assert calls == [{
        "model": "claude-sonnet-4-20250514",
        "temperature": 0.0,
        "api_key": "anthropic-key",
        "default_request_timeout": 18.0,
        "max_retries": 0,
        "max_tokens": 800,
    }]


def test_llm_factory_applies_local_request_tuning_for_lmstudio(monkeypatch):
    calls: list[dict[str, object]] = []

    class Response:
        status_code = 200

        def raise_for_status(self):
            return None

        @staticmethod
        def json():
            return {
                "output": [
                    {"type": "message", "content": "Structured local output."},
                ],
            }

    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        calls.append({
            "method": method,
            "url": url,
            "json": json,
            "headers": headers,
            "timeout": timeout,
        })
        return Response()

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: None)
    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    client = LLMFactory.get_llm(
        "lmstudio",
        "qwen2.5-0.5b-instruct-mlx",
        0.1,
        timeout=12.0,
        max_retries=0,
        max_tokens=192,
        context_length=4096,
    )
    chain = ChatPromptTemplate.from_messages([
        ("system", "You are concise."),
        ("human", "Rewrite {text}"),
    ]) | client
    response = chain.invoke({"text": "this update"})

    assert client is not None
    assert response.content == "Structured local output."
    assert calls == [{
        "method": "POST",
        "url": "http://localhost:1234/v1/chat/completions",
        "json": {
            "model": "qwen2.5-0.5b-instruct-mlx",
            "messages": [
                {"role": "system", "content": "You are concise."},
                {"role": "user", "content": "Rewrite this update"},
            ],
            "temperature": 0.1,
            "stream": False,
            "max_tokens": 192,
            "context_length": 8192,
        },
        "headers": {"Content-Type": "application/json"},
        "timeout": 12.0,
    }]
