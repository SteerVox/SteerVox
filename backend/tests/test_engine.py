import subprocess

import engine as engine_module
import pytest

from action_routing import ActionRoute, ActionRoutingResult
from config.models import AppConfig
from agent.smart_models import AutoActionPayload, SkillReference, SmartIntent, SmartLane, SmartModeResult, SmartRunTelemetry
from engine import RewriteContextPayload, SteerVoxEngine
from writing_memory import DictionaryEntryPayload, ReplacementEntryPayload


def _smart_result(final_text: str) -> SmartModeResult:
    requested_skill = SkillReference(id="system_dictation", name="Dictation")
    skill_used = SkillReference(id="system_dictation", name="Dictation")
    telemetry = SmartRunTelemetry(
        intent=SmartIntent.GENERIC,
        lane=SmartLane.LLM,
        confidence=0.82,
        ambiguity=0.35,
        reason="Ambiguous request",
        requested_skill=requested_skill,
        skill_used=skill_used,
    )
    return SmartModeResult(
        intent=SmartIntent.GENERIC,
        lane=SmartLane.LLM,
        confidence=0.82,
        ambiguity=0.35,
        final_text=final_text,
        requested_skill=requested_skill,
        skill_used=skill_used,
        telemetry=telemetry,
    )


def test_reprocess_history_rejects_while_engine_is_busy():
    engine = SteerVoxEngine()
    engine._is_processing = True

    try:
        try:
            engine.reprocess_history_item(1)
        except RuntimeError as exc:
            assert "busy" in str(exc).lower()
        else:
            raise AssertionError("Expected reprocess_history_item to reject while busy.")
    finally:
        engine._is_processing = False


def test_rewrite_transcript_updates_smart_preview_runtime_state(monkeypatch):
    emitted_events: list[str] = []
    engine = SteerVoxEngine(runtime_event_emitter=lambda event_type, payload=None: emitted_events.append(event_type))

    def fake_process(_transcript, _context, _skill_id, **kwargs):
        kwargs["preview_callback"]("Please ship this once QA")
        return _smart_result("Please ship this once QA has approved it.")

    monkeypatch.setattr(engine.smart_processor, "process", fake_process)

    result = engine._rewrite_transcript(
        RewriteContextPayload(
            transcript="make this sound polite",
            skill_id="system_grammar",
            processing_context={"app_name": "Slack", "window_title": "eng-updates"},
        )
    )

    assert result.final_text == "Please ship this once QA has approved it."
    assert engine.smart_preview == {
        "run_id": engine.smart_preview["run_id"],
        "mode": "smart_transform",
        "state": "done",
        "text": "Please ship this once QA has approved it.",
        "final_text": "Please ship this once QA has approved it.",
        "error": None,
        "updated_at": engine.smart_preview["updated_at"],
    }
    assert emitted_events.count("smart_preview") >= 2


def test_engine_resolves_medical_domain_to_medgemma_override(monkeypatch):
    engine = SteerVoxEngine()
    config = AppConfig(llm={"provider": "groq", "model": "llama3-70b-8192"})

    class FakePack:
        styles = {
            "preferred_llm_provider": "lmstudio",
            "preferred_llm_model_pattern": "medgemma",
        }

    monkeypatch.setattr(engine_module.ModelDiscovery, "resolve_lmstudio_model_by_pattern", lambda pattern, require_loaded=False: "google/medgemma-4b-it")

    override = engine._resolve_domain_llm_override(
        config=config,
        domain_id="medical",
        domain_pack=FakePack(),
    )

    assert override == {
        "provider": "lmstudio",
        "model": "google/medgemma-4b-it",
    }


