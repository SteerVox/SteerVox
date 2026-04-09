from action_routing import InboxSourceKind
from inbox import InboxStore, build_inbox_note


def test_inbox_store_appends_lists_newest_first_and_deletes():
    store = InboxStore()
    first = store.append_note(build_inbox_note(
        "first note",
        context={"app_name": "Slack", "window_title": "Channel"},
        source_mode="dictation",
        source_kind=InboxSourceKind.SPOKEN_TEXT.value,
    ).model_copy(update={"created_at": "2026-03-16T09:00:00Z"}))
    second = store.append_note(build_inbox_note(
        "second note",
        context={"app_name": "Cursor", "window_title": "main.ts"},
        source_mode="smart_transform",
        source_kind=InboxSourceKind.TRANSFORMED_OUTPUT.value,
        output_mode="code",
    ).model_copy(update={"created_at": "2026-03-16T09:05:00Z"}))

    listed = store.list_notes()
    assert [note.id for note in listed] == [second.id, first.id]
    assert listed[0].app_name == "Cursor"
    assert listed[0].source_kind == InboxSourceKind.TRANSFORMED_OUTPUT.value
    assert listed[0].output_mode == "code"
    assert listed[1].source_mode == "dictation"

    assert store.delete_note(first.id) is True
    remaining = store.list_notes()
    assert [note.id for note in remaining] == [second.id]
    assert store.delete_note("missing") is False
