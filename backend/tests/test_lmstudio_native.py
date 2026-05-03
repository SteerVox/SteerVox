from __future__ import annotations

import requests
from langchain_core.prompts import ChatPromptTemplate

from providers.lmstudio_native import LMStudioNativeChat


class FakeResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"status {self.status_code}")

    def json(self):
        return self._payload

    def close(self):
        return None


class FakeStreamingResponse(FakeResponse):
    def __init__(self, status_code: int, *, lines: list[str]):
        super().__init__(status_code, {})
        self._lines = lines

    def iter_lines(self, decode_unicode=True):
        for line in self._lines:
            yield line


def test_lmstudio_native_chat_uses_native_v1_payload(monkeypatch):
    calls: list[dict[str, object]] = []

    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        calls.append({
            "method": method,
            "url": url,
            "json": json,
            "headers": headers,
            "timeout": timeout,
        })
        return FakeResponse(
            200,
            {
                "output": [
                    {"type": "reasoning", "content": "internal"},
                    {"type": "message", "content": "Please ship this once QA has approved it."},
                ],
            },
        )

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.1,
        timeout=12.0,
        max_tokens=192,
        context_length=4096,
        reasoning_mode="off",
    )
    prompt = ChatPromptTemplate.from_messages([
        ("system", "Return only the transformed output."),
        ("human", "Rewrite {text}"),
    ])
    response = llm.invoke(prompt.invoke({"text": "ship this after QA signs off"}))

    assert response.content == "Please ship this once QA has approved it."
    assert calls == [{
        "method": "POST",
        "url": "http://localhost:1234/v1/chat/completions",
        "json": {
            "model": "nvidia/nemotron-3-nano-4b",
            "messages": [
                {"role": "system", "content": "Return only the transformed output."},
                {"role": "user", "content": "Rewrite ship this after QA signs off"},
            ],
            "temperature": 0.1,
            "stream": False,
            "max_tokens": 192,
            "context_length": 8192,
            "reasoning": "off",
        },
        "headers": {"Content-Type": "application/json"},
        "timeout": 12.0,
    }]


def test_lmstudio_native_chat_retries_without_reasoning_when_rejected(monkeypatch):
    calls: list[dict[str, object]] = []

    responses = iter([
        FakeResponse(400, {"error": "reasoning not supported"}),
        FakeResponse(
            200,
            {
                "output": [
                    {"type": "message", "content": "Please ship this once QA has approved it."},
                ],
            },
        ),
    ])

    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        calls.append({
            "method": method,
            "url": url,
            "json": json,
            "headers": headers,
            "timeout": timeout,
        })
        return next(responses)

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.1,
        reasoning_mode="off",
    )

    response = llm.invoke("Rewrite this politely.")

    assert response.content == "Please ship this once QA has approved it."
    assert calls[0]["json"]["reasoning"] == "off"
    assert "reasoning" not in calls[1]["json"]


def test_lmstudio_native_chat_disables_reasoning_after_first_rejection(monkeypatch):
    calls: list[dict[str, object]] = []

    responses = iter([
        FakeResponse(400, {"error": {"message": "Reasoning is not supported.", "param": "reasoning"}}),
        FakeResponse(200, {"output": [{"type": "message", "content": "First response."}]}),
        FakeResponse(200, {"output": [{"type": "message", "content": "Second response."}]}),
    ])

    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        calls.append({
            "method": method,
            "url": url,
            "json": json,
            "headers": headers,
            "timeout": timeout,
        })
        return next(responses)

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.1,
        reasoning_mode="off",
    )

    first = llm.invoke("First prompt")
    second = llm.invoke("Second prompt")

    assert first.content == "First response."
    assert second.content == "Second response."
    assert calls[0]["json"]["reasoning"] == "off"
    assert "reasoning" not in calls[1]["json"]
    assert "reasoning" not in calls[2]["json"]


