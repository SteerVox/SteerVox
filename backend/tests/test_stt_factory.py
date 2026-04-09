from __future__ import annotations

import builtins
import sys
import types

import pytest

import requests

from providers.stt_factory import (
    MLXWhisperSTTClient,
    NvidiaRivaSTTClient,
    REMOTE_STT_MAX_ATTEMPTS,
    RemoteSTTClient,
    STTFactory,
    STTHintPayload,
    STTTransientError,
    build_local_stt_status,
)


def test_stt_factory_returns_mlx_client():
    client = STTFactory.get_client("mlx-whisper")
    assert isinstance(client, MLXWhisperSTTClient)


def test_stt_factory_returns_nvidia_client():
    client = STTFactory.get_client("nvidia")
    assert isinstance(client, NvidiaRivaSTTClient)


def test_nvidia_client_raises_clear_error_when_optional_runtime_is_missing(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name in {"grpc", "riva", "riva.client"}:
            raise ImportError("missing optional dependency")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "nvidia-key")
    monkeypatch.setattr(builtins, "__import__", fake_import)

    client = NvidiaRivaSTTClient()

    with pytest.raises(RuntimeError, match="nvidia-riva-client"):
        client.transcribe(str(audio_path), model="openai/whisper-large-v3", language="en")


def test_nvidia_client_transcribes_with_offline_whisper_mode(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    observed: dict[str, object] = {}

    class FakeRecognitionConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeAuth:
        def __init__(self, *, uri, use_ssl, metadata_args):
            observed["auth"] = {
                "uri": uri,
                "use_ssl": use_ssl,
                "metadata_args": metadata_args,
            }

    class FakeASRService:
        def __init__(self, auth):
            observed["service_auth"] = auth

        def offline_recognize(self, audio_bytes, config):
            observed["offline_audio_bytes"] = audio_bytes
            observed["offline_config"] = config.kwargs
            return types.SimpleNamespace(
                results=[
                    types.SimpleNamespace(
                        alternatives=[types.SimpleNamespace(transcript="transcribed text")]
                    )
                ]
            )

    def fake_add_audio_file_specs_to_config(config, audio_file_path):
        observed["audio_specs"] = {
            "audio_file_path": audio_file_path,
            "language_code": config.kwargs.get("language_code"),
        }

    def fake_add_word_boosting_to_config(config, *, boosted_lm_words, boosted_lm_score):
        observed["word_boosting"] = {
            "words": boosted_lm_words,
            "score": boosted_lm_score,
        }

    fake_riva_client = types.SimpleNamespace(
        Auth=FakeAuth,
        ASRService=FakeASRService,
        RecognitionConfig=FakeRecognitionConfig,
        add_audio_file_specs_to_config=fake_add_audio_file_specs_to_config,
        add_word_boosting_to_config=fake_add_word_boosting_to_config,
    )
    fake_riva_module = types.ModuleType("riva")
    fake_riva_module.client = fake_riva_client

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "nvidia-key")
    monkeypatch.setitem(sys.modules, "grpc", types.SimpleNamespace(RpcError=Exception))
    monkeypatch.setitem(sys.modules, "riva", fake_riva_module)
    monkeypatch.setitem(sys.modules, "riva.client", fake_riva_client)

    client = NvidiaRivaSTTClient()
    result = client.transcribe(
        str(audio_path),
        model="openai/whisper-large-v3",
        language=None,
        hints=STTHintPayload(
            keywords=("bill of lading", "carrier"),
            prompt="Prefer these terms when they appear in speech.",
        ),
    )

    assert result == "transcribed text"
    assert observed["auth"] == {
        "uri": "grpc.nvcf.nvidia.com:443",
        "use_ssl": True,
        "metadata_args": [
            ("function-id", "b702f636-f60c-4a3d-a6f4-f3568c13bd7d"),
            ("authorization", "Bearer nvidia-key"),
        ],
    }
    assert observed["audio_specs"] == {
        "audio_file_path": str(audio_path),
        "language_code": "multi",
    }
    assert observed["offline_config"] == {
        "enable_automatic_punctuation": True,
        "max_alternatives": 1,
        "profanity_filter": False,
        "verbatim_transcripts": True,
        "language_code": "multi",
    }
    assert observed["word_boosting"] == {
        "words": ["bill of lading", "carrier"],
        "score": 20.0,
    }


