from action_routing import (
    ActionRoute,
    ExternalTextSource,
    InboxSourceKind,
    LocalActionRouter,
    resolve_external_text,
    should_use_action_router_model,
)


def test_local_action_router_saves_spoken_dictation_note():
    router = LocalActionRouter()

    result = router.route(
        "please note it down buy milk",
        mode="dictation",
        external_text=resolve_external_text(None, None),
    )

    assert result.action == ActionRoute.PASS_THROUGH
    assert result.transcript_for_transform == "please note it down buy milk"


def test_local_action_router_uses_selected_text_for_referential_note():
    router = LocalActionRouter()

    result = router.route(
        "take a note of this",
        mode="smart_transform",
        external_text=resolve_external_text("Selected browser paragraph", "Clipboard fallback"),
    )

    assert result.action == ActionRoute.SAVE_NOTE
    assert result.requires_external_text is True
    assert result.external_text_source == ExternalTextSource.SELECTION


def test_local_action_router_routes_transform_then_save_for_smart_mode():
    router = LocalActionRouter()

    result = router.route(
        "summarize this and take a note",
        mode="smart_transform",
        external_text=resolve_external_text("Roadmap details", None),
    )

    assert result.action == ActionRoute.TRANSFORM_THEN_SAVE_NOTE
    assert result.transcript_for_transform == "summarize this"
    assert result.requires_external_text is True


def test_local_action_router_supports_explicit_save_to_notes_phrase():
    router = LocalActionRouter()

    result = router.route(
        "save this to notes",
        mode="smart_transform",
        external_text=resolve_external_text("Selected browser paragraph", None),
    )

    assert result.action == ActionRoute.SAVE_NOTE
    assert result.requires_external_text is True
    assert result.external_text_source == ExternalTextSource.SELECTION


def test_local_action_router_falls_back_to_spoken_transcript_when_note_has_no_external_text():
    router = LocalActionRouter()

    result = router.route(
        "take a note of this",
        mode="smart_transform",
        external_text=resolve_external_text(None, None),
    )

    assert result.action == ActionRoute.SAVE_NOTE
    assert result.note_text == "take a note of this"
    assert result.note_source == InboxSourceKind.SPOKEN_TEXT
    assert result.requires_external_text is False


def test_local_action_router_does_not_treat_bare_save_this_as_note_capture():
    router = LocalActionRouter()

    result = router.route(
        "save this",
        mode="smart_transform",
        external_text=resolve_external_text("Selected browser paragraph", None),
    )

    assert result.action == ActionRoute.TRANSFORM_THEN_PASTE


def test_local_action_router_does_not_treat_keep_this_concise_as_note_capture():
    router = LocalActionRouter()

    result = router.route(
        "keep this concise",
        mode="smart_transform",
        external_text=resolve_external_text("Selected browser paragraph", None),
    )

    assert result.action == ActionRoute.TRANSFORM_THEN_PASTE


def test_dictation_does_not_transform_then_save():
    router = LocalActionRouter()

    result = router.route(
        "summarize this and save it",
        mode="dictation",
        external_text=resolve_external_text("Roadmap details", None),
    )

    assert result.action == ActionRoute.PASS_THROUGH


def test_weak_save_phrase_uses_model_fallback_gate():
    assert should_use_action_router_model("summarize this and save it", mode="smart_transform") is False
    assert should_use_action_router_model("take a note of this", mode="smart_transform") is False


def test_domain_mode_suppresses_note_capture_for_shipping_handover_phrase():
    router = LocalActionRouter()

    result = router.route(
        "draft a handover note for the next shift",
        mode="smart_transform",
        external_text=resolve_external_text(None, None),
        allow_note_capture=False,
    )

    assert result.action == ActionRoute.TRANSFORM_THEN_PASTE
    assert result.note_routing_suppressed is True


def test_domain_mode_suppresses_note_capture_for_medical_note_phrase():
    router = LocalActionRouter()

    result = router.route(
        "create a clinical note draft for today's visit",
        mode="smart_transform",
        external_text=resolve_external_text(None, None),
        allow_note_capture=False,
    )

    assert result.action == ActionRoute.TRANSFORM_THEN_PASTE
    assert result.note_routing_suppressed is True