def test_engine_uses_medgemma_processor_for_medical_domain(monkeypatch):
    emitted_events: list[str] = []
    engine = SteerVoxEngine(runtime_event_emitter=lambda event_type, payload=None: emitted_events.append(event_type))

    config = AppConfig(
        llm={
            "provider": "groq",
            "model": "llama3-70b-8192",
            "routing": {
                "enabled": True,
                "provider": "groq",
                "model": "groq/compound-mini",
                "temperature": 0.0,
            },
        }
    )
    monkeypatch.setattr(engine.config_manager, "get_config", lambda: config)
    monkeypatch.setattr(
        engine,
        "_resolve_domain_llm_override",
        lambda **_kwargs: {"provider": "lmstudio", "model": "google/medgemma-4b-it"},
    )

    captured: dict[str, object] = {}

    class FakeProcessor:
        def __init__(self, *, provider, model, temperature, skill_manager, smart_router_agent):
            captured["provider"] = provider
            captured["model"] = model
            captured["temperature"] = temperature
            captured["router_provider"] = smart_router_agent.provider if smart_router_agent else None
            captured["router_model"] = smart_router_agent.model if smart_router_agent else None

        def process(self, _transcript, _context, _skill_id, **kwargs):
            kwargs["preview_callback"]("Medical draft preview")
            result = _smart_result("Medical draft output")
            result.telemetry.provider = captured["provider"]
            result.telemetry.model = captured["model"]
            result.telemetry.planner_provider = captured["router_provider"]
            result.telemetry.planner_model = captured["router_model"]
            result.telemetry.planner_model_attempted = True
            return result

    monkeypatch.setattr(engine_module, "SmartModeProcessor", FakeProcessor)

    result = engine._rewrite_transcript(
        RewriteContextPayload(
            transcript="draft the clinical summary",
            skill_id="system_domain_structured_note",
            processing_context={"app_name": "Epic", "window_title": "Patient chart"},
            domain_id="medical",
        )
    )

    assert result.final_text == "Medical draft output"
    assert captured == {
        "provider": "lmstudio",
        "model": "google/medgemma-4b-it",
        "temperature": config.llm.temperature,
        "router_provider": "lmstudio",
        "router_model": "google/medgemma-4b-it",
    }
    assert engine.last_smart_run["provider"] == "lmstudio"
    assert engine.last_smart_run["model"] == "google/medgemma-4b-it"


def test_start_processing_replaces_stale_session_state(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    previous_state = engine._session_state
    engine.pending_paste_text = "stale"
    engine.pending_notification = {"title": "Saved", "body": None}
    engine.last_error = "old error"
    engine.captured_context = {"app_name": "Mail"}

    class DummyThread:
        def __init__(self, *, target, args, daemon):
            self.target = target
            self.args = args
            self.daemon = daemon

        def start(self):
            return None

    monkeypatch.setattr(engine_module.threading, "Thread", DummyThread)

    engine.start_processing(
        str(wav_path),
        mode="smart_transform",
        context={"app_name": "Slack", "window_title": "eng-updates"},
    )

    try:
        assert engine._session_state is not previous_state
        assert engine.pending_paste_text is None
        assert engine.pending_notification is None
        assert engine.last_error is None
        assert engine.active_mode == "smart_transform"
        assert engine.captured_context["app_name"] == "Slack"
    finally:
        engine._is_processing = False


def test_reprocess_history_restores_engine_state(monkeypatch):
    engine = SteerVoxEngine()
    history_item = engine.writing_tools_store.record_history(
        mode="smart_transform",
        transcript="draft a shipment update",
        final_output="old result",
        telemetry={"intent": "generic"},
        context={"app_name": "Outlook"},
        stt_provider="groq",
        stt_model="whisper-large-v3-turbo",
        llm_provider="groq",
        llm_model="llama3-70b-8192",
    )

    engine.pending_paste_text = "keep me"
    engine.pending_notification = {"title": "Saved", "body": None}
    engine.last_error = "old error"
    engine.last_smart_run = {"intent": "previous"}
    engine._set_phase("preparing_paste")

    monkeypatch.setattr(engine.smart_processor, "process", lambda *args, **kwargs: _smart_result("Fresh output"))

    created = engine.reprocess_history_item(history_item.id)

    assert created.final_output == "Fresh output"
    assert engine.pending_paste_text == "keep me"
    assert engine.pending_notification == {"title": "Saved", "body": None}
    assert engine.last_error == "old error"
    assert engine.last_smart_run == {"intent": "previous"}
    assert engine.phase == "preparing_paste"
    assert engine.is_processing is False
    assert engine.active_mode is None


def test_reprocess_history_restores_phase_after_failure(monkeypatch):
    engine = SteerVoxEngine()
    history_item = engine.writing_tools_store.record_history(
        mode="smart_transform",
        transcript="draft a shipment update",
        final_output="old result",
        telemetry={"intent": "generic"},
        context={"app_name": "Outlook"},
        stt_provider="groq",
        stt_model="whisper-large-v3-turbo",
        llm_provider="groq",
        llm_model="llama3-70b-8192",
    )
    engine._set_phase("ready")
    engine.last_smart_run = {"intent": "stable"}

    def fail_process(*_args, **_kwargs):
        raise RuntimeError("planner exploded")

    monkeypatch.setattr(engine.smart_processor, "process", fail_process)

    try:
        engine.reprocess_history_item(history_item.id)
    except RuntimeError as exc:
        assert "planner exploded" in str(exc)
    else:
        raise AssertionError("Expected reprocess_history_item to propagate the processing error.")

    assert engine.phase == "ready"
    assert engine.last_smart_run == {"intent": "stable"}
    assert engine.is_processing is False
    assert engine.active_mode is None


def test_engine_uses_streaming_transcript_without_invoking_batch_stt(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    def fail_transcribe(*_args, **_kwargs):
        raise AssertionError("Batch STT should not run when a finalized streaming transcript is available.")

    monkeypatch.setattr(engine.stt_client, "transcribe", fail_transcribe)
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda transcript, *_args, **_kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform=transcript,
            reason="test",
        ),
    )
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "dictation",
        {},
        None,
        False,
        None,
        False,
        None,
        "live transcript result",
        "local",
    )

    assert engine.pending_paste_text == "live transcript result"
    assert engine.pipeline_timings["stt_done"] is not None


