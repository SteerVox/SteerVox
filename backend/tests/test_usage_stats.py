import importlib
import json
import sys

from fastapi.testclient import TestClient

from engine import SteerVoxEngine
from usage_stats import UsageStatsStore


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


def test_usage_stats_store_starts_with_zero_state():
    store = UsageStatsStore()

    stats = store.get_stats()

    assert stats.dictation_runs == 0
    assert stats.smart_runs == 0
    assert stats.fastest_dictation_stt_ms is None
    assert stats.fastest_smart_stt_ms is None
    assert stats.time_saved_seconds_total == 0
    assert stats.tracking_started_at


def test_engine_records_dictation_and_smart_usage_separately():
    store = UsageStatsStore()
    engine = SteerVoxEngine(usage_stats_store=store)

    engine._record_usage_success(
        mode="dictation",
        output_text="a" * 400,
        stt_latency_ms=320,
        recording_duration_ms=2000,
        pipeline_duration_ms=1000,
    )
    engine._record_usage_success(
        mode="smart_transform",
        output_text="b" * 500,
        stt_latency_ms=280,
        recording_duration_ms=3000,
        pipeline_duration_ms=1200,
    )

    stats = store.get_stats()

    assert stats.dictation_runs == 1
    assert stats.smart_runs == 1
    assert stats.fastest_dictation_stt_ms == 320
    assert stats.fastest_smart_stt_ms == 280
    assert stats.time_saved_seconds_total > 0


def test_engine_skips_low_signal_usage_entries():
    store = UsageStatsStore()
    engine = SteerVoxEngine(usage_stats_store=store)

    for text in ("", "   ", ".", "..."):
        engine._record_usage_success(
            mode="smart_transform",
            output_text=text,
            stt_latency_ms=120,
            recording_duration_ms=1000,
            pipeline_duration_ms=1000,
        )

    stats = store.get_stats()

    assert stats.dictation_runs == 0
    assert stats.smart_runs == 0
    assert stats.fastest_dictation_stt_ms is None
    assert stats.fastest_smart_stt_ms is None
    assert stats.time_saved_seconds_total == 0


def test_time_saved_never_goes_negative():
    store = UsageStatsStore()

    stats = store.record_success(
        mode="dictation",
        output_text="barely anything",
        stt_latency_ms=190,
        recording_duration_ms=10000,
        pipeline_duration_ms=5000,
    )

    assert stats.time_saved_seconds_total == 0


def test_usage_endpoints_return_zero_state_and_reset():
    server = load_server()
    client = TestClient(server.app)

    empty = client.get("/usage")
    assert empty.status_code == 200
    assert empty.json()["dictation_runs"] == 0
    assert empty.json()["smart_runs"] == 0

    server.usage_stats_store.record_success(
        mode="smart_transform",
        output_text="c" * 420,
        stt_latency_ms=250,
        recording_duration_ms=2000,
        pipeline_duration_ms=1500,
    )

    populated = client.get("/usage")
    assert populated.status_code == 200
    assert populated.json()["smart_runs"] == 1
    assert populated.json()["fastest_smart_stt_ms"] == 250

    reset = client.delete("/usage")
    assert reset.status_code == 200
    payload = reset.json()
    assert payload["status"] == "success"
    assert payload["usage"]["dictation_runs"] == 0
    assert payload["usage"]["smart_runs"] == 0
    assert payload["usage"]["time_saved_seconds_total"] == 0


def test_usage_store_keeps_corrupt_file_for_diagnostics(tmp_path):
    path = tmp_path / "usage.json"
    path.write_text("{not-json")

    store = UsageStatsStore(path=path)

    stats = store.get_stats()

    assert stats.dictation_runs == 0
    assert stats.smart_runs == 0
    assert path.read_text() == "{not-json"
