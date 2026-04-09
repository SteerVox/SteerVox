import importlib
import json
import sys
from unittest.mock import patch

from fastapi.testclient import TestClient
from inbox import build_inbox_note


class AuthenticatedAppWrapper:
    def __init__(self, app, headers: dict[str, str]):
        self._app = app
        self._header_pairs = [
            (name.lower().encode("latin-1"), value.encode("latin-1"))
            for name, value in headers.items()
        ]

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") == "/health":
            await self._app(scope, receive, send)
            return

        existing_names = {name for name, _value in scope.get("headers", [])}
        merged_headers = list(scope.get("headers", []))
        for name, value in self._header_pairs:
            if name not in existing_names:
                merged_headers.append((name, value))

        next_scope = dict(scope)
        next_scope["headers"] = merged_headers
        await self._app(next_scope, receive, send)


def load_server():
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    server = importlib.reload(server)
    server.raw_app = server.app
    server.app = AuthenticatedAppWrapper(server.raw_app, server.get_local_api_test_headers())
    return server


def read_sse_event(lines) -> dict:
    event_name = "message"
    data_lines: list[str] = []

    for line in lines:
        if line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip()
            continue
        if line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].strip())
            continue
        if not line.strip():
            break

    payload = json.loads("".join(data_lines))
    payload["event_name"] = event_name
    return payload


def test_local_api_auth_rejects_missing_token():
    server = load_server()
    client = TestClient(server.raw_app)

    response = client.get("/config")
    assert response.status_code == 401
    assert response.json()["detail"] == "Missing or invalid local API token."


def test_health_remains_available_without_local_api_token():
    server = load_server()
    client = TestClient(server.raw_app)

    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_runtime_events_require_local_api_token():
    server = load_server()
    client = TestClient(server.raw_app)

    with client.stream("GET", "/events/runtime?max_events=1") as response:
        assert response.status_code == 401
        response.read()
        assert response.json()["detail"] == "Missing or invalid local API token."


def test_config_ignores_removed_runtime_hotkey_fields(isolated_steervox_home):
    config_file = isolated_steervox_home / "config.json"
    config_file.parent.mkdir(parents=True, exist_ok=True)
    config_file.write_text(json.dumps({
        "stt": {"provider": "groq", "model": "whisper-large-v3", "language": "en"},
        "llm": {"provider": "groq", "model": "llama3-70b-8192", "temperature": 0.0},
        "hotkeys": {
            "trigger_dictation": "<ctrl>+d",
            "trigger_smart_agent": "<ctrl>+t",
            "default_skill_id": "system_dictation",
        },
        "audio": {"input_device": None, "input_device_id": None, "input_device_label": None},
        "debug": {"log_sensitive_transcripts": False, "persist_recordings": False},
    }))

    server = load_server()
    client = TestClient(server.app)

    response = client.get("/config")
    assert response.status_code == 200
    payload = response.json()
    assert payload["llm"]["routing"]["provider"] == "lmstudio"
    assert payload["llm"]["routing"]["model"] == "local-model"
    assert payload["hotkeys"] == {
        "default_skill_id": "system_dictation",
        "app_skill_defaults": [],
    }
    assert payload["audio"]["enable_recording_cues"] is False
    assert payload["stt"]["language_mode"] == "fixed"
    assert payload["stt"]["preferred_languages"] == ["en"]
    assert payload["privacy"]["restore_clipboard_after_paste"] is True
    assert payload["privacy"]["sensitive_targets"] == []


def test_default_config_prefers_local_defaults(isolated_steervox_home):
    server = load_server()
    client = TestClient(server.app)

    response = client.get("/config")
    assert response.status_code == 200
    payload = response.json()
    assert payload["stt"]["provider"] == "mlx-whisper"
    assert payload["stt"]["model"] == "mlx-community/whisper-large-v3-turbo"
    assert payload["llm"]["provider"] == "lmstudio"
    assert payload["llm"]["model"] == "local-model"
    assert payload["llm"]["routing"]["provider"] == "lmstudio"
    assert payload["llm"]["routing"]["model"] == "local-model"
    assert payload["domains"] == {
        "mode": "off",
        "app_domain_defaults": [],
    }
    assert payload["stt"]["language_mode"] == "fixed"
    assert payload["stt"]["preferred_languages"] == ["en"]
    assert payload["privacy"]["restore_clipboard_after_paste"] is True


