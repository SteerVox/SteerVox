import sqlite3

import pytest

from library_models import InboxNote
from writing_memory import (
    DictionaryEntryPayload,
    MAX_HISTORY_ITEMS,
    MAX_HISTORY_JSON_BLOB_CHARS,
    MAX_HISTORY_TRANSCRIPT_CHARS,
    MAX_REPLACEMENT_TEXT_CHARS,
    MAX_SNIPPET_EXPANSION_CHARS,
    MAX_SOURCE_TEXT_CHARS,
    ReplacementEntryPayload,
    SnippetEntryPayload,
    WritingToolsStore,
    apply_dictionary_entries,
    apply_replacement_entries,
    apply_snippet_entries,
)


def test_writing_tools_store_crud_and_runtime_cache(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")

    created_dictionary = store.create_dictionary_entry(
        DictionaryEntryPayload(canonical_text="Blue Anchor", aliases=["blue anchor"], enabled=True)
    )
    created_replacement = store.create_replacement_entry(
        ReplacementEntryPayload(source_text="pls advise", replacement_text="Please advise.", match_type="inline", enabled=True)
    )
    created_snippet = store.create_snippet_entry(
        SnippetEntryPayload(trigger="standup summary", expansion="- Yesterday:\n- Today:\n- Blockers:", match_type="exact", enabled=True)
    )

    snapshot = store.get_tools()
    assert [entry.id for entry in snapshot.dictionary] == [created_dictionary.id]
    assert [entry.id for entry in snapshot.replacements] == [created_replacement.id]
    assert [entry.id for entry in snapshot.snippets] == [created_snippet.id]

    updated_dictionary = store.update_dictionary_entry(
        created_dictionary.id,
        DictionaryEntryPayload(canonical_text="Blue Anchor Lines", aliases=["blue anchor lines", "blue anchor"], enabled=True),
    )
    assert updated_dictionary.canonical_text == "Blue Anchor Lines"
    assert updated_dictionary.aliases == ["blue anchor lines", "blue anchor"]

    store.delete_replacement_entry(created_replacement.id)
    assert store.get_tools().replacements == []


def test_writing_tools_apply_dictionary_replacements_and_snippets(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")
    store.create_dictionary_entry(DictionaryEntryPayload(canonical_text="Blue Anchor", aliases=["blue anchor"], enabled=True))
    store.create_replacement_entry(ReplacementEntryPayload(source_text="pls advise", replacement_text="Please advise.", match_type="inline", enabled=True))
    store.create_snippet_entry(SnippetEntryPayload(trigger="standup summary", expansion="- Yesterday:\n- Today:\n- Blockers:", match_type="exact", enabled=True))

    snapshot = store.get_tools()
    assert apply_dictionary_entries("blue anchor shipment ready", snapshot.dictionary) == "Blue Anchor shipment ready"
    assert apply_replacement_entries("pls advise on eta", snapshot.replacements) == "Please advise. on eta"
    assert apply_snippet_entries("standup summary", snapshot.snippets) == "- Yesterday:\n- Today:\n- Blockers:"


def test_writing_tools_runtime_snapshot_only_keeps_enabled_entries(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")
    store.create_dictionary_entry(DictionaryEntryPayload(canonical_text="Blue Anchor", aliases=["blue anchor"], enabled=False))
    store.create_replacement_entry(ReplacementEntryPayload(source_text="pls advise", replacement_text="Please advise.", match_type="inline", enabled=False))
    store.create_snippet_entry(SnippetEntryPayload(trigger="standup summary", expansion="- Yesterday:\n- Today:\n- Blockers:", match_type="exact", enabled=False))

    full_snapshot = store.get_tools()
    runtime_snapshot = store.get_runtime_tools()

    assert len(full_snapshot.dictionary) == 1
    assert len(full_snapshot.replacements) == 1
    assert len(full_snapshot.snippets) == 1
    assert runtime_snapshot.dictionary == []
    assert runtime_snapshot.replacements == []
    assert runtime_snapshot.snippets == []


def test_writing_tools_preserve_multiline_structure(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")
    store.create_dictionary_entry(DictionaryEntryPayload(canonical_text="Blue Anchor", aliases=["blue anchor"], enabled=True))
    store.create_replacement_entry(
        ReplacementEntryPayload(
            source_text="pls advise",
            replacement_text="Please advise.",
            match_type="inline",
            enabled=True,
        )
    )
    store.create_snippet_entry(
        SnippetEntryPayload(
            trigger="daily checklist",
            expansion="- First item\n- Second item\n\n  indented note",
            match_type="exact",
            enabled=True,
        )
    )

    snapshot = store.get_tools()

    assert (
        apply_dictionary_entries("First line\nblue anchor ready", snapshot.dictionary)
        == "First line\nBlue Anchor ready"
    )
    assert (
        apply_replacement_entries("First line\npls advise on eta", snapshot.replacements)
        == "First line\nPlease advise. on eta"
    )
    assert apply_snippet_entries("daily checklist", snapshot.snippets) == "- First item\n- Second item\n\n  indented note"


def test_writing_tools_store_history_round_trip(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")

    item = store.record_history(
        mode="smart_transform",
        transcript="draft a delay update",
        final_output="Shipment delay update drafted.",
        telemetry={"intent": "email_rewrite"},
        context={"app_name": "Outlook"},
        stt_provider="groq",
        stt_model="whisper-large-v3-turbo",
        llm_provider="groq",
        llm_model="llama3-70b-8192",
    )

    listed = store.list_history()
    assert [entry.id for entry in listed] == [item.id]
    assert listed[0].telemetry["intent"] == "email_rewrite"
    assert listed[0].context["app_name"] == "Outlook"

    store.delete_history_item(item.id)
    assert store.list_history() == []


def test_writing_tools_store_persists_notes_and_projects_library_items(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")

    note = store.append_note(
        InboxNote(
            id="note-1",
            text="Remember the Atlas handoff.",
            created_at="2026-04-17T08:00:00Z",
            app_name="Notes",
            bundle_id=None,
            window_title="Today",
            page_title=None,
            url_host=None,
            url_path=None,
            surface_kind="multiline_input",
            source_mode="dictation",
            source_kind="spoken_text",
            output_mode="plain_text",
        )
    )
    history = store.record_history(
        mode="smart_transform",
        transcript="make this concise",
        final_output="A concise version of the update.",
        telemetry={"output_mode": "plain_text", "skill_used": {"id": "system_dictation", "name": "Dictation"}},
        context={"app_name": "Slack", "window_title": "eng-updates", "surface_kind": "chat_input"},
        stt_provider="mlx-whisper",
        stt_model="mlx-community/whisper-base-mlx",
        llm_provider="lmstudio",
        llm_model="local-model",
    )

    assert store.list_notes()[0].id == note.id

    items = store.list_library_items()
    assert [item.source_type for item in items] == ["history", "note"]
    assert items[0].metadata.skill_id == "system_dictation"
    assert items[1].metadata.source_kind == "spoken_text"

    memory_sources = store.list_library_memory_sources()
    assert {source.source_type for source in memory_sources} == {"history", "note"}
    assert any(source.source_id == str(history.id) for source in memory_sources)


def test_writing_tools_store_migrates_legacy_inbox_jsonl_once(tmp_path, monkeypatch):
    app_home = tmp_path / ".steervox"
    app_home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("STEERVOX_HOME", str(app_home))
    legacy_path = app_home / "inbox.jsonl"
    legacy_path.write_text(
        "\n".join(
            [
                '{"id":"note-1","text":"Atlas update","created_at":"2026-04-17T08:00:00Z","app_name":"Notes","source_mode":"dictation","source_kind":"spoken_text"}',
                '{"id":"note-2","text":"Run summary","created_at":"2026-04-17T08:05:00Z","app_name":"SteerVox","source_mode":"local_task","source_kind":"task_result"}',
                '{not valid json}',
            ]
        ),
        encoding="utf-8",
    )

    store = WritingToolsStore(path=app_home / "writing_memory.sqlite3")
    notes = store.list_notes()
    assert [note.id for note in notes] == ["note-2", "note-1"]

    backups = list(app_home.glob("inbox.jsonl.migrated-*.bak"))
    assert len(backups) == 1
    assert not legacy_path.exists()

    reloaded = WritingToolsStore(path=app_home / "writing_memory.sqlite3")
    assert [note.id for note in reloaded.list_notes()] == ["note-2", "note-1"]
    assert len(list(app_home.glob("inbox.jsonl.migrated-*.bak"))) == 1


def test_writing_tools_store_surfaces_duplicate_entries_cleanly(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")

    store.create_dictionary_entry(
        DictionaryEntryPayload(canonical_text="Blue Anchor", aliases=["blue anchor"], enabled=True)
    )
    with pytest.raises(ValueError, match="matching entry"):
        store.create_dictionary_entry(
            DictionaryEntryPayload(canonical_text="Blue Anchor", aliases=["blue anchor"], enabled=True)
        )

    first = store.create_replacement_entry(
        ReplacementEntryPayload(source_text="pls advise", replacement_text="Please advise.", match_type="inline", enabled=True)
    )
    second = store.create_replacement_entry(
        ReplacementEntryPayload(source_text="eta", replacement_text="ETA", match_type="inline", enabled=True)
    )

    with pytest.raises(ValueError, match="matching entry"):
        store.update_replacement_entry(
            second.id,
            ReplacementEntryPayload(source_text=first.source_text, replacement_text="ETA", match_type="inline", enabled=True),
        )


def test_record_history_uses_write_retry_helper(monkeypatch, tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")
    original = store._run_write_with_lock_retries
    calls = {"count": 0}

    def wrapped(callback):
        calls["count"] += 1
        return original(callback)

    monkeypatch.setattr(store, "_run_write_with_lock_retries", wrapped)

    item = store.record_history(
        mode="dictation",
        transcript="hello",
        final_output="hello",
        telemetry={},
        context={"app_name": "Notes"},
        stt_provider="groq",
        stt_model="whisper-large-v3-turbo",
        llm_provider=None,
        llm_model=None,
    )

    assert calls["count"] == 1
    assert item.transcript == "hello"


def test_dictionary_payload_rejects_oversized_text():
    long_source = "a" * (MAX_SOURCE_TEXT_CHARS + 1)
    with pytest.raises(ValueError, match="Alias"):
        DictionaryEntryPayload(canonical_text="ok", aliases=[long_source])


def test_replacement_payload_rejects_oversized_replacement_text():
    long_replacement = "x" * (MAX_REPLACEMENT_TEXT_CHARS + 1)
    with pytest.raises(ValueError, match="Replacement text"):
        ReplacementEntryPayload(source_text="hi", replacement_text=long_replacement)


def test_snippet_payload_rejects_oversized_expansion():
    long_expansion = "y" * (MAX_SNIPPET_EXPANSION_CHARS + 1)
    with pytest.raises(ValueError, match="Expansion"):
        SnippetEntryPayload(trigger="trig", expansion=long_expansion)


def test_record_history_truncates_long_transcript_and_caps_blobs(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")
    huge_transcript = "z" * (MAX_HISTORY_TRANSCRIPT_CHARS + 5_000)
    huge_telemetry = {"blob": "k" * (MAX_HISTORY_JSON_BLOB_CHARS + 1_000)}

    item = store.record_history(
        mode="dictation",
        transcript=huge_transcript,
        final_output="ok",
        telemetry=huge_telemetry,
        context={"app_name": "Notes"},
        stt_provider=None,
        stt_model=None,
        llm_provider=None,
        llm_model=None,
    )

    assert len(item.transcript) == MAX_HISTORY_TRANSCRIPT_CHARS
    # Oversized telemetry should be replaced with an empty dict.
    assert item.telemetry == {}
    # Context should still round-trip cleanly.
    assert item.context == {"app_name": "Notes"}


def test_record_history_enforces_max_history_items(tmp_path, monkeypatch):
    monkeypatch.setattr("writing_memory.MAX_HISTORY_ITEMS", 5)
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")

    for index in range(8):
        store.record_history(
            mode="dictation",
            transcript=f"entry {index}",
            final_output=f"entry {index}",
            telemetry={},
            context={},
            stt_provider=None,
            stt_model=None,
            llm_provider=None,
            llm_model=None,
        )

    listed = store.list_history()
    assert len(listed) == 5
    transcripts = [item.transcript for item in listed]
    assert transcripts == [f"entry {n}" for n in (7, 6, 5, 4, 3)]


def test_history_round_trip_handles_corrupt_telemetry_json(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")

    item = store.record_history(
        mode="dictation",
        transcript="hello world",
        final_output="hello world",
        telemetry={"intent": "dictation"},
        context={"app_name": "Notes"},
        stt_provider=None,
        stt_model=None,
        llm_provider=None,
        llm_model=None,
    )

    # Corrupt the underlying JSON column directly so the loader has to recover.
    with sqlite3.connect(store.path) as raw:
        raw.execute(
            "UPDATE history_items SET telemetry_json = ?, context_json = ? WHERE id = ?",
            ("{not valid json", "also bad", item.id),
        )
        raw.commit()

    listed = store.list_history()
    assert len(listed) == 1
    assert listed[0].telemetry == {}
    assert listed[0].context == {}


def test_find_tool_entry_uses_direct_query_after_create(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")

    entry = store.create_dictionary_entry(
        DictionaryEntryPayload(canonical_text="Alpha", aliases=["alpha"])
    )
    assert entry.aliases == ["alpha"]

    fetched = store._find_tool_entry("dictionary_entries", entry.id)
    assert fetched.id == entry.id
    assert fetched.canonical_text == "Alpha"

    with pytest.raises(ValueError, match="not found"):
        store._find_tool_entry("dictionary_entries", entry.id + 999)


def test_write_retry_helper_retries_locked_callbacks(tmp_path):
    store = WritingToolsStore(path=tmp_path / "writing_memory.sqlite3")
    attempts = {"count": 0}

    def callback(conn):
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise sqlite3.OperationalError("database is locked")
        cursor = conn.execute(
            """
            INSERT INTO dictionary_entries (canonical_text, aliases_json, enabled, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            ("Blue Peak", '["blue peak"]', 1, "2026-03-23T00:00:00Z"),
        )
        return int(cursor.lastrowid)

    entry_id = store._run_write_with_lock_retries(callback)

    assert attempts["count"] == 3
    assert entry_id > 0


def test_dictionary_payload_supports_legacy_source_text_field():
    payload = DictionaryEntryPayload(source_text="blue anchor", canonical_text="Blue Anchor")

    assert payload.aliases == ["blue anchor"]


def test_writing_tools_store_migrates_v1_dictionary_entries(tmp_path):
    db_path = tmp_path / "writing_memory.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE dictionary_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_text TEXT NOT NULL COLLATE NOCASE UNIQUE,
                canonical_text TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE replacement_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_text TEXT NOT NULL COLLATE NOCASE UNIQUE,
                replacement_text TEXT NOT NULL,
                match_type TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE snippet_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trigger TEXT NOT NULL COLLATE NOCASE UNIQUE,
                expansion TEXT NOT NULL,
                match_type TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE history_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mode TEXT NOT NULL,
                transcript TEXT NOT NULL,
                final_output TEXT NOT NULL,
                created_at TEXT NOT NULL,
                telemetry_json TEXT NOT NULL,
                context_json TEXT NOT NULL,
                stt_provider TEXT,
                stt_model TEXT,
                llm_provider TEXT,
                llm_model TEXT
            );
            """
        )
        conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '1')")
        conn.execute(
            """
            INSERT INTO dictionary_entries (source_text, canonical_text, enabled, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            ("blue anchor", "Blue Anchor", 1, "2026-04-09T00:00:00Z"),
        )
        conn.commit()

    store = WritingToolsStore(path=db_path)
    snapshot = store.get_tools()

    assert snapshot.dictionary[0].canonical_text == "Blue Anchor"
    assert snapshot.dictionary[0].aliases == ["blue anchor"]