def test_nvidia_client_transcribes_with_streaming_parakeet_mode(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    observed: dict[str, object] = {}

    class FakeRecognitionConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeStreamingRecognitionConfig:
        def __init__(self, *, config, interim_results):
            self.config = config
            self.interim_results = interim_results

    class FakeAudioChunkFileIterator:
        def __init__(self, audio_file_path, chunk_n_frames, delay_callback):
            observed["chunk_iterator"] = {
                "audio_file_path": audio_file_path,
                "chunk_n_frames": chunk_n_frames,
                "delay_callback": delay_callback,
            }

        def __enter__(self):
            return iter([b"chunk"])

        def __exit__(self, exc_type, exc, tb):
            return False

    class FakeAuth:
        def __init__(self, *, uri, use_ssl, metadata_args):
            observed["auth"] = {
                "uri": uri,
                "use_ssl": use_ssl,
                "metadata_args": metadata_args,
            }

    class FakeASRService:
        def __init__(self, auth):
            observed["service_auth"] = auth

        def streaming_response_generator(self, *, audio_chunks, streaming_config):
            observed["streaming_config"] = {
                "config": streaming_config.config.kwargs,
                "interim_results": streaming_config.interim_results,
                "chunks": list(audio_chunks),
            }
            return iter([
                types.SimpleNamespace(
                    results=[
                        types.SimpleNamespace(
                            is_final=True,
                            alternatives=[types.SimpleNamespace(transcript="namaste duniya")],
                        )
                    ]
                )
            ])

    def fake_add_audio_file_specs_to_config(config, audio_file_path):
        observed["audio_specs"] = {
            "audio_file_path": audio_file_path,
            "config": config.config.kwargs if hasattr(config, "config") else config.kwargs,
        }

    fake_riva_client = types.SimpleNamespace(
        Auth=FakeAuth,
        ASRService=FakeASRService,
        RecognitionConfig=FakeRecognitionConfig,
        StreamingRecognitionConfig=FakeStreamingRecognitionConfig,
        AudioChunkFileIterator=FakeAudioChunkFileIterator,
        add_audio_file_specs_to_config=fake_add_audio_file_specs_to_config,
        add_word_boosting_to_config=lambda *args, **kwargs: None,
    )
    fake_riva_module = types.ModuleType("riva")
    fake_riva_module.client = fake_riva_client

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "nvidia-key")
    monkeypatch.setitem(sys.modules, "grpc", types.SimpleNamespace(RpcError=Exception))
    monkeypatch.setitem(sys.modules, "riva", fake_riva_module)
    monkeypatch.setitem(sys.modules, "riva.client", fake_riva_client)

    client = NvidiaRivaSTTClient()
    result = client.transcribe(
        str(audio_path),
        model="nvidia/parakeet-1_1b-rnnt-multilingual-asr",
        language="hi",
    )

    assert result == "namaste duniya"
    assert observed["chunk_iterator"] == {
        "audio_file_path": str(audio_path),
        "chunk_n_frames": 1600,
        "delay_callback": None,
    }
    assert observed["streaming_config"] == {
        "config": {
            "enable_automatic_punctuation": True,
            "max_alternatives": 1,
            "profanity_filter": False,
            "verbatim_transcripts": True,
            "language_code": "hi-IN",
        },
        "interim_results": False,
        "chunks": [b"chunk"],
    }