def test_config_uses_launch_default_for_experimental_media_controls(monkeypatch):
    monkeypatch.setenv("STEERVOX_DEFAULT_EXPERIMENTAL_MEDIA_CONTROLS", "1")
    server = load_server()
    client = TestClient(server.app)

    response = client.get("/config")
    assert response.status_code == 200
    payload = response.json()
    assert payload["actions"]["experimental_media_controls"] is True


def test_saved_experimental_media_setting_is_preserved_over_launch_default(
    isolated_steervox_home,
    monkeypatch,
):
    config_file = isolated_steervox_home / "config.json"
    config_file.parent.mkdir(parents=True, exist_ok=True)
    config_file.write_text(json.dumps({
        "actions": {
            "enabled": True,
            "auto_approve_reviewed": False,
            "experimental_media_controls": False,
        },
    }))
    monkeypatch.setenv("STEERVOX_DEFAULT_EXPERIMENTAL_MEDIA_CONTROLS", "1")

    server = load_server()
    client = TestClient(server.app)

    response = client.get("/config")
    assert response.status_code == 200
    payload = response.json()
    assert payload["actions"]["experimental_media_controls"] is False


def test_config_serializes_app_skill_defaults():
    server = load_server()
    client = TestClient(server.app)

    update_response = client.post("/config", json={
        "hotkeys": {
            "app_skill_defaults": [
                {
                    "id": "slack_rule",
                    "app_label": "Slack",
                    "bundle_id": "com.tinyspeck.slackmacgap",
                    "url_host": None,
                    "app_name": "Slack",
                    "skill_id": "system_dictation",
                    "enabled": True,
                }
            ]
        }
    })
    assert update_response.status_code == 200

    config_response = client.get("/config")
    assert config_response.status_code == 200
    payload = config_response.json()
    assert payload["hotkeys"]["app_skill_defaults"] == [
        {
            "id": "slack_rule",
            "app_label": "Slack",
            "bundle_id": "com.tinyspeck.slackmacgap",
            "url_host": None,
            "app_name": "Slack",
            "skill_id": "system_dictation",
            "enabled": True,
        }
    ]


def test_config_serializes_domain_defaults():
    server = load_server()
    client = TestClient(server.app)

    update_response = client.post("/config", json={
        "domains": {
            "mode": "auto",
            "app_domain_defaults": [
                {
                    "id": "shipping_rule",
                    "app_label": "project44",
                    "bundle_id": None,
                    "url_host": "project44.com",
                    "app_name": "Google Chrome",
                    "domain_id": "shipping",
                    "enabled": True,
                }
            ],
        }
    })
    assert update_response.status_code == 200

    config_response = client.get("/config")
    assert config_response.status_code == 200
    payload = config_response.json()
    assert payload["domains"] == {
        "mode": "auto",
        "app_domain_defaults": [
            {
                "id": "shipping_rule",
                "app_label": "project44",
                "bundle_id": None,
                "url_host": "project44.com",
                "app_name": "Google Chrome",
                "domain_id": "shipping",
                "enabled": True,
            }
        ],
    }


def test_config_serializes_privacy_rules_and_language_preferences():
    server = load_server()
    client = TestClient(server.app)

    update_response = client.post("/config", json={
        "stt": {
            "language_mode": "auto",
            "preferred_languages": ["en", "hi"],
        },
        "privacy": {
            "restore_clipboard_after_paste": False,
            "minimize_sensitive_context": True,
            "sensitive_targets": [
                {
                    "id": "epic_sensitive",
                    "app_label": "Epic",
                    "bundle_id": "com.epic.hyperspace",
                    "url_host": None,
                    "app_name": "Epic",
                    "mode": "minimize_context",
                    "enabled": True,
                }
            ],
        },
    })
    assert update_response.status_code == 200

    config_response = client.get("/config")
    assert config_response.status_code == 200
    payload = config_response.json()
    assert payload["stt"]["language_mode"] == "auto"
    assert payload["stt"]["preferred_languages"] == ["en", "hi"]
    assert payload["privacy"] == {
        "restore_clipboard_after_paste": False,
        "minimize_sensitive_context": True,
        "sensitive_targets": [
            {
                "id": "epic_sensitive",
                "app_label": "Epic",
                "bundle_id": "com.epic.hyperspace",
                "url_host": None,
                "app_name": "Epic",
                "mode": "minimize_context",
                "enabled": True,
            }
        ],
    }


def test_config_update_skips_engine_restart_for_hotkey_only_changes():
    server = load_server()
    client = TestClient(server.app)
    engine_before = server.engine

    response = client.post("/config", json={
        "hotkeys": {
            "default_skill_id": "system_grammar",
            "app_skill_defaults": [],
        }
    })

    assert response.status_code == 200
    assert server.engine is engine_before