def test_reprocess_history_can_force_a_selected_skill(monkeypatch):
    engine = SteerVoxEngine()
    history_item = engine.writing_tools_store.record_history(
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

    monkeypatch.setattr(engine.smart_processor, "process", lambda transcript, context, skill_id, **kwargs: _smart_result(f"{skill_id}:{transcript}"))

    created = engine.reprocess_history_item(history_item.id, skill_id="system_grammar")

    assert created.mode == "smart_transform"


def test_engine_dictation_keeps_spoken_number_markers_literal_without_explicit_list_request(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    transcript = "number one ship routing number two add tests number three update docs"
    non_whisper_config = AppConfig(stt={"provider": "deepgram", "model": "nova-3"})

    monkeypatch.setattr(engine.config_manager, "get_config", lambda: non_whisper_config)
    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: transcript)
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda transcript, *_args, **_kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform=transcript,
            reason="test",
        ),
    )
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "dictation",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.pending_paste_text == transcript


def test_engine_dictation_keeps_explicit_numbered_list_requests_literal(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    transcript = "make this a numbered list number one ship routing number two add tests number three update docs"
    non_whisper_config = AppConfig(stt={"provider": "deepgram", "model": "nova-3"})

    monkeypatch.setattr(engine.config_manager, "get_config", lambda: non_whisper_config)
    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: transcript)
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda transcript, *_args, **_kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform=transcript,
            reason="test",
        ),
    )
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "dictation",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.pending_paste_text == transcript


def test_engine_whisper_dictation_ignores_strict_spoken_commands(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    transcript = "shipment update new paragraph call carrier"

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: transcript)
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda transcript, *_args, **_kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform=transcript,
            reason="test",
        ),
    )
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "dictation",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.pending_paste_text == transcript


def test_engine_whisper_dictation_keeps_spoken_number_markers_literal_without_explicit_list_request(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    transcript = "number one ship routing number two add tests number three update docs"

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: transcript)
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda transcript, *_args, **_kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform=transcript,
            reason="test",
        ),
    )
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "dictation",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.pending_paste_text == transcript


def test_engine_whisper_dictation_keeps_explicit_numbered_list_requests_literal(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    transcript = "make this a numbered list number one ship routing number two add tests number three update docs"

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: transcript)
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda transcript, *_args, **_kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform=transcript,
            reason="test",
        ),
    )
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "dictation",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.pending_paste_text == transcript


def test_engine_smart_mode_passes_raw_transcript_without_local_command_control(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")
    transcript = "make this a numbered list number one ship routing number two add tests"
    captured: dict[str, object] = {}

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: transcript)
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda transcript, *_args, **_kwargs: ActionRoutingResult(
            action=ActionRoute.TRANSFORM_THEN_PASTE,
            transcript_for_transform=transcript,
            reason="test",
        ),
    )

    def fake_rewrite(payload):
        captured["transcript"] = payload.transcript
        captured["format_contract"] = payload.format_contract
        return _smart_result("rewritten output")

    monkeypatch.setattr(engine, "_rewrite_transcript", fake_rewrite)

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {"app_name": "Notes"},
        None,
        False,
        None,
        False,
        None,
    )

    assert captured == {
        "transcript": transcript,
        "format_contract": None,
    }


