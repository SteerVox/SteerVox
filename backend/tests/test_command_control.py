from command_control import apply_command_control, apply_format_contract, apply_minimal_command_control, enforce_surface_contract


def test_command_control_turns_new_paragraph_into_line_breaks():
    result = apply_command_control("project update new paragraph shipment cleared customs")

    assert result.text == "project update\n\nshipment cleared customs"
    assert "new_paragraph" in result.operations


def test_command_control_converts_spoken_points_into_checklist():
    result = apply_command_control("make this a checklist point one call carrier point two email customer")

    assert result.format_contract == "checklist"
    assert result.text.splitlines() == [
        "- [ ] Call carrier",
        "- [ ] Email customer",
    ]


def test_command_control_keeps_spoken_number_markers_literal_without_an_explicit_format_request():
    result = apply_command_control("number one ship routing number two add tests number three update docs")

    assert result.format_contract is None
    assert result.text == "number one ship routing number two add tests number three update docs"


def test_command_control_keeps_spoken_period_number_markers_literal_without_an_explicit_format_request():
    result = apply_command_control("one period ship routing two period add tests three period update docs")

    assert result.format_contract is None
    assert result.text == "one. ship routing two. add tests three. update docs"


def test_command_control_formats_inline_numbered_markers_when_explicitly_requested():
    result = apply_command_control("make this a numbered list 1. ship routing 2. add tests 3. update docs")

    assert result.format_contract == "numbered"
    assert result.text.splitlines() == [
        "1. Ship routing",
        "2. Add tests",
        "3. Update docs",
    ]


def test_command_control_formats_explicit_list_request_from_delimited_text():
    result = apply_command_control("make this a bullet list ship routing, add tests, update docs")

    assert result.format_contract == "bullets"
    assert result.text.splitlines() == [
        "- Ship routing",
        "- Add tests",
        "- Update docs",
    ]


def test_command_control_formats_spoken_number_markers_when_explicitly_requested():
    result = apply_command_control("make this a numbered list number one ship routing number two add tests number three update docs")

    assert result.format_contract == "numbered"
    assert result.text.splitlines() == [
        "1. Ship routing",
        "2. Add tests",
        "3. Update docs",
    ]


def test_command_control_keeps_explicit_list_requests_literal_when_format_contracts_are_disabled():
    transcript = "make this a numbered list number one ship routing number two add tests number three update docs"
    result = apply_command_control(transcript, allow_format_contract=False)

    assert result.format_contract is None
    assert result.text == transcript


def test_minimal_command_control_ignores_spoken_command_words():
    result = apply_minimal_command_control("shipment update new paragraph call carrier")

    assert result.format_contract is None
    assert result.text == "shipment update new paragraph call carrier"


def test_minimal_command_control_keeps_spoken_number_markers_literal_without_explicit_formatting():
    result = apply_minimal_command_control("number one ship routing number two add tests number three update docs")

    assert result.format_contract is None
    assert result.text == "number one ship routing number two add tests number three update docs"


def test_minimal_command_control_keeps_spoken_bullet_markers_literal_without_explicit_formatting():
    result = apply_minimal_command_control("point one call carrier point two email customer")

    assert result.format_contract is None
    assert result.text == "point one call carrier point two email customer"


def test_minimal_command_control_honors_explicit_bullet_requests():
    result = apply_minimal_command_control("make this a bullet list point one call carrier point two email customer")

    assert result.format_contract == "bullets"
    assert result.text.splitlines() == [
        "- Call carrier",
        "- Email customer",
    ]


def test_minimal_command_control_keeps_explicit_list_requests_literal_when_format_contracts_are_disabled():
    transcript = "make this a bullet list point one call carrier point two email customer"
    result = apply_minimal_command_control(transcript, allow_format_contract=False)

    assert result.format_contract is None
    assert result.text == transcript


def test_command_control_handles_within_utterance_replace():
    result = apply_command_control("shipment delayed replace delayed with back on track")

    assert result.text == "shipment back on track"
    assert "replace_within_utterance" in result.operations


def test_command_control_handles_scratch_that():
    result = apply_command_control("shipment delayed scratch that shipment back on track")

    assert result.text == "shipment back on track"
    assert "scratch_that" in result.operations


def test_command_control_keeps_literal_period_mentions():
    result = apply_command_control("Also it is adding a period after most of the things")

    assert result.text == "Also it is adding a period after most of the things"
    assert all(operation != "punctuation:." for operation in result.operations)


def test_command_control_only_applies_period_at_utterance_end():
    result = apply_command_control("shipment back on track period")

    assert result.text == "shipment back on track."
    assert "punctuation:." in result.operations


def test_command_control_applies_inline_spoken_period_and_colon():
    result = apply_command_control("hello comma team period shipment delayed colon waiting on carrier")

    assert result.text == "hello, team. shipment delayed: waiting on carrier"
    assert result.operations.count("punctuation:.") == 1
    assert "punctuation::" in result.operations


def test_format_contract_falls_back_to_bullets_when_table_is_not_clear():
    text, operations = apply_format_contract(
        "- Bangalore pending pickup\n- Chennai needs carrier confirmation",
        format_contract="table",
    )

    assert text.splitlines() == [
        "- Bangalore pending pickup",
        "- Chennai needs carrier confirmation",
    ]
    assert operations == ["table_fallback_to_bullets"]


def test_format_contract_uses_transcript_hint_when_model_output_is_not_a_list():
    text, operations = apply_format_contract(
        "Look at the second screenshot",
        format_contract="bullets",
        transcript_hint="call carrier, email customer, update tracker",
    )

    assert text.splitlines() == [
        "- Call carrier",
        "- Email customer",
        "- Update tracker",
    ]
    assert "normalize_literal_bullet_markers" in operations


def test_surface_contract_returns_single_subject_line():
    text, applied = enforce_surface_contract(
        "Subject: Shift handover update\nDear team,\nBest regards",
        {"surface_kind": "email_subject"},
    )

    assert text == "Shift handover update"
    assert applied is True
