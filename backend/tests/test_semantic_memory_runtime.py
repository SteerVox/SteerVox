from pathlib import Path

from semantic_memory import SemanticMemoryClient, SemanticMemoryItem


def test_optional_semantic_runtime_is_not_in_build_requirements():
    backend_dir = Path(__file__).resolve().parents[1]
    build_requirements = (backend_dir / "requirements-build.txt").read_text(encoding="utf-8")
    runtime_requirements = (backend_dir / "requirements.txt").read_text(encoding="utf-8")

    assert "requirements-semantic-memory" not in build_requirements
    assert "sentence-transformers" not in build_requirements
    assert "transformers" not in build_requirements
    assert "torch" not in build_requirements
    assert "sentence-transformers" not in runtime_requirements
    assert "pysqlite3" not in build_requirements


def test_optional_semantic_runtime_uses_optional_runtime_only_pins():
    backend_dir = Path(__file__).resolve().parents[1]
    semantic_requirements = (backend_dir / "requirements-semantic-memory.txt").read_text(encoding="utf-8")

    assert "pysqlite3==0.6.0" in semantic_requirements
    assert "sqlite-vec==0.1.9" in semantic_requirements
    assert "sentence-transformers==5.3.0" in semantic_requirements
    assert "sentence-transformers==5.1.2" not in semantic_requirements


def test_semantic_memory_client_cooldown_skips_repeated_failures(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "semantic-memory"
    python_path = runtime_dir / "venv" / "bin" / "python3"
    helper_path = runtime_dir / "semantic_memory_helper.py"
    python_path.parent.mkdir(parents=True, exist_ok=True)
    helper_path.parent.mkdir(parents=True, exist_ok=True)
    python_path.write_text("", encoding="utf-8")
    helper_path.write_text("", encoding="utf-8")

    client = SemanticMemoryClient(
        runtime_dir=runtime_dir,
        python_path=python_path,
        helper_path=helper_path,
        log_path=runtime_dir / "runtime.log",
        install_log_path=runtime_dir / "install.log",
        state_path=runtime_dir / "state.json",
    )

    calls = {"count": 0}
    monotonic_box = {"value": 100.0}

    def _fake_monotonic():
        return monotonic_box["value"]

    def _fail_request(*_args, **_kwargs):
        calls["count"] += 1
        raise RuntimeError("semantic helper exploded")

    monkeypatch.setattr("semantic_memory.time.monotonic", _fake_monotonic)
    monkeypatch.setattr(client, "_request", _fail_request)

    payload_items = [SemanticMemoryItem(id=1, retrieval_text="Project Atlas leadership update")]
    assert client.query(query="Atlas leadership update", items=payload_items, limit=3) == {}
    assert calls["count"] == 1

    assert client.query(query="Atlas leadership update", items=payload_items, limit=3) == {}
    assert calls["count"] == 1

    monotonic_box["value"] += 31.0
    assert client.query(query="Atlas leadership update", items=payload_items, limit=3) == {}
    assert calls["count"] == 2
