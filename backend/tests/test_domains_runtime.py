from domains.runtime import apply_glossary_corrections, build_domain_retrieval_block, resolve_domain_intent
from domains.store import DomainMemoryStore


def test_glossary_corrections_replace_known_aliases(isolated_steervox_home):
    store = DomainMemoryStore()
    shipping_pack = store.get_runtime_pack("shipping")
    assert shipping_pack is not None

    result = apply_glossary_corrections(
        "asn and bill of lading were delayed",
        shipping_pack,
    )

    assert "ASN" in result.text
    assert "BOL" in result.text
    assert result.hits


def test_domain_retrieval_block_stays_bounded_and_uses_template_example(isolated_steervox_home):
    store = DomainMemoryStore()
    medical_pack = store.get_runtime_pack("medical")
    assert medical_pack is not None

    result = build_domain_retrieval_block(
        domain_pack=medical_pack,
        domain_intent="clinical_note_draft",
        glossary_hits=["BP", "HR", "ROS", "HPI"],
        char_cap=700,
    )

    assert result.block
    assert len(result.block) <= 700
    assert result.template_id is not None
    assert result.example_id is not None
    assert result.glossary_hits == ["BP", "HR", "ROS", "HPI"]
    assert "Preferred format" in result.block


def test_domain_intent_resolution_prefers_domain_specific_intent(isolated_steervox_home):
    store = DomainMemoryStore()
    shipping_pack = store.get_runtime_pack("shipping")
    assert shipping_pack is not None

    resolution = resolve_domain_intent(
        domain_pack=shipping_pack,
        transcript="Send a customer delay notification with the updated ETA.",
        context={
            "app_name": "Outlook",
            "window_title": "Shipment follow-up",
            "page_title": None,
            "target_type": "email",
        },
    )

    assert resolution.baseline_intent == "external_reply"
    assert resolution.domain_intent == "delay_notification"
    assert resolution.preferred_skill_id == "system_domain_email"


def test_shipping_handover_phrasing_maps_to_structured_note(isolated_steervox_home):
    store = DomainMemoryStore()
    shipping_pack = store.get_runtime_pack("shipping")
    assert shipping_pack is not None

    resolution = resolve_domain_intent(
        domain_pack=shipping_pack,
        transcript="Write a shift handoff update for the warehouse team.",
        context={
            "app_name": "Google Chrome",
            "window_title": "project44",
            "page_title": None,
            "target_type": "generic",
        },
    )

    assert resolution.domain_intent == "operations_note"
    assert resolution.preferred_skill_id == "system_domain_structured_note"


def test_medical_visit_note_phrasing_maps_to_structured_note(isolated_steervox_home):
    store = DomainMemoryStore()
    medical_pack = store.get_runtime_pack("medical")
    assert medical_pack is not None

    resolution = resolve_domain_intent(
        domain_pack=medical_pack,
        transcript="Write a visit note and follow-up note for today's appointment.",
        context={
            "app_name": "Epic",
            "window_title": "Patient chart",
            "page_title": None,
            "target_type": "generic",
        },
    )

    assert resolution.domain_intent == "patient_follow_up_summary"
    assert resolution.preferred_skill_id == "system_domain_structured_note"