def test_acknowledged_paste_transitions_to_ready_after_processing_finishes():
    engine = SteerVoxEngine()
    engine._is_processing = True
    engine._set_phase("preparing_paste")
    engine.pending_paste = {"id": "paste-1", "text": "hello world"}
    engine.pending_paste_text = "hello world"

    acknowledged = engine.acknowledge_pending_paste("paste-1")

    assert acknowledged is True
    assert engine.pending_paste is None
    assert engine.pending_paste_text is None
    assert engine.phase == "preparing_paste"

    engine._is_processing = False
    engine._settle_phase_after_processing()

    assert engine.phase == "ready"


def test_cleared_notification_transitions_to_ready_after_processing_finishes():
    engine = SteerVoxEngine()
    engine._is_processing = True
    engine._set_phase("preparing_paste")
    engine.pending_notification = {"title": "Saved to Inbox", "body": None}

    engine.clear_pending_paste()

    assert engine.pending_notification is None
    assert engine.phase == "preparing_paste"

    engine._is_processing = False
    engine._settle_phase_after_processing()

    assert engine.phase == "ready"


def test_reconcile_runtime_state_clears_impossible_preparing_paste():
    engine = SteerVoxEngine()
    engine._set_phase("preparing_paste")

    reconciled = engine.reconcile_runtime_state()

    assert reconciled is True
    assert engine.phase == "ready"


def test_engine_applies_code_safe_writing_tools_for_ide_context():
    engine = SteerVoxEngine()
    engine.writing_tools_store.create_replacement_entry(
        ReplacementEntryPayload(
            source_text="map",
            replacement_text="mapping",
            match_type="inline",
            enabled=True,
        )
    )
    engine.writing_tools_store.create_replacement_entry(
        ReplacementEntryPayload(
            source_text="git status",
            replacement_text="git status --short",
            match_type="exact",
            enabled=True,
        )
    )

    code_result = engine._apply_writing_tools_for_context(
        "map values",
        {"app_name": "Cursor", "window_title": "parser.ts"},
    )
    exact_result = engine._apply_writing_tools_for_context(
        "git status",
        {"app_name": "Cursor", "window_title": "parser.ts"},
    )

    assert code_result == "map values"
    assert exact_result == "git status --short"


def test_engine_preserves_command_layer_newlines_through_writing_tools():
    engine = SteerVoxEngine()
    engine.writing_tools_store.create_dictionary_entry(
        DictionaryEntryPayload(
            canonical_text="Blue Anchor",
            aliases=["blue anchor"],
            enabled=True,
        )
    )

    result = engine._apply_writing_tools_for_context(
        "Checklist:\nblue anchor pending pickup",
        {"app_name": "Notes"},
    )

    assert result == "Checklist:\nBlue Anchor pending pickup"


def test_engine_falls_back_to_spoken_transcript_for_inbox_save_without_external_text(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")
    captured = {}

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "take a note of this")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.SAVE_NOTE,
            transcript_for_transform="take a note of this",
            requires_external_text=True,
            reason="test",
        ),
    )

    def capture_note(note):
        captured["note"] = note
        return note

    monkeypatch.setattr(engine.inbox_store, "append_note", capture_note)

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert captured["note"].text == "take a note of this"
    assert captured["note"].source_kind == "spoken_text"
    assert engine.last_error is None
    assert engine.pending_notification == {"title": "Saved to Inbox", "body": None}


def test_engine_rejects_whitespace_only_pending_paste(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "dictated words")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="dictated words",
            reason="test",
        ),
    )
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: ("   ", None))

    engine._pipeline_task(
        str(wav_path),
        "dictation",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.pending_paste is None
    assert engine.pending_paste_text is None
    assert engine.phase == "error"
    assert engine.last_error is not None
    assert "empty after formatting" in engine.last_error.lower()


def test_engine_passes_bounded_domain_hints_into_stt(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")
    captured = {}

    engine.config_manager.update_config({
        "domains": {
            "mode": "shipping",
        }
    })

    def fake_transcribe(*args, **kwargs):
        captured["hints"] = kwargs.get("hints")
        return "dictated words"

    monkeypatch.setattr(engine.stt_client, "transcribe", fake_transcribe)
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="dictated words",
            reason="test",
        ),
    )
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "dictation",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    hints = captured["hints"]
    assert hints is not None
    assert len(hints.keywords) <= 12
    assert hints.prompt is not None