def test_mlx_client_raises_clear_error_when_optional_runtime_is_missing(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "mlx_whisper":
            raise ImportError("missing optional dependency")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setattr(builtins, "__import__", fake_import)

    client = MLXWhisperSTTClient()

    with pytest.raises(RuntimeError, match="optional and is not installed"):
        client.transcribe(str(audio_path), model="mlx-community/whisper-base-mlx", language="en")


def test_mlx_client_reports_bundled_runtime_failure_in_frozen_mode(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "mlx_whisper":
            raise ImportError("broken frozen runtime")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setattr("providers.stt_factory.is_frozen_runtime", lambda: True)
    monkeypatch.setattr(builtins, "__import__", fake_import)

    client = MLXWhisperSTTClient()

    with pytest.raises(RuntimeError, match="bundled runtime"):
        client.transcribe(str(audio_path), model="mlx-community/whisper-base-mlx", language="en")


def test_mlx_client_surfaces_missing_ffmpeg_dependency(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")

    class FakeMlxWhisperModule:
        @staticmethod
        def transcribe(*args, **kwargs):
            raise FileNotFoundError(2, "No such file or directory", "ffmpeg")

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=FakeMlxWhisperModule.transcribe))
    monkeypatch.setattr(MLXWhisperSTTClient, "_ensure_local_model_path", lambda self, model_repo: "/tmp/mlx-model")

    client = MLXWhisperSTTClient()

    with pytest.raises(RuntimeError, match="requires ffmpeg"):
        client.transcribe(str(audio_path), model="mlx-community/whisper-tiny", language="en")


def test_mlx_client_surfaces_packaged_runtime_error_when_ffmpeg_missing(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")

    class FakeMlxWhisperModule:
        @staticmethod
        def transcribe(*args, **kwargs):
            raise FileNotFoundError(2, "No such file or directory", "ffmpeg")

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setattr("providers.stt_factory.is_frozen_runtime", lambda: True)
    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=FakeMlxWhisperModule.transcribe))
    monkeypatch.setattr(MLXWhisperSTTClient, "_ensure_local_model_path", lambda self, model_repo: "/tmp/mlx-model")

    client = MLXWhisperSTTClient()

    with pytest.raises(RuntimeError, match="Bundled local speech runtime is incomplete or missing"):
        client.transcribe(str(audio_path), model="mlx-community/whisper-tiny", language="en")


def test_build_local_stt_status_prefers_bundled_ffmpeg(monkeypatch, tmp_path):
    bundled_dir = tmp_path / "ffmpeg" / "bin"
    bundled_dir.mkdir(parents=True)
    for binary_name in ("ffmpeg", "ffprobe"):
        binary_path = bundled_dir / binary_name
        binary_path.write_text("")
        binary_path.chmod(0o755)

    model_dir = tmp_path / "models"
    model_dir.mkdir()
    (model_dir / "config.json").write_text("{}")
    (model_dir / "weights.safetensors").write_text("weights")

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setattr("providers.stt_factory.is_frozen_runtime", lambda: True)
    monkeypatch.setattr("providers.stt_factory.get_bundled_ffmpeg_bin_dir", lambda: bundled_dir)
    monkeypatch.setattr("providers.stt_factory.shutil.which", lambda binary: f"/usr/bin/{binary}")
    monkeypatch.setattr("providers.stt_factory.importlib.util.find_spec", lambda name: object() if name == "mlx_whisper" else None)
    monkeypatch.setattr(MLXWhisperSTTClient, "_get_local_model_dir", lambda self, model_repo: model_dir)

    status = build_local_stt_status("mlx-whisper", "mlx-community/whisper-large-v3-turbo")

    assert status == {
        "runtime_mode": "bundled",
        "runtime_ready": True,
        "ffmpeg_available": True,
        "ffmpeg_source": "bundled",
        "selected_model": "mlx-community/whisper-large-v3-turbo",
        "selected_model_ready": True,
        "detail": "Bundled local speech is ready.",
    }