def test_config_update_restarts_engine_for_llm_changes():
    server = load_server()
    client = TestClient(server.app)
    engine_before = server.engine

    response = client.post("/config", json={
        "llm": {
            "provider": "groq",
            "model": "llama3-8b-8192",
            "temperature": 0.0,
            "routing": {
                "enabled": True,
                "provider": "groq",
                "model": "llama-3.1-8b-instant",
                "temperature": 0.0,
            },
        }
    })

    assert response.status_code == 200
    assert server.engine is not engine_before


def test_status_and_skills_expose_new_contract_and_telemetry_fields():
    server = load_server()
    client = TestClient(server.app)

    skills_response = client.get("/skills")
    assert skills_response.status_code == 200
    first_skill = skills_response.json()["skills"][0]
    assert "fallback_behavior" in first_skill
    assert "output_mode" in first_skill
    assert "triggers" in first_skill

    status_response = client.get("/status")
    assert status_response.status_code == 200
    payload = status_response.json()
    assert "last_smart_run" in payload
    assert payload["last_smart_run"] is None
    assert "pending_paste_text" in payload
    assert "pending_paste" in payload
    assert payload["pending_paste"] is None
    assert "pending_notification" in payload
    assert payload["pending_notification"] is None
    assert payload["recording_cues_enabled"] is False
    assert payload["restore_clipboard_after_paste"] is True
    assert "active_domain" in payload
    assert payload["active_domain"] is None


def test_status_exposes_resolved_active_domain_metadata():
    server = load_server()
    client = TestClient(server.app)

    client.post("/config", json={
        "domains": {
            "mode": "shipping",
        }
    })
    server.engine.captured_context = {"app_name": "Notes"}

    status_response = client.get("/status")
    assert status_response.status_code == 200
    assert status_response.json()["active_domain"] == {
        "id": "shipping",
        "label": "Shipping / Logistics",
        "source": "global_pin",
        "rule_id": None,
        "rule_label": None,
    }


def test_status_acknowledges_tokenized_pending_paste():
    server = load_server()
    client = TestClient(server.app)

    server.engine.pending_paste = {"id": "paste-1", "text": "hello world"}
    server.engine.pending_paste_text = "hello world"

    status_response = client.get("/status")
    assert status_response.status_code == 200
    assert status_response.json()["pending_paste"] == {
        "id": "paste-1",
        "text": "hello world",
        "restore_clipboard_after_paste": True,
    }

    ack_response = client.post("/status/paste/ack", json={"id": "paste-1", "result": "copied"})
    assert ack_response.status_code == 200
    assert ack_response.json()["status"] == "success"
    assert server.engine.pending_paste is None
    assert server.engine.pending_paste_text is None


def test_status_exposes_active_smart_preview_state():
    server = load_server()
    client = TestClient(server.app)

    server.engine.smart_preview = {
        "run_id": "preview-1",
        "mode": "smart_transform",
        "state": "streaming",
        "text": "Please ship this once QA",
        "final_text": None,
        "error": None,
        "updated_at": "2026-03-28T00:00:00.000Z",
    }

    status_response = client.get("/status")

    assert status_response.status_code == 200
    assert status_response.json()["smart_preview"] == server.engine.smart_preview


def test_status_exposes_pending_action_review_state():
    server = load_server()
    client = TestClient(server.app)

    server.engine.pending_action_review = {
        "run_id": "review-1",
        "action_type": "open_url",
        "title": "Open URL",
        "summary": "Open https://example.com in the default browser.",
        "script": 'open location "https://example.com"',
        "language": "applescript",
        "status": "pending",
        "error": None,
    }

    status_response = client.get("/status")

    assert status_response.status_code == 200
    assert status_response.json()["pending_action_review"] == server.engine.pending_action_review


def test_status_exposes_live_transcription_state():
    server = load_server()
    client = TestClient(server.app)

    server.live_transcription_manager._state = {
        "session_id": "live-1",
        "mode": "dictation",
        "state": "streaming",
        "text": "hello world",
        "source": "local",
        "is_final": False,
        "updated_at": "2026-04-02T12:00:00.000Z",
        "error": None,
    }

    status_response = client.get("/status")

    assert status_response.status_code == 200
    assert status_response.json()["live_transcription"] == server.live_transcription_manager.state


