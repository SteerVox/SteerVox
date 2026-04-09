from local_memory import LocalMemoryStore
from writing_memory import HistoryItem


def _history_item(
    item_id: int,
    *,
    transcript: str,
    final_output: str,
    app_name: str = "Slack",
    url_host: str | None = None,
    domain_id: str | None = None,
) -> HistoryItem:
    telemetry = {"domain_id": domain_id} if domain_id else {}
    context = {
        "app_name": app_name,
        "url_host": url_host,
    }
    return HistoryItem(
        id=item_id,
        mode="smart_transform",
        transcript=transcript,
        final_output=final_output,
        created_at=f"2026-04-03T0{item_id}:00:00Z",
        telemetry=telemetry,
        context=context,
        stt_provider="groq",
        stt_model="whisper-large-v3-turbo",
        llm_provider="anthropic",
        llm_model="claude-sonnet-4-5",
    )


def test_local_memory_store_learns_explicit_preferences_and_facts(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")

    items = [
        _history_item(
            1,
            transcript="I prefer concise bullet updates.",
            final_output="I prefer concise bullet updates.",
            app_name="Slack",
        ),
        _history_item(
            2,
            transcript="My name is Abhishek Rai.",
            final_output="My name is Abhishek Rai.",
            app_name="Notes",
        ),
    ]

    records = store.rebuild_from_history(items, reset_tombstones=True)

    assert len(records) == 2
    assert any(record.kind == "writing_preference" and "concise bullet updates" in record.summary.lower() for record in records)
    assert any(record.kind == "user_fact" and "abhishek rai" in record.summary.lower() for record in records)


def test_local_memory_store_merges_recurring_project_mentions(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")

    records = store.rebuild_from_history(
        [
            _history_item(
                1,
                transcript="Draft a shorter status update for Project Atlas.",
                final_output="Shorten the Project Atlas status update.",
                app_name="Slack",
            ),
            _history_item(
                2,
                transcript="Summarize Project Atlas blockers for leadership.",
                final_output="Summarize Project Atlas blockers for leadership.",
                app_name="Slack",
            ),
        ],
        reset_tombstones=True,
    )

    assert len(records) == 1
    assert records[0].kind == "person_or_project"
    assert records[0].evidence_count == 2
    assert records[0].source_history_ids == [1, 2]
    assert "Atlas" in records[0].summary


def test_local_memory_store_ignores_one_off_ambiguous_history(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")

    records = store.rebuild_from_history(
        [
            _history_item(
                1,
                transcript="Remind me tomorrow.",
                final_output="Remind me tomorrow.",
            ),
        ],
        reset_tombstones=True,
    )

    assert records == []


def test_local_memory_store_disable_delete_and_rebuild_flow(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")
    history = [
        _history_item(
            1,
            transcript="I prefer concise bullet updates.",
            final_output="I prefer concise bullet updates.",
            app_name="Slack",
            domain_id="shipping",
        ),
    ]
    records = store.rebuild_from_history(history, reset_tombstones=True)
    assert len(records) == 1

    updated = store.update_memory_enabled(records[0].id, False)
    assert updated.enabled is False
    assert store.build_context_block(transcript="write the shipping update", context={"app_name": "Slack", "domain_id": "shipping"}) == ""

    store.delete_memory(records[0].id)
    assert store.list_memories() == []

    rebuilt = store.rebuild_from_history(history, reset_tombstones=True)
    assert len(rebuilt) == 1
    assert rebuilt[0].enabled is True


def test_local_memory_scope_match_is_case_insensitive(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")
    store.rebuild_from_history(
        [
            _history_item(
                1,
                transcript="I prefer concise bullet updates.",
                final_output="I prefer concise bullet updates.",
                app_name="Slack",
            ),
        ],
        reset_tombstones=True,
    )

    # Same app, different casing should still match for the scope bonus
    block_lower = store.build_context_block(
        transcript="give me a concise bullet update",
        context={"app_name": "slack"},
    )
    assert "concise bullet" in block_lower.lower()

    block_upper = store.build_context_block(
        transcript="give me a concise bullet update",
        context={"app_name": "SLACK"},
    )
    assert "concise bullet" in block_upper.lower()


def test_local_memory_rebuild_skips_corrupt_history_items(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")

    class _BrokenHistoryItem:
        id = 99
        transcript = property(lambda self: (_ for _ in ()).throw(RuntimeError("boom")))
        final_output = ""
        created_at = "2026-04-03T01:00:00Z"
        telemetry = {}
        context = {}

    good_item = _history_item(
        2,
        transcript="My name is Abhishek Rai.",
        final_output="My name is Abhishek Rai.",
        app_name="Notes",
    )

    records = store.rebuild_from_history(
        [_BrokenHistoryItem(), good_item],
        reset_tombstones=True,
    )

    # The corrupt item is skipped without crashing the rebuild.
    assert any("Abhishek" in record.summary for record in records)


def test_local_memory_char_budget_excludes_overlong_first_entry(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")
    long_preference_text = "concise " + ("very thorough deeply " * 30)
    store.rebuild_from_history(
        [
            _history_item(
                1,
                transcript=f"I prefer {long_preference_text} bullet updates.",
                final_output=f"I prefer {long_preference_text} bullet updates.",
                app_name="Slack",
            ),
        ],
        reset_tombstones=True,
    )

    # With a tiny budget the long memory must not push the block over the cap.
    block = store.build_context_block(
        transcript="please write a concise update",
        context={"app_name": "Slack"},
        char_budget=20,
    )
    assert len(block) <= 200  # generous: instruction line + at most one short summary


def test_local_memory_incremental_learning_matches_rebuild(tmp_path):
    history = [
        _history_item(
            1,
            transcript="I prefer concise bullet updates.",
            final_output="I prefer concise bullet updates.",
            app_name="Slack",
        ),
        _history_item(
            2,
            transcript="Summarize Project Atlas blockers for leadership.",
            final_output="Summarize Project Atlas blockers for leadership.",
            app_name="Slack",
        ),
        _history_item(
            3,
            transcript="Draft a shorter status update for Project Atlas.",
            final_output="Shorten the Project Atlas status update.",
            app_name="Slack",
        ),
    ]

    incremental_store = LocalMemoryStore(tmp_path / "incremental.sqlite3")
    for item in history:
        incremental_store.learn_from_history_item(item)

    rebuilt_store = LocalMemoryStore(tmp_path / "rebuilt.sqlite3")
    rebuilt = rebuilt_store.rebuild_from_history(history, reset_tombstones=True)
    incremental = incremental_store.list_memories()

    assert [
        (item.kind, item.summary, item.evidence_count, item.source_history_ids)
        for item in incremental
    ] == [
        (item.kind, item.summary, item.evidence_count, item.source_history_ids)
        for item in rebuilt
    ]


def test_local_memory_hybrid_lexical_retrieval_handles_simple_paraphrase(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")
    store.rebuild_from_history(
        [
            _history_item(
                1,
                transcript="I prefer concise bullet updates.",
                final_output="I prefer concise bullet updates.",
                app_name="Slack",
            ),
        ],
        reset_tombstones=True,
    )

    block = store.build_context_block(
        transcript="write a brief bulleted update for Slack",
        context={"app_name": "Slack"},
        semantic_retrieval_enabled=False,
    )

    assert "concise bullet updates" in block.lower()


def test_local_memory_tombstone_blocks_incremental_relearning(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")
    original = _history_item(
        1,
        transcript="I prefer concise bullet updates.",
        final_output="I prefer concise bullet updates.",
        app_name="Slack",
    )
    store.learn_from_history_item(original)
    memory_id = store.list_memories()[0].id
    store.delete_memory(memory_id)

    store.learn_from_history_item(
        _history_item(
            2,
            transcript="I prefer concise bullet updates.",
            final_output="I prefer concise bullet updates.",
            app_name="Slack",
        )
    )

    assert store.list_memories() == []


def test_local_memory_semantic_bonus_can_retrieve_without_lexical_overlap(tmp_path):
    store = LocalMemoryStore(tmp_path / "local_memory.sqlite3")
    store.rebuild_from_history(
        [
            _history_item(
                1,
                transcript="I prefer concise bullet updates.",
                final_output="I prefer concise bullet updates.",
                app_name="Slack",
            ),
        ],
        reset_tombstones=True,
    )

    target = store.list_memories()[0]
    store.semantic_client.query = lambda **kwargs: {target.id: 0.92}  # type: ignore[method-assign]

    without_semantic = store.retrieve_memories(
        transcript="tighten this for leadership",
        context={"app_name": "Mail"},
        semantic_retrieval_enabled=False,
    )
    with_semantic = store.retrieve_memories(
        transcript="tighten this for leadership",
        context={"app_name": "Mail"},
        semantic_retrieval_enabled=True,
    )

    assert without_semantic == []
    assert [item.id for item in with_semantic] == [target.id]