def test_build_local_stt_status_falls_back_to_system_ffmpeg(monkeypatch, tmp_path):
    model_dir = tmp_path / "models"
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setattr("providers.stt_factory.is_frozen_runtime", lambda: True)
    monkeypatch.setattr("providers.stt_factory.get_bundled_ffmpeg_bin_dir", lambda: tmp_path / "missing")
    monkeypatch.setattr("providers.stt_factory.shutil.which", lambda binary: f"/usr/local/bin/{binary}")
    monkeypatch.setattr("providers.stt_factory.importlib.util.find_spec", lambda name: object() if name == "mlx_whisper" else None)
    monkeypatch.setattr(MLXWhisperSTTClient, "_get_local_model_dir", lambda self, model_repo: model_dir)

    status = build_local_stt_status("mlx-whisper", "mlx-community/whisper-base-mlx")

    assert status is not None
    assert status["ffmpeg_available"] is True
    assert status["ffmpeg_source"] == "system"
    assert "system PATH" in status["detail"]


def test_build_local_stt_status_reports_missing_ffmpeg_in_packaged_mode(monkeypatch, tmp_path):
    model_dir = tmp_path / "models"
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setattr("providers.stt_factory.is_frozen_runtime", lambda: True)
    monkeypatch.setattr("providers.stt_factory.get_bundled_ffmpeg_bin_dir", lambda: tmp_path / "missing")
    monkeypatch.setattr("providers.stt_factory.shutil.which", lambda binary: None)
    monkeypatch.setattr("providers.stt_factory.importlib.util.find_spec", lambda name: object() if name == "mlx_whisper" else None)
    monkeypatch.setattr(MLXWhisperSTTClient, "_get_local_model_dir", lambda self, model_repo: model_dir)

    status = build_local_stt_status("mlx-whisper", "mlx-community/whisper-base-mlx")

    assert status is not None
    assert status["ffmpeg_available"] is False
    assert status["ffmpeg_source"] == "missing"
    assert "Reinstall SteerVox" in status["detail"]


def test_mlx_client_uses_one_shot_decode_settings(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    calls: list[dict[str, object]] = []

    class FakeMlxWhisperModule:
        @staticmethod
        def transcribe(*args, **kwargs):
            calls.append(kwargs)
            return {"text": "transcribed text"}

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=FakeMlxWhisperModule.transcribe))
    monkeypatch.setattr(MLXWhisperSTTClient, "_ensure_local_model_path", lambda self, model_repo: "/tmp/app-model")

    client = MLXWhisperSTTClient()
    result = client.transcribe(str(audio_path), model="mlx-community/whisper-base-mlx", language="en")

    assert result == "transcribed text"
    assert calls == [{
        "path_or_hf_repo": "/tmp/app-model",
        "language": "en",
        "temperature": 0.0,
        "condition_on_previous_text": False,
    }]


def test_mlx_client_omits_language_when_auto_mode_is_used(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    calls: list[dict[str, object]] = []

    class FakeMlxWhisperModule:
        @staticmethod
        def transcribe(*args, **kwargs):
            calls.append(kwargs)
            return {"text": "transcribed text"}

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=FakeMlxWhisperModule.transcribe))
    monkeypatch.setattr(MLXWhisperSTTClient, "_ensure_local_model_path", lambda self, model_repo: "/tmp/app-model")

    client = MLXWhisperSTTClient()
    result = client.transcribe(str(audio_path), model="mlx-community/whisper-base-mlx", language=None)

    assert result == "transcribed text"
    assert calls == [{
        "path_or_hf_repo": "/tmp/app-model",
        "temperature": 0.0,
        "condition_on_previous_text": False,
    }]