def test_process_recording_forwards_screen_capture_to_engine(monkeypatch):
    server = load_server()
    client = TestClient(server.app)
    captured = {}

    monkeypatch.setattr(server.app_state, "write_uploaded_wav", lambda _audio_base64: "/tmp/test.wav")

    def fake_start_processing(wav_path, **kwargs):
        captured["wav_path"] = wav_path
        captured["kwargs"] = kwargs

    monkeypatch.setattr(server.engine, "start_processing", fake_start_processing)

    response = client.post("/recording/process", json={
        "mode": "smart_transform",
        "audio_base64": "UklGRg==",
        "screen_capture": {
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1600,
            "height": 900,
        },
        "capture_timeline": {
            "button_down": "2026-04-02T12:00:00.000Z",
            "capture_started": "2026-04-02T12:00:00.050Z",
        },
        "streaming_transcript": "hello there",
        "streaming_source": "local",
        "live_transcription_session_id": "live-1",
    })

    assert response.status_code == 200
    assert captured["wav_path"] == "/tmp/test.wav"
    assert captured["kwargs"]["screen_capture"] == {
        "mime_type": "image/jpeg",
        "image_base64": "abc123",
        "width": 1600,
        "height": 900,
    }
    assert captured["kwargs"]["capture_timeline"] == {
        "button_down": "2026-04-02T12:00:00.000Z",
        "capture_started": "2026-04-02T12:00:00.050Z",
    }
    assert captured["kwargs"]["streaming_transcript"] == "hello there"
    assert captured["kwargs"]["streaming_source"] == "local"


def test_live_transcription_endpoints_delegate_to_manager():
    server = load_server()
    client = TestClient(server.app)

    with patch.object(server.live_transcription_manager, "start_session", return_value={
        "session_id": "live-1",
        "mode": "dictation",
        "state": "starting",
        "text": "",
        "source": "local",
        "is_final": False,
        "updated_at": "2026-04-02T12:00:00.000Z",
        "error": None,
    }) as start_session:
        response = client.post("/live_transcription/start", json={
            "session_id": "live-1",
            "mode": "dictation",
        })
    assert response.status_code == 200
    assert response.json()["live_transcription"]["state"] == "starting"
    start_session.assert_called_once_with(session_id="live-1", mode="dictation")

    with patch.object(server.live_transcription_manager, "append_chunk", return_value=True) as append_chunk:
        response = client.post("/live_transcription/chunk", json={
            "session_id": "live-1",
            "sample_rate": 16000,
            "pcm_s16le_base64": "AQI=",
        })
    assert response.status_code == 200
    assert response.json() == {"status": "accepted"}
    append_chunk.assert_called_once_with(session_id="live-1", sample_rate=16000, pcm_s16le_base64="AQI=")

    with patch.object(server.live_transcription_manager, "finish_session", return_value={
        "session_id": "live-1",
        "transcript": "hello world",
        "source": "local",
        "first_partial_at": "2026-04-02T12:00:00.500Z",
        "error": None,
    }) as finish_session:
        response = client.post("/live_transcription/finish", json={
            "session_id": "live-1",
        })
    assert response.status_code == 200
    assert response.json()["transcript"] == "hello world"
    finish_session.assert_called_once_with(session_id="live-1")


def test_refresh_provider_models_clears_lmstudio_cache_and_bumps_revision():
    server = load_server()
    client = TestClient(server.app)

    with patch.object(server.ModelDiscovery, "clear_cache") as clear_cache:
        response = client.post("/providers/models/refresh", json={"provider": "lmstudio"})

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["provider"] == "lmstudio"
    clear_cache.assert_called_once_with("lmstudio")


def test_review_action_endpoints_delegate_to_engine():
    server = load_server()
    client = TestClient(server.app)

    server.engine.pending_action_review = {
        "run_id": "review-1",
        "action_type": "open_url",
        "title": "Open URL",
        "summary": "Open https://example.com in the default browser.",
        "script": 'open location "https://example.com"',
        "language": "applescript",
        "status": "pending",
        "error": None,
    }

    with patch.object(server.engine, "approve_pending_action_review", return_value={
        "status": "approved",
        "run_id": "review-1",
        "action_type": "open_url",
    }) as approve:
        response = client.post("/actions/review/approve", json={"run_id": "review-1"})
    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    approve.assert_called_once_with("review-1")

    with patch.object(server.engine, "reject_pending_action_review", return_value=True) as reject:
        response = client.post("/actions/review/reject", json={"run_id": "review-1"})
    assert response.status_code == 200
    assert response.json() == {"status": "rejected", "run_id": "review-1"}
    reject.assert_called_once_with("review-1")