def test_lmstudio_native_chat_resolves_placeholder_model_to_default_gemma_only(monkeypatch):
    calls: list[dict[str, object]] = []

    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        calls.append({
            "method": method,
            "url": url,
            "json": json,
            "headers": headers,
            "timeout": timeout,
        })
        if method == "GET":
            return FakeResponse(
                200,
                {
                    "models": [
                        {
                            "type": "llm",
                            "key": "google/gemma-4-e4b",
                            "display_name": "Gemma 4 E4B",
                            "capabilities": {"vision": True},
                            "loaded_instances": [{"id": "loaded"}],
                        },
                        {
                            "type": "llm",
                            "key": "qwen2.5-0.5b-instruct-mlx",
                            "display_name": "Qwen2.5 0.5B Instruct",
                            "trainedForToolUse": True,
                            "paramsString": "0.5B",
                            "maxContextLength": 32768,
                            "capabilities": {"vision": False},
                            "loaded_instances": [{"id": "loaded"}],
                        },
                    ]
                },
            )
        return FakeResponse(200, {"output": [{"type": "message", "content": "Local reply."}]})

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="local-model",
        temperature=0.0,
    )

    response = llm.invoke("Hello from local LM Studio.")

    assert response.content == "Local reply."
    assert calls[0] == {
        "method": "GET",
        "url": "http://localhost:1234/api/v1/models",
        "json": None,
        "headers": {"Content-Type": "application/json"},
        "timeout": 2.0,
    }
    assert calls[1]["json"]["model"] == "google/gemma-4-e4b"


def test_lmstudio_native_chat_placeholder_rejects_other_auto_discovered_models(monkeypatch):
    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        if method == "GET":
            return FakeResponse(
                200,
                {
                    "models": [
                        {
                            "type": "llm",
                            "key": "qwen2.5-0.5b-instruct-mlx",
                            "display_name": "Qwen2.5 0.5B Instruct",
                            "trainedForToolUse": True,
                            "paramsString": "0.5B",
                            "maxContextLength": 32768,
                            "capabilities": {"vision": False},
                            "loaded_instances": [{"id": "loaded"}],
                        },
                    ]
                },
            )
        raise AssertionError("Chat request should not run when Gemma 4 E4B is unavailable.")

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="local-model",
        temperature=0.0,
    )

    try:
        llm.invoke("Hello from local LM Studio.")
        raise AssertionError("Expected placeholder model resolution to fail without Gemma 4 E4B.")
    except RuntimeError as exc:
        assert "Gemma 4 E4B is the default LM Studio Smart model" in str(exc)


def test_lmstudio_native_chat_strips_leaked_thinking_blocks(monkeypatch):
    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        return FakeResponse(
            200,
            {
                "output": [
                    {"type": "message", "content": "<think>private chain of thought</think>\nFinal reply."},
                ],
            },
        )

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="qwen2.5-0.5b-instruct-mlx",
        temperature=0.0,
    )

    response = llm.invoke("Hello")

    assert response.content == "Final reply."


def test_lmstudio_native_chat_raises_actionable_error_when_server_is_unavailable(monkeypatch):
    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        raise requests.exceptions.ConnectionError("connection refused")

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="qwen2.5-0.5b-instruct-mlx",
        temperature=0.0,
    )

    try:
        llm.invoke("Hello")
        raise AssertionError("Expected a RuntimeError for unavailable LM Studio.")
    except RuntimeError as exc:
        assert "LM Studio local server is not reachable on port 1234" in str(exc)


def test_lmstudio_native_chat_extracts_nested_message_content(monkeypatch):
    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        return FakeResponse(
            200,
            {
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {"type": "output_text", "text": "Nested local reply."},
                        ],
                    }
                ]
            },
        )

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="qwen2.5-0.5b-instruct-mlx",
        temperature=0.0,
    )

    response = llm.invoke("Hello")

    assert response.content == "Nested local reply."