def test_mlx_client_downloads_model_into_app_managed_storage(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    model_root = tmp_path / "models"
    cache_root = tmp_path / "hf-cache"
    download_calls: list[dict[str, object]] = []
    transcribe_calls: list[dict[str, object]] = []

    class FakeMlxWhisperModule:
        @staticmethod
        def transcribe(*args, **kwargs):
            transcribe_calls.append(kwargs)
            return {"text": "transcribed text"}

    def fake_snapshot_download(*, repo_id, local_dir, cache_dir):
        download_calls.append({
            "repo_id": repo_id,
            "local_dir": str(local_dir),
            "cache_dir": str(cache_dir),
        })
        local_dir.mkdir(parents=True, exist_ok=True)
        (local_dir / "config.json").write_text("{}", encoding="utf-8")
        (local_dir / "weights.npz").write_bytes(b"fake")
        return str(local_dir)

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=FakeMlxWhisperModule.transcribe))
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(snapshot_download=fake_snapshot_download))
    monkeypatch.setattr("providers.stt_factory.get_mlx_whisper_models_dir", lambda: model_root)
    monkeypatch.setattr("providers.stt_factory.get_mlx_whisper_hf_cache_dir", lambda: cache_root)

    client = MLXWhisperSTTClient()
    result = client.transcribe(str(audio_path), model="mlx-community/whisper-base-mlx", language="en")

    assert result == "transcribed text"
    assert download_calls == [{
        "repo_id": "mlx-community/whisper-base-mlx",
        "local_dir": str(model_root / "mlx-community--whisper-base-mlx"),
        "cache_dir": str(cache_root),
    }]
    assert transcribe_calls == [{
        "path_or_hf_repo": str(model_root / "mlx-community--whisper-base-mlx"),
        "language": "en",
        "temperature": 0.0,
        "condition_on_previous_text": False,
    }]


def test_mlx_client_reuses_existing_app_managed_model_without_redownloading(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    model_root = tmp_path / "models"
    existing_model_dir = model_root / "mlx-community--whisper-base-mlx"
    existing_model_dir.mkdir(parents=True, exist_ok=True)
    (existing_model_dir / "config.json").write_text("{}", encoding="utf-8")
    (existing_model_dir / "weights.safetensors").write_bytes(b"fake")
    transcribe_calls: list[dict[str, object]] = []

    class FakeMlxWhisperModule:
        @staticmethod
        def transcribe(*args, **kwargs):
            transcribe_calls.append(kwargs)
            return {"text": "transcribed text"}

    def fail_snapshot_download(**kwargs):
        raise AssertionError("snapshot_download should not run when the app-managed model already exists")

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=FakeMlxWhisperModule.transcribe))
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(snapshot_download=fail_snapshot_download))
    monkeypatch.setattr("providers.stt_factory.get_mlx_whisper_models_dir", lambda: model_root)

    client = MLXWhisperSTTClient()
    result = client.transcribe(str(audio_path), model="mlx-community/whisper-base-mlx", language="en")

    assert result == "transcribed text"
    assert transcribe_calls == [{
        "path_or_hf_repo": str(existing_model_dir),
        "language": "en",
        "temperature": 0.0,
        "condition_on_previous_text": False,
    }]