def test_runtime_events_stream_initial_snapshot():
    server = load_server()
    client = TestClient(server.app)

    with client.stream("GET", "/events/runtime?max_events=1") as response:
        assert response.status_code == 200
        lines = response.iter_lines()
        event = read_sse_event(lines)

    assert event["event_name"] == "snapshot"
    assert event["type"] == "snapshot"
    assert "status" in event["data"]
    assert "config" in event["data"]
    assert "usage" in event["data"]
    assert "revisions" in event["data"]


def test_runtime_events_publish_skill_invalidations():
    server = load_server()
    client = TestClient(server.app)

    with patch.object(server.runtime_event_broker, "publish", wraps=server.runtime_event_broker.publish) as publish:
        create_response = client.post("/skills", json={
            "id": "custom_runtime_event_test",
            "name": "Runtime Event Test",
            "prompt": "## Purpose\nReturn the final text.\n",
            "triggers": [],
            "target_types": [],
            "max_chars": None,
            "style": None,
            "fallback_behavior": "selected_skill",
            "output_mode": "plain_text",
        })
        assert create_response.status_code == 200

    invalidation = next(
        (call for call in publish.call_args_list if call.args and call.args[0] == "skills_invalidated"),
        None,
    )
    assert invalidation is not None
    assert invalidation.args[1]["skill_id"] == "custom_runtime_event_test"
    assert invalidation.args[1]["revision"] >= 1


def test_runtime_events_publish_config_changes():
    server = load_server()
    client = TestClient(server.app)

    with patch.object(server.runtime_event_broker, "publish", wraps=server.runtime_event_broker.publish) as publish:
        update_response = client.post("/config", json={
            "hotkeys": {
                "default_skill_id": "system_grammar",
                "app_skill_defaults": [],
            }
        })
        assert update_response.status_code == 200

    config_event = next(
        (call for call in publish.call_args_list if call.args and call.args[0] == "config_changed"),
        None,
    )
    assert config_event is not None
    assert config_event.args[1]["config"]["hotkeys"]["default_skill_id"] == "system_grammar"
    assert config_event.args[1]["revision"] >= 1


def test_skills_diagnostics_and_update_endpoints(isolated_steervox_home):
    broken_dir = isolated_steervox_home / "skills" / "broken_template"
    broken_dir.mkdir(parents=True, exist_ok=True)
    (broken_dir / "SKILL.md").write_text("---\nid: broken_template\nname: Broken template\n---\n", encoding="utf-8")

    server = load_server()
    client = TestClient(server.app)

    create_response = client.post("/skills", json={
        "id": "custom_reply",
        "name": "Custom Reply",
        "prompt": "Draft a reply.",
        "description": "Original version",
    })
    assert create_response.status_code == 200

    update_response = client.put("/skills/custom_reply", json={
        "id": "custom_reply",
        "name": "Custom Reply",
        "prompt": "## Purpose\nDraft a more polished reply.\n\n## Output Contract\nReturn plain text only.",
        "description": "Updated version",
        "output_mode": "plain_text",
    })
    assert update_response.status_code == 200

    diagnostics_response = client.get("/skills/diagnostics")
    assert diagnostics_response.status_code == 200
    diagnostics = diagnostics_response.json()["items"]
    assert any(
        item["id"] == "broken_template"
        and "must include markdown instructions" in item["message"]
        for item in diagnostics
    )

    skills_response = client.get("/skills")
    assert skills_response.status_code == 200
    updated = next(skill for skill in skills_response.json()["skills"] if skill["id"] == "custom_reply")
    assert updated["description"] == "Updated version"
    assert "Draft a more polished reply." in updated["prompt"]