def test_engine_adds_screen_context_from_local_vision_before_smart_processing(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")
    captured = {}

    engine._prepare_context(
        "smart_transform",
        {"app_name": "Numbers", "window_title": "Q3 Sheet"},
        None,
    )

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "summarize this spreadsheet")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="summarize this spreadsheet",
            reason="test",
        ),
    )
    monkeypatch.setattr(engine.vision_agent, "summarize_screen", lambda **_kwargs: "Visible spreadsheet with Q3 totals and forecast variance.")

    def fake_process(_transcript, context, _skill_id, **kwargs):
        captured["context"] = dict(context)
        return _smart_result("Q3 totals are visible.")

    monkeypatch.setattr(engine.smart_processor, "process", fake_process)
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {},
        None,
        False,
        None,
        False,
        {
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1600,
            "height": 900,
        },
    )

    assert captured["context"]["screen_context"] == "Visible spreadsheet with Q3 totals and forecast variance."


def test_engine_reduces_local_vision_timeout_when_using_remote_smart_provider(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")
    captured: dict[str, object] = {}

    engine.config_manager.update_config({
        "llm": {"provider": "groq", "model": "llama3-70b-8192"},
    })

    engine._prepare_context(
        "smart_transform",
        {"app_name": "Numbers", "window_title": "Q3 Sheet"},
        None,
    )

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "summarize this spreadsheet")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="summarize this spreadsheet",
            reason="test",
        ),
    )

    def fake_summarize_screen(*, config, **_kwargs):
        captured["vision_timeout_ms"] = config.vision.timeout_ms
        return ""

    monkeypatch.setattr(engine.vision_agent, "summarize_screen", fake_summarize_screen)
    monkeypatch.setattr(engine.smart_processor, "process", lambda *args, **kwargs: _smart_result("Spreadsheet summary."))
    monkeypatch.setattr(engine_module, "enforce_surface_contract", lambda text, context: (text, None))

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {},
        None,
        False,
        None,
        False,
        {
            "mime_type": "image/jpeg",
            "image_base64": "abc123",
            "width": 1600,
            "height": 900,
        },
    )

    assert captured["vision_timeout_ms"] == 1000


def test_engine_stores_pending_action_review_without_creating_pending_paste(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "open example.com")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="open example.com",
            reason="test",
        ),
    )

    requested_skill = SkillReference(id="system_dictation", name="Dictation")
    telemetry = SmartRunTelemetry(
        intent=SmartIntent.ACTION_EXECUTION,
        lane=SmartLane.LLM,
        confidence=0.9,
        ambiguity=0.1,
        reason="Explicit desktop action request.",
        requested_skill=requested_skill,
        skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        action_review_required=True,
    )
    action_result = SmartModeResult(
        intent=SmartIntent.ACTION_EXECUTION,
        lane=SmartLane.LLM,
        confidence=0.9,
        ambiguity=0.1,
        final_text="",
        requested_skill=requested_skill,
        skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        pending_action_review={
            "run_id": "review-1",
            "action_type": "open_url",
            "title": "Open URL",
            "summary": "Open https://example.com in the default browser.",
            "script": 'open location "https://example.com"',
            "language": "applescript",
            "status": "pending",
            "error": None,
        },
        telemetry=telemetry,
    )
    monkeypatch.setattr(engine.smart_processor, "process", lambda *args, **kwargs: action_result)

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.pending_action_review is not None
    assert engine.pending_action_review["run_id"] == "review-1"
    assert engine.pending_paste is None
    assert engine.pending_paste_text is None