def test_lmstudio_native_chat_streams_message_deltas_and_chat_end(monkeypatch):
    calls: list[dict[str, object]] = []

    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        calls.append({
            "method": method,
            "url": url,
            "json": json,
            "headers": headers,
            "timeout": timeout,
            "stream": stream,
        })
        return FakeStreamingResponse(
            200,
            lines=[
                'data: {"choices":[{"delta":{"content":"Please ship this once "},"finish_reason":null}]}',
                '',
                'data: {"choices":[{"delta":{"content":"QA has approved it."},"finish_reason":null}]}',
                '',
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
                '',
                'data: [DONE]',
                '',
            ],
        )

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.1,
        max_tokens=192,
    )

    events = list(llm.stream("Rewrite this politely."))

    assert [event["event"] for event in events] == ["message.delta", "message.delta", "chat.end"]
    assert events[0]["data"]["content"] == "Please ship this once "
    assert events[-1]["data"]["result"]["choices"][0]["message"]["content"] == "Please ship this once QA has approved it."
    assert calls == [{
        "method": "POST",
        "url": "http://localhost:1234/v1/chat/completions",
        "json": {
            "model": "nvidia/nemotron-3-nano-4b",
            "messages": [{"role": "user", "content": "Rewrite this politely."}],
            "temperature": 0.1,
            "stream": True,
            "max_tokens": 192,
            "context_length": 8192,
        },
        "headers": {"Content-Type": "application/json"},
        "timeout": 30.0,
        "stream": True,
    }]


def test_lmstudio_native_chat_raises_clear_error_for_missing_model(monkeypatch):
    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        return FakeResponse(
            404,
            {
                "error": {
                    "message": "Invalid model identifier \"missing-model\".",
                    "param": "model",
                    "code": "model_not_found",
                }
            },
        )

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="missing-model",
        temperature=0.0,
    )

    try:
        llm.invoke("Hello")
        raise AssertionError("Expected a RuntimeError for a missing LM Studio model.")
    except RuntimeError as exc:
        assert "The selected LM Studio model 'missing-model' is not available." in str(exc)


def test_lmstudio_native_chat_auto_loads_selected_model_before_retry(monkeypatch):
    calls: list[dict[str, object]] = []
    request_responses = iter([
        FakeResponse(
            400,
            {
                "error": {
                    "message": "Failed to load model \"google/gemma-4-e4b\". Error: Failed to load model.",
                    "param": "model",
                }
            },
        ),
        FakeResponse(200, {"status": "loaded"}),
        FakeResponse(200, {"output": [{"type": "message", "content": "Loaded reply."}]}),
    ])

    def fake_request(method, url, json=None, headers=None, timeout=None, stream=None):
        calls.append({
            "method": method,
            "url": url,
            "json": json,
            "headers": headers,
            "timeout": timeout,
        })
        return next(request_responses)

    class CatalogResponse:
        status_code = 200

        @staticmethod
        def json():
            return {
                "models": [
                    {
                        "type": "llm",
                        "key": "google/gemma-4-e4b",
                        "display_name": "Gemma 4 E4B",
                        "paramsString": "4B",
                        "loaded_instances": [],
                        "capabilities": {"vision": True},
                    }
                ]
            }

    monkeypatch.setattr("providers.model_discovery.requests.get", lambda *args, **kwargs: CatalogResponse())

    monkeypatch.setattr("providers.lmstudio_native.requests.request", fake_request)

    llm = LMStudioNativeChat(
        model="google/gemma-4-e4b",
        temperature=0.0,
    )

    response = llm.invoke("Hello")

    assert response.content == "Loaded reply."
    assert calls[0]["url"] == "http://localhost:1234/v1/chat/completions"
    assert calls[1]["url"] == "http://localhost:1234/api/v1/models/load"
    assert calls[1]["json"]["model"] == "google/gemma-4-e4b"
    assert calls[1]["json"]["context_length"] == 8192
    assert calls[2]["url"] == "http://localhost:1234/v1/chat/completions"