def test_domain_endpoints_list_import_and_export():
    server = load_server()
    client = TestClient(server.app)

    list_response = client.get("/domains")
    assert list_response.status_code == 200
    packs = list_response.json()["packs"]
    assert {pack["id"] for pack in packs} == {"shipping", "medical"}
    details = list_response.json()["details"]
    assert {pack["id"] for pack in details} == {"shipping", "medical"}
    assert all("effective" in pack for pack in details)
    assert all("overlay" in pack for pack in details)
    assert all("controls" in pack["effective"] for pack in details)
    assert all("controls" in pack["overlay"] for pack in details)

    import_response = client.post("/domains/import", json={
        "domain_id": "shipping",
        "overlay": {
            "id": "shipping",
            "label": "Shipping",
            "description": "Shipping and logistics workflows.",
            "documentation_only": False,
            "default_intent": "shipment_update",
            "glossary": [
                {
                    "term": "Blue Anchor Lines",
                    "aliases": ["blue anchor"],
                    "kind": "carrier",
                    "priority": 8,
                }
            ],
            "templates": [],
            "examples": [],
            "styles": {
                "tone": "concise",
            },
            "controls": {
                "default_format": "table",
                "default_surface_behavior": "summary",
                "suppress_external_text": False,
                "minimize_context_capture": False,
                "tone": "concise",
                "audience": "operations",
            },
        },
    })
    assert import_response.status_code == 200
    assert import_response.json()["pack"]["overlay_present"] is True

    export_response = client.get("/domains/export/shipping")
    assert export_response.status_code == 200
    exported = export_response.json()
    assert exported["domain_id"] == "shipping"
    assert exported["overlay"]["glossary"][0]["term"] == "Blue Anchor Lines"
    assert exported["overlay"]["styles"] == {"tone": "concise"}
    assert exported["overlay"]["controls"]["default_format"] == "table"

    refreshed = client.get("/domains")
    assert refreshed.status_code == 200
    shipping = next(pack for pack in refreshed.json()["details"] if pack["id"] == "shipping")
    assert shipping["overlay"]["glossary"] == [
        {
            "term": "Blue Anchor Lines",
            "aliases": ["blue anchor"],
            "kind": "carrier",
            "priority": 8,
        }
    ]
    assert any(entry["term"] == "Blue Anchor Lines" for entry in shipping["effective"]["glossary"])


def test_clear_status_clears_pending_paste_and_notification():
    server = load_server()
    client = TestClient(server.app)

    server.engine.pending_paste_text = "ready"
    server.engine.pending_notification = {"title": "Saved to Inbox", "body": None}

    response = client.post("/status/clear_paste")
    assert response.status_code == 200
    assert server.engine.pending_paste_text is None
    assert server.engine.pending_notification is None