def test_engine_auto_approves_reviewed_actions_when_enabled(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")
    config = AppConfig()
    config.actions.auto_approve_reviewed = True
    monkeypatch.setattr(engine.config_manager, "get_config", lambda: config)

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "open example.com")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="open example.com",
            reason="test",
        ),
    )

    requested_skill = SkillReference(id="system_dictation", name="Dictation")
    telemetry = SmartRunTelemetry(
        intent=SmartIntent.ACTION_EXECUTION,
        lane=SmartLane.LLM,
        confidence=0.9,
        ambiguity=0.1,
        reason="Explicit desktop action request.",
        requested_skill=requested_skill,
        skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        action_review_required=True,
        action_execution_mode="reviewed",
    )
    action_result = SmartModeResult(
        intent=SmartIntent.ACTION_EXECUTION,
        lane=SmartLane.LLM,
        confidence=0.9,
        ambiguity=0.1,
        final_text="",
        requested_skill=requested_skill,
        skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        pending_action_review={
            "run_id": "review-1",
            "action_type": "open_url",
            "title": "Open URL",
            "summary": "Open https://example.com in the default browser.",
            "script": 'open location "https://example.com"',
            "language": "applescript",
            "status": "pending",
            "error": None,
        },
        telemetry=telemetry,
    )
    monkeypatch.setattr(engine.smart_processor, "process", lambda *args, **kwargs: action_result)
    executed = {}
    monkeypatch.setattr(engine_module, "execute_reviewed_action", lambda review: executed.setdefault("review", review))

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert executed["review"].action_type == "open_url"
    assert engine.pending_action_review is None
    assert engine.pending_paste is None
    assert engine.pending_notification == {
        "title": "Open URL",
        "body": "Desktop action completed.",
    }


def test_engine_executes_auto_ui_actions_without_creating_pending_review(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")

    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "focus search field")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="focus search field",
            reason="test",
        ),
    )

    requested_skill = SkillReference(id="system_dictation", name="Dictation")
    telemetry = SmartRunTelemetry(
        intent=SmartIntent.ACTION_EXECUTION,
        lane=SmartLane.LLM,
        confidence=0.9,
        ambiguity=0.1,
        reason="Explicit UI action request.",
        requested_skill=requested_skill,
        skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        action_execution_mode="auto",
    )
    action_result = SmartModeResult(
        intent=SmartIntent.ACTION_EXECUTION,
        lane=SmartLane.LLM,
        confidence=0.9,
        ambiguity=0.1,
        final_text="",
        requested_skill=requested_skill,
        skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        auto_action=AutoActionPayload(
            action_type="focus_field",
            title="Focus Field",
            summary="Focus Search in Slack.",
            app_name="Slack",
            bundle_id="com.tinyspeck.slackmacgap",
            target_label="Search",
            target_role="AXSearchField",
            ui_index=3,
        ),
        telemetry=telemetry,
    )
    monkeypatch.setattr(engine.smart_processor, "process", lambda *args, **kwargs: action_result)
    executed = {}
    monkeypatch.setattr(engine_module, "execute_auto_action", lambda payload: executed.setdefault("payload", payload))

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert executed["payload"].action_type == "focus_field"
    assert engine.pending_action_review is None
    assert engine.pending_paste is None
    assert engine.pending_notification == {
        "title": "Focus Field",
        "body": "Focus Search in Slack.",
    }


def test_engine_auto_ui_action_failures_clear_after_timer(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")
    timer_calls = {}

    class DummyTimer:
        def __init__(self, interval, fn):
            timer_calls["interval"] = interval
            timer_calls["fn"] = fn
            self.daemon = False

        def start(self):
            timer_calls["started"] = True

        def cancel(self):
            timer_calls["cancelled"] = True

    monkeypatch.setattr(engine_module.threading, "Timer", DummyTimer)
    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "focus search field")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="focus search field",
            reason="test",
        ),
    )

    requested_skill = SkillReference(id="system_dictation", name="Dictation")
    action_result = SmartModeResult(
        intent=SmartIntent.ACTION_EXECUTION,
        lane=SmartLane.LLM,
        confidence=0.9,
        ambiguity=0.1,
        final_text="",
        requested_skill=requested_skill,
        skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        auto_action=AutoActionPayload(
            action_type="focus_field",
            title="Focus Field",
            summary="Focus Search in Slack.",
            app_name="Slack",
            bundle_id="com.tinyspeck.slackmacgap",
            target_label="Search",
            target_role="AXSearchField",
            ui_index=3,
        ),
        telemetry=SmartRunTelemetry(
            intent=SmartIntent.ACTION_EXECUTION,
            lane=SmartLane.LLM,
            confidence=0.9,
            ambiguity=0.1,
            reason="Explicit UI action request.",
            requested_skill=requested_skill,
            skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
            action_execution_mode="auto",
        ),
    )
    monkeypatch.setattr(engine.smart_processor, "process", lambda *args, **kwargs: action_result)
    monkeypatch.setattr(engine_module, "execute_auto_action", lambda _payload: (_ for _ in ()).throw(RuntimeError("Accessibility access is required.")))

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.last_error == "Accessibility access is required."
    assert engine.phase == "error"
    assert timer_calls["interval"] == 8.0

    timer_calls["fn"]()

    assert engine.last_error is None
    assert engine.phase == "ready"