def test_remote_client_sends_prompt_hints_for_supported_openai_compatible_providers(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    observed = {}

    class FakeResponse:
        status_code = 200
        text = "ok"

        @staticmethod
        def json():
            return {"text": "transcribed text"}

    def fake_post(url, *, headers, files, data, timeout):
        observed["url"] = url
        observed["headers"] = headers
        observed["data"] = dict(data)
        observed["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("providers.stt_factory.SecretsManager.get_api_key", lambda provider: "secret")

    client = RemoteSTTClient(provider="openai")
    monkeypatch.setattr(client.session, "post", fake_post)

    result = client.transcribe(
        str(audio_path),
        model="whisper-1",
        language="en",
        hints=STTHintPayload(
            keywords=("bill of lading", "carrier"),
            prompt="Prefer these domain terms when they appear in speech: bill of lading, carrier",
        ),
    )

    assert result == "transcribed text"
    assert observed["data"]["prompt"] == "Prefer these domain terms when they appear in speech: bill of lading, carrier"


def test_remote_client_ignores_prompt_hints_for_unsupported_provider_payloads(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    observed = {}

    class FakeResponse:
        status_code = 200
        text = "ok"

        @staticmethod
        def json():
            return {"text": "transcribed text"}

    def fake_post(url, *, headers, files, data, timeout):
        observed["data"] = dict(data)
        return FakeResponse()

    monkeypatch.setattr("providers.stt_factory.SecretsManager.get_api_key", lambda provider: "secret")

    client = RemoteSTTClient(provider="deepgram")
    monkeypatch.setattr(client.session, "post", fake_post)

    result = client.transcribe(
        str(audio_path),
        model="nova-2",
        language="en",
        hints=STTHintPayload(
            keywords=("shipment",),
            prompt="Prefer these domain terms when they appear in speech: shipment",
        ),
    )

    assert result == "transcribed text"
    assert "prompt" not in observed["data"]


def test_remote_client_uses_sarvam_subscription_header_and_transcript_field(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    observed = {}

    class FakeResponse:
        status_code = 200
        text = "ok"

        @staticmethod
        def json():
            return {"transcript": "namaste duniya"}

    def fake_post(url, *, headers, files, data, timeout):
        observed["url"] = url
        observed["headers"] = headers
        observed["data"] = dict(data)
        observed["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("providers.stt_factory.SecretsManager.get_api_key", lambda provider: "sarvam-secret")

    client = RemoteSTTClient(provider="sarvam")
    monkeypatch.setattr(client.session, "post", fake_post)

    result = client.transcribe(
        str(audio_path),
        model="saaras:v3",
        language="en",
        hints=STTHintPayload(prompt="Prefer invoice identifiers."),
    )

    assert result == "namaste duniya"
    assert observed["url"] == "https://api.sarvam.ai/speech-to-text"
    assert observed["headers"] == {"api-subscription-key": "sarvam-secret"}
    assert observed["data"] == {
        "model": "saaras:v3",
        "language_code": "en-IN",
    }


def test_remote_client_omits_unsupported_sarvam_language_code(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    observed = {}

    class FakeResponse:
        status_code = 200
        text = "ok"

        @staticmethod
        def json():
            return {"transcript": "transcribed text"}

    def fake_post(url, *, headers, files, data, timeout):
        observed["data"] = dict(data)
        return FakeResponse()

    monkeypatch.setattr("providers.stt_factory.SecretsManager.get_api_key", lambda provider: "sarvam-secret")

    client = RemoteSTTClient(provider="sarvam")
    monkeypatch.setattr(client.session, "post", fake_post)

    result = client.transcribe(
        str(audio_path),
        model="saaras:v3",
        language="es",
    )

    assert result == "transcribed text"
    assert observed["data"] == {
        "model": "saaras:v3",
    }


def test_remote_client_retries_then_raises_transient_error_on_connection_errors(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    attempts: list[int] = []

    def fake_post(*args, **kwargs):
        attempts.append(1)
        raise requests.ConnectionError("connection refused")

    monkeypatch.setattr("providers.stt_factory.SecretsManager.get_api_key", lambda provider: "secret")
    # Skip the retry sleep so the test stays fast.
    monkeypatch.setattr("providers.stt_factory.time.sleep", lambda *_args, **_kwargs: None)

    client = RemoteSTTClient(provider="groq")
    monkeypatch.setattr(client.session, "post", fake_post)

    with pytest.raises(STTTransientError, match="could not be reached"):
        client.transcribe(str(audio_path), model="whisper-large-v3", language="en")

    assert len(attempts) == REMOTE_STT_MAX_ATTEMPTS


def test_remote_client_retries_then_raises_on_persistent_5xx(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")
    attempts: list[int] = []

    class FakeResponse:
        status_code = 503
        text = "service unavailable"

        @staticmethod
        def json():
            return {}

    def fake_post(*args, **kwargs):
        attempts.append(1)
        return FakeResponse()

    monkeypatch.setattr("providers.stt_factory.SecretsManager.get_api_key", lambda provider: "secret")
    monkeypatch.setattr("providers.stt_factory.time.sleep", lambda *_args, **_kwargs: None)

    client = RemoteSTTClient(provider="openai")
    monkeypatch.setattr(client.session, "post", fake_post)

    with pytest.raises(STTTransientError, match="temporarily unavailable"):
        client.transcribe(str(audio_path), model="whisper-1", language="en")

    assert len(attempts) == REMOTE_STT_MAX_ATTEMPTS


def test_remote_client_succeeds_after_one_5xx_then_200(monkeypatch, tmp_path):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")

    class FailingResponse:
        status_code = 503
        text = "temporary"

        @staticmethod
        def json():
            return {}

    class SuccessResponse:
        status_code = 200
        text = "ok"

        @staticmethod
        def json():
            return {"text": "second-try transcript"}

    responses = [FailingResponse(), SuccessResponse()]

    def fake_post(*args, **kwargs):
        return responses.pop(0)

    monkeypatch.setattr("providers.stt_factory.SecretsManager.get_api_key", lambda provider: "secret")
    monkeypatch.setattr("providers.stt_factory.time.sleep", lambda *_args, **_kwargs: None)

    client = RemoteSTTClient(provider="openai")
    monkeypatch.setattr(client.session, "post", fake_post)

    result = client.transcribe(str(audio_path), model="whisper-1", language="en")

    assert result == "second-try transcript"
    assert responses == []


def test_nvidia_client_raises_transient_error_when_recognition_times_out(monkeypatch, tmp_path):
    import time as _time

    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")

    class FakeAuth:
        def __init__(self, **kwargs):
            pass

    class FakeASRService:
        def __init__(self, auth):
            pass

        def offline_recognize(self, audio_bytes, config):
            _time.sleep(2)  # Wrapped by future.result(timeout=…) below.
            return types.SimpleNamespace(results=[])

    class FakeRecognitionConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    fake_riva_client = types.SimpleNamespace(
        Auth=FakeAuth,
        ASRService=FakeASRService,
        RecognitionConfig=FakeRecognitionConfig,
        add_audio_file_specs_to_config=lambda *args, **kwargs: None,
        add_word_boosting_to_config=lambda *args, **kwargs: None,
    )
    fake_riva_module = types.ModuleType("riva")
    fake_riva_module.client = fake_riva_client

    monkeypatch.setattr("security.secrets_manager.SecretsManager.get_api_key", lambda provider: "nvidia-key")
    monkeypatch.setitem(sys.modules, "grpc", types.SimpleNamespace(RpcError=Exception))
    monkeypatch.setitem(sys.modules, "riva", fake_riva_module)
    monkeypatch.setitem(sys.modules, "riva.client", fake_riva_client)
    monkeypatch.setattr("providers.stt_factory.NVIDIA_STT_TIMEOUT_SECONDS", 0.1)

    client = NvidiaRivaSTTClient()

    with pytest.raises(STTTransientError, match="timed out"):
        client.transcribe(str(audio_path), model="openai/whisper-large-v3", language="en")


@pytest.mark.parametrize("text", ["", ".", "..."])
def test_mlx_client_rejects_low_signal_transcripts(monkeypatch, tmp_path, text):
    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"RIFF")

    class FakeMlxWhisperModule:
        @staticmethod
        def transcribe(*args, **kwargs):
            return {"text": text}

    monkeypatch.setattr("platform.system", lambda: "Darwin")
    monkeypatch.setattr("platform.machine", lambda: "arm64")
    monkeypatch.setitem(sys.modules, "mlx_whisper", types.SimpleNamespace(transcribe=FakeMlxWhisperModule.transcribe))
    monkeypatch.setattr(MLXWhisperSTTClient, "_ensure_local_model_path", lambda self, model_repo: "/tmp/mlx-model")

    client = MLXWhisperSTTClient()

    with pytest.raises(RuntimeError, match="too little usable text"):
        client.transcribe(str(audio_path), model="mlx-community/whisper-tiny", language="en")