def test_status_repairs_impossible_preparing_paste_state():
    server = load_server()
    client = TestClient(server.app)

    server.engine._set_phase("preparing_paste")
    server.engine._is_processing = False
    server.engine.pending_paste = None
    server.engine.pending_paste_text = None
    server.engine.pending_notification = None

    response = client.get("/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["phase"] == "ready"
    assert payload["pending_paste"] is None
    assert payload["pending_notification"] is None


def test_secret_delete_removes_stored_key():
    server = load_server()
    client = TestClient(server.app)

    initial_status = client.get("/secrets/check")
    assert initial_status.status_code == 200
    assert "gemini" in initial_status.json()
    assert "nvidia" in initial_status.json()
    assert "sarvam" in initial_status.json()

    save_response = client.post("/secrets", json={"provider": "groq", "key": "test-key"})
    assert save_response.status_code == 200
    assert client.get("/secrets/check").json()["groq"] is True

    delete_response = client.delete("/secrets/groq")
    assert delete_response.status_code == 200
    assert client.get("/secrets/check").json()["groq"] is False


def test_secret_updates_clear_model_discovery_cache():
    server = load_server()
    client = TestClient(server.app)

    with patch.object(server.ModelDiscovery, "clear_cache") as clear_cache:
        save_response = client.post("/secrets", json={"provider": "gemini", "key": "test-key"})
        assert save_response.status_code == 200
        clear_cache.assert_called_once_with("gemini")

    with patch.object(server.ModelDiscovery, "clear_cache") as clear_cache:
        delete_response = client.delete("/secrets/gemini")
        assert delete_response.status_code == 200
        clear_cache.assert_called_once_with("gemini")


def test_cors_allows_loopback_origins_and_rejects_non_local_origins():
    server = load_server()
    client = TestClient(server.app)

    allowed = client.options("/config", headers={
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
    })
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"

    blocked = client.options("/config", headers={
        "Origin": "https://example.com",
        "Access-Control-Request-Method": "GET",
    })
    assert blocked.status_code == 400
    assert "access-control-allow-origin" not in blocked.headers


def test_status_does_not_require_key_for_lmstudio_llm():
    server = load_server()
    client = TestClient(server.app)

    save_response = client.post("/secrets", json={"provider": "groq", "key": "stt-key"})
    assert save_response.status_code == 200

    config_response = client.post("/config", json={
        "stt": {"provider": "groq", "model": "whisper-large-v3", "language": "en"},
        "llm": {"provider": "lmstudio", "model": "local-model", "temperature": 0.0},
    })
    assert config_response.status_code == 200

    status = client.get("/status")
    assert status.status_code == 200
    assert status.json()["missing_api_keys"] is False


def test_status_requires_key_for_gemini_llm():
    server = load_server()
    client = TestClient(server.app)

    save_response = client.post("/secrets", json={"provider": "groq", "key": "stt-key"})
    assert save_response.status_code == 200

    config_response = client.post("/config", json={
        "stt": {"provider": "groq", "model": "whisper-large-v3", "language": "en"},
        "llm": {"provider": "gemini", "model": "gemini-2.5-flash", "temperature": 0.0},
    })
    assert config_response.status_code == 200

    status = client.get("/status")
    assert status.status_code == 200
    assert status.json()["missing_api_keys"] is True


def test_status_requires_key_for_nvidia_llm():
    server = load_server()
    client = TestClient(server.app)

    save_response = client.post("/secrets", json={"provider": "groq", "key": "stt-key"})
    assert save_response.status_code == 200

    config_response = client.post("/config", json={
        "stt": {"provider": "groq", "model": "whisper-large-v3", "language": "en"},
        "llm": {"provider": "nvidia", "model": "moonshotai/kimi-k2-instruct-0905", "temperature": 0.0},
    })
    assert config_response.status_code == 200

    status = client.get("/status")
    assert status.status_code == 200
    assert status.json()["missing_api_keys"] is True


def test_status_requires_key_for_sarvam_stt():
    server = load_server()
    client = TestClient(server.app)

    save_response = client.post("/secrets", json={"provider": "groq", "key": "llm-key"})
    assert save_response.status_code == 200

    config_response = client.post("/config", json={
        "stt": {"provider": "sarvam", "model": "saaras:v3", "language": "en"},
        "llm": {"provider": "groq", "model": "llama3-70b-8192", "temperature": 0.0},
    })
    assert config_response.status_code == 200

    status = client.get("/status")
    assert status.status_code == 200
    assert status.json()["missing_api_keys"] is True


def test_status_does_not_require_key_for_mlx_whisper_stt():
    server = load_server()
    client = TestClient(server.app)

    save_response = client.post("/secrets", json={"provider": "groq", "key": "llm-key"})
    assert save_response.status_code == 200

    config_response = client.post("/config", json={
        "stt": {"provider": "mlx-whisper", "model": "mlx-community/whisper-base-mlx", "language": "en"},
        "llm": {"provider": "groq", "model": "llama3-70b-8192", "temperature": 0.0},
    })
    assert config_response.status_code == 200

    status = client.get("/status")
    assert status.status_code == 200
    assert status.json()["missing_api_keys"] is False


def test_status_includes_local_stt_payload_for_mlx_whisper(monkeypatch):
    server = load_server()
    client = TestClient(server.app)

    monkeypatch.setattr("api.state.build_local_stt_status", lambda provider, selected_model: {
        "runtime_mode": "bundled",
        "runtime_ready": True,
        "ffmpeg_available": True,
        "ffmpeg_source": "bundled",
        "selected_model": selected_model,
        "selected_model_ready": False,
        "detail": "Local speech runtime is ready. The selected model will download into app-managed storage on first use.",
    })

    save_response = client.post("/secrets", json={"provider": "groq", "key": "llm-key"})
    assert save_response.status_code == 200

    config_response = client.post("/config", json={
        "stt": {"provider": "mlx-whisper", "model": "mlx-community/whisper-base-mlx", "language": "en"},
        "llm": {"provider": "groq", "model": "llama3-70b-8192", "temperature": 0.0},
    })
    assert config_response.status_code == 200

    status = client.get("/status")
    assert status.status_code == 200
    assert status.json()["local_stt"] == {
        "runtime_mode": "bundled",
        "runtime_ready": True,
        "ffmpeg_available": True,
        "ffmpeg_source": "bundled",
        "selected_model": "mlx-community/whisper-base-mlx",
        "selected_model_ready": False,
        "detail": "Local speech runtime is ready. The selected model will download into app-managed storage on first use.",
    }


def test_writing_tools_and_history_endpoints():
    server = load_server()
    client = TestClient(server.app)

    tools_response = client.get("/writing-tools")
    assert tools_response.status_code == 200
    assert tools_response.json() == {
        "dictionary": [],
        "replacements": [],
        "snippets": [],
    }

    create_dictionary = client.post("/writing-tools/dictionary", json={
        "canonical_text": "Blue Anchor",
        "aliases": ["blue anchor"],
        "enabled": True,
    })
    assert create_dictionary.status_code == 200
    dictionary_entry = create_dictionary.json()["entry"]
    assert dictionary_entry["canonical_text"] == "Blue Anchor"
    assert dictionary_entry["aliases"] == ["blue anchor"]

    create_replacement = client.post("/writing-tools/replacements", json={
        "source_text": "pls advise",
        "replacement_text": "Please advise.",
        "match_type": "inline",
        "enabled": True,
    })
    assert create_replacement.status_code == 200

    create_snippet = client.post("/writing-tools/snippets", json={
        "trigger": "standup summary",
        "expansion": "- Yesterday:\n- Today:\n- Blockers:",
        "match_type": "exact",
        "enabled": True,
    })
    assert create_snippet.status_code == 200

    updated_dictionary = client.put(f"/writing-tools/dictionary/{dictionary_entry['id']}", json={
        "canonical_text": "Blue Anchor Lines",
        "aliases": ["blue anchor lines", "blue anchor"],
        "enabled": True,
    })
    assert updated_dictionary.status_code == 200
    assert updated_dictionary.json()["entry"]["canonical_text"] == "Blue Anchor Lines"

    history_response = client.get("/history")
    assert history_response.status_code == 200
    assert history_response.json()["items"] == []


def test_history_reprocess_returns_conflict_while_engine_is_busy():
    server = load_server()
    client = TestClient(server.app)

    server.engine._is_processing = True
    try:
        response = client.post("/history/1/reprocess")
    finally:
        server.engine._is_processing = False

    assert response.status_code == 409


def test_history_reprocess_accepts_optional_skill_override():
    server = load_server()
    client = TestClient(server.app)

    history_item = server.writing_tools_store.record_history(
        mode="dictation",
        transcript="draft a cleaner update",
        final_output="draft a cleaner update",
        telemetry={},
        context={"app_name": "Notes"},
        stt_provider="groq",
        stt_model="whisper-large-v3-turbo",
        llm_provider=None,
        llm_model=None,
    )

    original = server.engine.reprocess_history_item
    observed: dict[str, object] = {}

    def wrapped(item_id: int, *, skill_id: str | None = None):
        observed["item_id"] = item_id
        observed["skill_id"] = skill_id
        return original(item_id, skill_id=skill_id)

    server.engine.reprocess_history_item = wrapped
    try:
        response = client.post(f"/history/{history_item.id}/reprocess", json={"skill_id": "system_grammar"})
    finally:
        server.engine.reprocess_history_item = original

    assert response.status_code == 200
    assert observed == {"item_id": history_item.id, "skill_id": "system_grammar"}


def test_inbox_endpoints_list_and_delete_notes():
    server = load_server()
    client = TestClient(server.app)

    first = server.inbox_store.append_note(build_inbox_note(
        "buy milk",
        context={"app_name": "Slack", "window_title": "Notes"},
        source_mode="dictation",
    ).model_copy(update={"created_at": "2026-03-16T09:00:00Z"}))
    second = server.inbox_store.append_note(build_inbox_note(
        "ship the patch",
        context={"app_name": "Cursor", "window_title": "main.ts"},
        source_mode="smart_transform",
        output_mode="code",
    ).model_copy(update={"created_at": "2026-03-16T09:05:00Z"}))

    list_response = client.get("/inbox")
    assert list_response.status_code == 200
    notes = list_response.json()["notes"]
    assert [note["id"] for note in notes] == [second.id, first.id]
    assert notes[0]["source_kind"] == "spoken_text"
    assert notes[0]["output_mode"] == "code"

    delete_response = client.delete(f"/inbox/{first.id}")
    assert delete_response.status_code == 200

    second_list = client.get("/inbox")
    assert [note["id"] for note in second_list.json()["notes"]] == [second.id]

    missing_response = client.delete("/inbox/missing")
    assert missing_response.status_code == 404


def test_memory_endpoints_rebuild_and_update_local_memories():
    server = load_server()
    client = TestClient(server.app)

    server.writing_tools_store.record_history(
        mode="smart_transform",
        transcript="I prefer concise bullet updates.",
        final_output="I prefer concise bullet updates.",
        telemetry={},
        context={"app_name": "Slack", "url_host": None},
        stt_provider="groq",
        stt_model="whisper-large-v3-turbo",
        llm_provider="anthropic",
        llm_model="claude-sonnet-4-5",
    )

    rebuild_response = client.post("/memories/rebuild")
    assert rebuild_response.status_code == 200
    items = rebuild_response.json()["items"]
    assert len(items) == 1
    assert items[0]["kind"] == "writing_preference"

    list_response = client.get("/memories")
    assert list_response.status_code == 200
    memory_id = list_response.json()["items"][0]["id"]

    update_response = client.put(f"/memories/{memory_id}", json={"enabled": False})
    assert update_response.status_code == 200
    assert update_response.json()["item"]["enabled"] is False

    delete_response = client.delete(f"/memories/{memory_id}")
    assert delete_response.status_code == 200
    assert client.get("/memories").json()["items"] == []