def test_engine_action_resolution_failures_clear_without_pending_paste(monkeypatch, tmp_path):
    engine = SteerVoxEngine()
    wav_path = tmp_path / "sample.wav"
    wav_path.write_bytes(b"RIFF")
    timer_calls = {}

    class DummyTimer:
        def __init__(self, interval, fn):
            timer_calls["interval"] = interval
            timer_calls["fn"] = fn
            self.daemon = False

        def start(self):
            timer_calls["started"] = True

        def cancel(self):
            timer_calls["cancelled"] = True

    monkeypatch.setattr(engine_module.threading, "Timer", DummyTimer)
    monkeypatch.setattr(engine.stt_client, "transcribe", lambda *args, **kwargs: "focus address bar")
    monkeypatch.setattr(
        engine.action_router,
        "route",
        lambda *args, **kwargs: ActionRoutingResult(
            action=ActionRoute.PASS_THROUGH,
            transcript_for_transform="focus address bar",
            reason="test",
        ),
    )

    requested_skill = SkillReference(id="system_dictation", name="Dictation")
    action_result = SmartModeResult(
        intent=SmartIntent.ACTION_EXECUTION,
        lane=SmartLane.LLM,
        confidence=0.92,
        ambiguity=0.08,
        final_text="",
        requested_skill=requested_skill,
        skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        action_error="Local UI automation failed to compile its AppleScript helpers. This is an internal automation bug, not a missing page control.",
        action_error_kind="resolution",
        telemetry=SmartRunTelemetry(
            intent=SmartIntent.ACTION_EXECUTION,
            lane=SmartLane.LLM,
            confidence=0.92,
            ambiguity=0.08,
            reason="Explicit UI action request.",
            requested_skill=requested_skill,
            skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
            action_execution_mode="none",
        ),
    )
    monkeypatch.setattr(engine.smart_processor, "process", lambda *args, **kwargs: action_result)

    engine._pipeline_task(
        str(wav_path),
        "smart_transform",
        {},
        None,
        False,
        None,
        False,
        None,
    )

    assert engine.last_error == action_result.action_error
    assert engine.phase == "error"
    assert engine.pending_paste is None
    assert engine.pending_action_review is None
    assert timer_calls["interval"] == 8.0

    timer_calls["fn"]()

    assert engine.last_error is None
    assert engine.phase == "ready"


def test_reviewed_action_errors_clear_after_timer(monkeypatch):
    engine = SteerVoxEngine()
    timer_calls = {}

    class DummyTimer:
        def __init__(self, interval, fn):
            timer_calls["interval"] = interval
            timer_calls["fn"] = fn
            self.daemon = False

        def start(self):
            timer_calls["started"] = True

        def cancel(self):
            timer_calls["cancelled"] = True

    monkeypatch.setattr(engine_module.threading, "Timer", DummyTimer)
    monkeypatch.setattr(engine_module, "execute_reviewed_action", lambda _review: (_ for _ in ()).throw(subprocess.CalledProcessError(1, "osascript", stderr="Can't get application \"CamoCam\".")))

    engine.pending_action_review = {
        "run_id": "review-1",
        "action_type": "open_app",
        "title": "Open App",
        "summary": "Bring Camo Studio to the front.",
        "script": 'tell application id "com.reincubate.macos.camo"\nactivate\nend tell',
        "language": "applescript",
        "status": "pending",
        "error": None,
    }

    with pytest.raises(RuntimeError, match="Can't get application"):
        engine.approve_pending_action_review("review-1")

    assert engine.pending_action_review is not None
    assert engine.pending_action_review["status"] == "error"
    assert timer_calls["interval"] == 8.0

    timer_calls["fn"]()

    assert engine.pending_action_review is None
    assert engine.last_error is None
    assert engine.phase == "ready"
