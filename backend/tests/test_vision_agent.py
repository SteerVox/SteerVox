import requests

from config.models import AppConfig
from vision_agent import VisionAgent


def test_vision_agent_uses_selected_lmstudio_model_when_it_supports_vision(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {
                "output": [
                    {
                        "type": "text",
                        "text": "Quarterly spreadsheet visible with totals and forecasts.",
                    }
                ]
            }

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["payload"] = json
        captured["headers"] = headers
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("vision_agent.requests.post", fake_post)
    monkeypatch.setattr(
        "vision_agent.ModelDiscovery.lmstudio_supports_vision",
        lambda model_id, require_loaded=False: model_id == "granite-vision",
    )
    monkeypatch.setattr(
        "vision_agent.ModelDiscovery.resolve_lmstudio_vision_model",
        lambda preferred=None, require_loaded=False, exclude_model_ids=None: preferred,
    )

    config = AppConfig.model_validate({
        "llm": {
            "provider": "lmstudio",
            "model": "granite-vision",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": None,
            "timeout_ms": 2500,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="Summarize this spreadsheet",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1600,
            "height": 900,
        },
        config=config,
    )

    assert summary == "Quarterly spreadsheet visible with totals and forecasts."
    assert captured["url"].endswith("/api/v1/chat")
    assert captured["payload"]["model"] == "granite-vision"
    assert captured["payload"]["input"][0] == {
        "type": "text",
        "content": "User request: 'Summarize this spreadsheet'. Summarize only the visible screen details relevant to answering it. Return a concise factual summary only.",
    }
    assert captured["payload"]["input"][1] == {
        "type": "image",
        "data_url": "data:image/jpeg;base64,abc123",
    }
    assert captured["payload"]["max_output_tokens"] == 96
    assert captured["timeout"] == 2.5


def test_vision_agent_falls_back_to_configured_vision_model_when_text_model_lacks_vision(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"output_text": "Shipping dashboard with delayed outbound lanes."}

    def fake_post(_url, json=None, headers=None, timeout=None):
        captured["payload"] = json
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("vision_agent.requests.post", fake_post)
    monkeypatch.setattr(
        "vision_agent.ModelDiscovery.lmstudio_supports_vision",
        lambda model_id, require_loaded=False: model_id == "granite-vision",
    )

    config = AppConfig.model_validate({
        "llm": {
            "provider": "lmstudio",
            "model": "nemotron-4b",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": "granite-vision",
            "timeout_ms": 1800,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="What is on this shipping screen?",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "xyz789",
            "width": 2000,
            "height": 1200,
        },
        config=config,
    )

    assert summary == "Shipping dashboard with delayed outbound lanes."
    assert captured["payload"]["model"] == "granite-vision"
    assert captured["timeout"] == 1.8


def test_vision_agent_logs_summary_excerpt(monkeypatch):
    log_messages = []

    class Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {
                "output_text": "Dashboard shows 14 open tasks, 3 overdue items, and a blocked release candidate."
            }

    monkeypatch.setattr("vision_agent.requests.post", lambda *_args, **_kwargs: Response())
    monkeypatch.setattr("vision_agent.ModelDiscovery.lmstudio_supports_vision", lambda _model_id, require_loaded=False: True)
    monkeypatch.setattr("vision_agent.logger.info", lambda message, *args: log_messages.append(message % args if args else message))

    config = AppConfig.model_validate({
        "llm": {
            "provider": "lmstudio",
            "model": "granite-vision",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": None,
            "timeout_ms": 2500,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="What is on this dashboard?",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1440,
            "height": 900,
        },
        config=config,
    )

    assert summary.startswith("Dashboard shows 14 open tasks")
    assert any("Local vision request model=granite-vision screenshot=1440x900 timeout_ms=2500" in entry for entry in log_messages)
    assert any("Local vision summary" in entry and "14 open tasks" in entry for entry in log_messages)


def test_vision_agent_logs_http_error_excerpt_and_fails_open(monkeypatch):
    log_messages = []

    class Response:
        status_code = 400
        text = '{"error":{"message":"bad image payload"}}'

        @staticmethod
        def json():
            return {}

    monkeypatch.setattr("vision_agent.requests.post", lambda *_args, **_kwargs: Response())
    monkeypatch.setattr("vision_agent.ModelDiscovery.lmstudio_supports_vision", lambda _model_id, require_loaded=False: True)
    monkeypatch.setattr("vision_agent.logger.info", lambda message, *args: log_messages.append(message % args if args else message))

    config = AppConfig.model_validate({
        "llm": {
            "provider": "lmstudio",
            "model": "granite-vision",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": None,
            "timeout_ms": 2500,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="What is on this page?",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1440,
            "height": 900,
        },
        config=config,
    )

    assert summary == ""
    assert any("Local vision request failed with HTTP 400" in entry for entry in log_messages)
    assert any("bad image payload" in entry for entry in log_messages)


def test_vision_agent_classifies_failed_to_process_image_as_decode_failure(monkeypatch):
    log_messages = []

    class Response:
        status_code = 500
        text = '{ "error": { "message": "failed to process image", "type": "internal_error" } }'

        @staticmethod
        def json():
            return {}

    monkeypatch.setattr("vision_agent.requests.post", lambda *_args, **_kwargs: Response())
    monkeypatch.setattr("vision_agent.ModelDiscovery.lmstudio_supports_vision", lambda _model_id, require_loaded=False: True)
    monkeypatch.setattr("vision_agent.logger.info", lambda message, *args: log_messages.append(message % args if args else message))

    config = AppConfig.model_validate({
        "llm": {
            "provider": "lmstudio",
            "model": "granite-vision",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": None,
            "timeout_ms": 2500,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="What is on this screen?",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 640,
            "height": 360,
        },
        config=config,
    )

    assert summary == ""
    assert any("Classification=vision_decode_failure" in entry for entry in log_messages)


def test_vision_agent_truncates_long_transcript_in_prompt(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"output_text": "Visible Kanban board with delayed items."}

    def fake_post(_url, json=None, headers=None, timeout=None):
        captured["payload"] = json
        return Response()

    monkeypatch.setattr("vision_agent.requests.post", fake_post)
    monkeypatch.setattr("vision_agent.ModelDiscovery.lmstudio_supports_vision", lambda _model_id, require_loaded=False: True)

    config = AppConfig.model_validate({
        "llm": {
            "provider": "lmstudio",
            "model": "granite-vision",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": None,
            "timeout_ms": 2500,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="Review this release dashboard and tell me which three workstreams are blocked by deployment, legal, and QA signoff before tomorrow morning because the team is waiting on final approval.",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1440,
            "height": 900,
        },
        config=config,
    )

    assert summary == "Visible Kanban board with delayed items."
    prompt = captured["payload"]["input"][0]["content"]
    assert "Return a concise factual summary only." in prompt
    assert len(prompt) < 320


def test_vision_agent_fails_open_when_local_vision_times_out(monkeypatch):
    monkeypatch.setattr(
        "vision_agent.ModelDiscovery.lmstudio_supports_vision",
        lambda model_id, require_loaded=False: model_id == "granite-vision",
    )
    monkeypatch.setattr("vision_agent.requests.post", lambda *_args, **_kwargs: (_ for _ in ()).throw(requests.exceptions.Timeout("slow")))

    config = AppConfig.model_validate({
        "vision": {
            "enabled": True,
            "model": "granite-vision",
            "timeout_ms": 900,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="What is this?",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1200,
            "height": 800,
        },
        config=config,
    )

    assert summary == ""


def test_vision_agent_logs_when_no_model_is_available(monkeypatch):
    log_messages = []
    monkeypatch.setattr(
        "vision_agent.ModelDiscovery.lmstudio_supports_vision",
        lambda _model_id, require_loaded=False: False,
    )
    monkeypatch.setattr("vision_agent.logger.info", lambda message, *args: log_messages.append(message % args if args else message))

    config = AppConfig.model_validate({
        "llm": {
            "provider": "lmstudio",
            "model": "nemotron-4b",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": None,
            "timeout_ms": 2500,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="What is on this screen?",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1200,
            "height": 800,
        },
        config=config,
    )

    assert summary == ""
    assert "Local vision skipped because no vision-capable LM Studio model is available." in log_messages


def test_vision_agent_does_not_auto_fallback_to_other_lmstudio_models(monkeypatch):
    log_messages = []
    request_count = {"value": 0}
    monkeypatch.setattr("vision_agent.requests.post", lambda *_args, **_kwargs: request_count.__setitem__("value", request_count["value"] + 1))
    monkeypatch.setattr(
        "vision_agent.ModelDiscovery.lmstudio_supports_vision",
        lambda model_id, require_loaded=False: (
            model_id == "broken-vision" and not require_loaded
        ) or model_id == "loaded-vision"
    )
    monkeypatch.setattr("vision_agent.ensure_lmstudio_model_loaded", lambda *args, **kwargs: False)
    monkeypatch.setattr("vision_agent.logger.info", lambda message, *args: log_messages.append(message % args if args else message))

    config = AppConfig.model_validate({
        "llm": {
            "provider": "openai",
            "model": "gpt-4o",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": "broken-vision",
            "timeout_ms": 2500,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="Summarize this screen",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 640,
            "height": 360,
        },
        config=config,
    )

    assert summary == ""
    assert request_count["value"] == 0
    assert any("Configured vision model broken-vision is listed in LM Studio but could not be auto-loaded." in entry for entry in log_messages)
    assert any("Vision will stay pinned to the selected/configured model set." in entry for entry in log_messages)


def test_vision_agent_classifies_failed_to_load_model_as_unavailable(monkeypatch):
    log_messages = []

    class Response:
        status_code = 400
        text = '{ "error": { "message": "Failed to load model \\"broken-vision\\". Error: Failed to load model.", "type": "invalid_request", "param": "model" } }'

        @staticmethod
        def json():
            return {}

    monkeypatch.setattr("vision_agent.requests.post", lambda *_args, **_kwargs: Response())
    monkeypatch.setattr(
        "vision_agent.ModelDiscovery.lmstudio_supports_vision",
        lambda model_id, require_loaded=False: model_id == "broken-vision",
    )
    monkeypatch.setattr("vision_agent.logger.info", lambda message, *args: log_messages.append(message % args if args else message))

    config = AppConfig.model_validate({
        "llm": {
            "provider": "openai",
            "model": "gpt-4o",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": "broken-vision",
            "timeout_ms": 2500,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="What is on this screen?",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 640,
            "height": 360,
        },
        config=config,
    )

    assert summary == ""
    assert any("Classification=vision_model_unavailable" in entry for entry in log_messages)


def test_vision_agent_auto_loads_selected_model_before_request(monkeypatch):
    captured = {}

    class Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"output_text": "Inbox with customer escalations and open tabs."}

    def fake_post(_url, json=None, headers=None, timeout=None):
        captured["payload"] = json
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("vision_agent.requests.post", fake_post)
    monkeypatch.setattr(
        "vision_agent.ModelDiscovery.lmstudio_supports_vision",
        lambda model_id, require_loaded=False: model_id == "google/gemma-4-e4b",
    )
    monkeypatch.setattr("vision_agent.ensure_lmstudio_model_loaded", lambda *args, **kwargs: True)

    config = AppConfig.model_validate({
        "llm": {
            "provider": "openai",
            "model": "gpt-4o",
            "temperature": 0.0,
        },
        "vision": {
            "enabled": True,
            "model": "google/gemma-4-e4b",
            "timeout_ms": 2000,
        },
    })

    summary = VisionAgent().summarize_screen(
        transcript="What is on this screen?",
        screen_capture={
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1280,
            "height": 720,
        },
        config=config,
    )

    assert summary == "Inbox with customer escalations and open tabs."
    assert captured["payload"]["model"] == "google/gemma-4-e4b"
    assert captured["timeout"] == 2.0
