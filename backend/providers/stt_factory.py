from __future__ import annotations

import concurrent.futures
import importlib.util
import time
from dataclasses import dataclass
import platform
from pathlib import Path
import shutil
from typing import Iterator, Optional, Protocol

import requests

from security.secrets_manager import SecretsManager
from utils.branding import DISPLAY_NAME
from utils.logger import get_logger
from utils.paths import (
    get_bundled_ffmpeg_bin_dir,
    get_mlx_whisper_hf_cache_dir,
    get_mlx_whisper_models_dir,
    is_frozen_runtime,
)

logger = get_logger()

REMOTE_STT_TIMEOUT_SECONDS = 30
REMOTE_STT_MAX_ATTEMPTS = 2
REMOTE_STT_RETRY_BACKOFF_SECONDS = 0.75
NVIDIA_STT_TIMEOUT_SECONDS = 30


class STTTransientError(RuntimeError):
    """Raised when a speech provider fails in a way the user can retry."""

PROVIDER_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
    "deepgram": "https://api.deepgram.com/v1",
    "sarvam": "https://api.sarvam.ai",
}

OPENAI_COMPATIBLE_STT_PROVIDERS = {"groq", "openai"}
SARVAM_LANGUAGE_CODE_MAP = {
    "as": "as-IN",
    "as-in": "as-IN",
    "bn": "bn-IN",
    "bn-in": "bn-IN",
    "brx": "brx-IN",
    "brx-in": "brx-IN",
    "doi": "doi-IN",
    "doi-in": "doi-IN",
    "en": "en-IN",
    "en-in": "en-IN",
    "gu": "gu-IN",
    "gu-in": "gu-IN",
    "hi": "hi-IN",
    "hi-in": "hi-IN",
    "kn": "kn-IN",
    "kn-in": "kn-IN",
    "kok": "kok-IN",
    "kok-in": "kok-IN",
    "ks": "ks-IN",
    "ks-in": "ks-IN",
    "mai": "mai-IN",
    "mai-in": "mai-IN",
    "ml": "ml-IN",
    "ml-in": "ml-IN",
    "mni": "mni-IN",
    "mni-in": "mni-IN",
    "mr": "mr-IN",
    "mr-in": "mr-IN",
    "ne": "ne-IN",
    "ne-in": "ne-IN",
    "od": "od-IN",
    "od-in": "od-IN",
    "or": "od-IN",
    "pa": "pa-IN",
    "pa-in": "pa-IN",
    "sa": "sa-IN",
    "sa-in": "sa-IN",
    "sat": "sat-IN",
    "sat-in": "sat-IN",
    "sd": "sd-IN",
    "sd-in": "sd-IN",
    "ta": "ta-IN",
    "ta-in": "ta-IN",
    "te": "te-IN",
    "te-in": "te-IN",
    "ur": "ur-IN",
    "ur-in": "ur-IN",
}
SARVAM_SUPPORTED_LANGUAGE_CODES = frozenset({*SARVAM_LANGUAGE_CODE_MAP.values(), "unknown"})
NVIDIA_RIVA_URI = "grpc.nvcf.nvidia.com:443"
NVIDIA_RIVA_STREAM_CHUNK_FRAMES = 1600
NVIDIA_RIVA_DEFAULT_MODEL = "openai/whisper-large-v3"
NVIDIA_RIVA_BCP47_LANGUAGE_MAP = {
    "en": "en-US",
    "en-us": "en-US",
    "hi": "hi-IN",
    "hi-in": "hi-IN",
}


@dataclass(frozen=True)
class NvidiaRivaModelSpec:
    function_id: str
    recognition_mode: str
    language_mode: str


NVIDIA_RIVA_MODEL_SPECS = {
    "openai/whisper-large-v3": NvidiaRivaModelSpec(
        function_id="b702f636-f60c-4a3d-a6f4-f3568c13bd7d",
        recognition_mode="offline",
        language_mode="whisper",
    ),
    "nvidia/canary-1b-asr": NvidiaRivaModelSpec(
        function_id="b0e8b4a5-217c-40b7-9b96-17d84e666317",
        recognition_mode="offline",
        language_mode="bcp47",
    ),
    "nvidia/parakeet-1_1b-rnnt-multilingual-asr": NvidiaRivaModelSpec(
        function_id="71203149-d3b7-4460-8231-1be2543a1fca",
        recognition_mode="streaming",
        language_mode="bcp47",
    ),
}


@dataclass(frozen=True)
class STTHintPayload:
    keywords: tuple[str, ...] = ()
    prompt: Optional[str] = None


@dataclass(frozen=True)
class LocalSTTRuntimeStatus:
    runtime_mode: str
    runtime_ready: bool
    ffmpeg_available: bool
    ffmpeg_source: str
    selected_model: str
    selected_model_ready: bool
    detail: str


def _is_low_signal_transcript(text: Optional[str]) -> bool:
    stripped = (text or "").strip()
    if not stripped:
        return True
    return not any(char.isalnum() for char in stripped)


def _supports_mlx_whisper_platform() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def _mlx_runtime_mode() -> str:
    return "bundled" if is_frozen_runtime() else "development"


def _mlx_runtime_available() -> bool:
    return importlib.util.find_spec("mlx_whisper") is not None


def _is_executable_file(target_path: Optional[Path]) -> bool:
    return bool(target_path and target_path.is_file() and target_path.exists())


def _resolve_mlx_ffmpeg_status() -> tuple[str, bool]:
    bundled_dir = get_bundled_ffmpeg_bin_dir()
    bundled_ffmpeg = bundled_dir / "ffmpeg" if bundled_dir else None
    bundled_ffprobe = bundled_dir / "ffprobe" if bundled_dir else None
    if _is_executable_file(bundled_ffmpeg) and _is_executable_file(bundled_ffprobe):
        return "bundled", True

    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return "system", True

    return "missing", False


def _build_local_stt_detail(
    runtime_mode: str,
    runtime_ready: bool,
    ffmpeg_available: bool,
    ffmpeg_source: str,
    selected_model_ready: bool,
) -> str:
    if not _supports_mlx_whisper_platform():
        return "Local speech requires an Apple Silicon Mac."

    if not runtime_ready:
        if runtime_mode == "bundled":
            return f"Bundled local speech runtime is incomplete or missing. Reinstall {DISPLAY_NAME} and try again."
        return "MLX Whisper is optional and is not installed. Install backend/requirements-mlx.txt in your backend virtualenv to use local speech recognition."

    if not ffmpeg_available:
        if runtime_mode == "bundled":
            return f"Bundled local speech runtime is incomplete or missing. Reinstall {DISPLAY_NAME} and try again."
        return f"Local speech requires ffmpeg on PATH. Install it with Homebrew (`brew install ffmpeg`) and restart {DISPLAY_NAME}."

    if runtime_mode == "bundled" and ffmpeg_source == "system":
        return f"Bundled local speech is running with ffmpeg from your system PATH because the bundled ffmpeg runtime is unavailable. Reinstall {DISPLAY_NAME} to restore the bundled runtime."

    if not selected_model_ready:
        return "Local speech runtime is ready. The selected model will download into app-managed storage on first use."

    if runtime_mode == "bundled":
        return "Bundled local speech is ready."
    return "Local speech is ready in the backend virtualenv."


def build_local_stt_status(provider: str, selected_model: Optional[str]) -> Optional[dict]:
    normalized_provider = (provider or "").strip().lower()
    if normalized_provider != "mlx-whisper":
        return None

    runtime_mode = _mlx_runtime_mode()
    runtime_ready = _supports_mlx_whisper_platform() and _mlx_runtime_available()
    ffmpeg_source, ffmpeg_available = _resolve_mlx_ffmpeg_status()
    selected_model_id = selected_model or "mlx-community/whisper-base-mlx"
    client = MLXWhisperSTTClient()
    selected_model_ready = client._model_files_exist(client._get_local_model_dir(selected_model_id))
    detail = _build_local_stt_detail(
        runtime_mode=runtime_mode,
        runtime_ready=runtime_ready,
        ffmpeg_available=ffmpeg_available,
        ffmpeg_source=ffmpeg_source,
        selected_model_ready=selected_model_ready,
    )

    return LocalSTTRuntimeStatus(
        runtime_mode=runtime_mode,
        runtime_ready=runtime_ready,
        ffmpeg_available=ffmpeg_available,
        ffmpeg_source=ffmpeg_source,
        selected_model=selected_model_id,
        selected_model_ready=selected_model_ready,
        detail=detail,
    ).__dict__


class STTClient(Protocol):
    def transcribe(
        self,
        audio_file_path: str,
        model: str,
        language: Optional[str],
        hints: Optional[STTHintPayload] = None,
    ) -> Optional[str]:
        ...

    def close(self) -> None:
        ...


class RemoteSTTClient:
    def __init__(self, provider: str = "groq"):
        self.provider = provider.lower()
        self.base_url = PROVIDER_BASE_URLS.get(self.provider)
        self.session = requests.Session()
        if not self.base_url:
            raise ValueError(f"Unsupported STT provider: {self.provider}")

    def transcribe(
        self,
        audio_file_path: str,
        model: str = "whisper-large-v3-turbo",
        language: Optional[str] = "en",
        hints: Optional[STTHintPayload] = None,
    ) -> Optional[str]:
        api_key = SecretsManager.get_api_key(self.provider)
        if not api_key:
            logger.error(f"Cannot transcribe: {self.provider} API key is missing. Set it in Settings.")
            return None

        headers = self._build_headers(api_key)
        data = self._build_request_data(model=model, language=language, hints=hints)
        url = self._transcription_url()

        last_error_detail: Optional[str] = None
        for attempt in range(1, REMOTE_STT_MAX_ATTEMPTS + 1):
            try:
                with open(audio_file_path, "rb") as file:
                    files = {
                        "file": (audio_file_path, file, "audio/wav")
                    }
                    logger.debug(
                        "Sending audio to %s STT (%s) at %s (attempt %d/%d)...",
                        self.provider,
                        model,
                        self.base_url,
                        attempt,
                        REMOTE_STT_MAX_ATTEMPTS,
                    )
                    response = self.session.post(
                        url,
                        headers=headers,
                        files=files,
                        data=data,
                        timeout=REMOTE_STT_TIMEOUT_SECONDS,
                    )
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_error_detail = f"{type(exc).__name__}: {exc}"
                logger.warning(
                    "%s STT network error on attempt %d/%d: %s",
                    self.provider,
                    attempt,
                    REMOTE_STT_MAX_ATTEMPTS,
                    last_error_detail,
                )
                if attempt < REMOTE_STT_MAX_ATTEMPTS:
                    time.sleep(REMOTE_STT_RETRY_BACKOFF_SECONDS)
                    continue
                raise STTTransientError(
                    f"{self.provider} speech recognition could not be reached after {REMOTE_STT_MAX_ATTEMPTS} attempts. Check your network connection and try again."
                ) from exc
            except Exception as exc:
                logger.error("Failed to transcribe audio via %s: %s", self.provider, exc)
                return None

            if response.status_code == 200:
                try:
                    result = response.json()
                except ValueError as exc:
                    logger.error("%s STT returned non-JSON response: %s", self.provider, exc)
                    return None
                transcript = self._extract_transcript(result)
                logger.info("Successfully transcribed audio with %s.", self.provider)
                return transcript

            body_excerpt = (response.text or "").strip()[:240]
            last_error_detail = f"HTTP {response.status_code}: {body_excerpt}"
            if response.status_code >= 500 and attempt < REMOTE_STT_MAX_ATTEMPTS:
                logger.warning(
                    "%s STT server error on attempt %d/%d: %s",
                    self.provider,
                    attempt,
                    REMOTE_STT_MAX_ATTEMPTS,
                    last_error_detail,
                )
                time.sleep(REMOTE_STT_RETRY_BACKOFF_SECONDS)
                continue

            logger.error("%s STT Error: %s", self.provider, last_error_detail)
            if response.status_code >= 500:
                raise STTTransientError(
                    f"{self.provider} speech recognition is temporarily unavailable ({last_error_detail}). Please retry."
                )
            return None

        if last_error_detail:
            raise STTTransientError(
                f"{self.provider} speech recognition failed after {REMOTE_STT_MAX_ATTEMPTS} attempts ({last_error_detail})."
            )
        return None

    def close(self) -> None:
        self.session.close()

    def _build_headers(self, api_key: str) -> dict[str, str]:
        if self.provider == "sarvam":
            return {"api-subscription-key": api_key}
        return {"Authorization": f"Bearer {api_key}"}

    def _transcription_url(self) -> str:
        if self.provider == "sarvam":
            return f"{self.base_url}/speech-to-text"
        return f"{self.base_url}/audio/transcriptions"

    def _build_request_data(
        self,
        *,
        model: str,
        language: Optional[str],
        hints: Optional[STTHintPayload],
    ) -> dict[str, str]:
        if self.provider == "sarvam":
            return self._build_sarvam_request_data(model=model, language=language)

        data = {
            "model": model,
            "response_format": "json",
        }
        if language:
            data["language"] = language
        if hints and hints.prompt and self.provider in OPENAI_COMPATIBLE_STT_PROVIDERS:
            data["prompt"] = hints.prompt
        return data

    def _build_sarvam_request_data(self, *, model: str, language: Optional[str]) -> dict[str, str]:
        data = {"model": model or "saarika:v2.5"}
        normalized_language = self._normalize_sarvam_language(language)
        if normalized_language:
            data["language_code"] = normalized_language
        return data

    def _extract_transcript(self, payload: dict[str, object]) -> str:
        if self.provider == "sarvam":
            return str(payload.get("transcript") or "").strip()
        return str(payload.get("text") or "").strip()

    def _normalize_sarvam_language(self, language: Optional[str]) -> Optional[str]:
        normalized = (language or "").strip()
        if not normalized:
            return None

        lowered = normalized.lower()
        if lowered in {"auto", "unknown"}:
            return "unknown"

        mapped = SARVAM_LANGUAGE_CODE_MAP.get(lowered)
        if mapped:
            return mapped

        if normalized in SARVAM_SUPPORTED_LANGUAGE_CODES:
            return normalized

        logger.warning(
            "Sarvam STT does not support configured language %r. Omitting language_code and relying on provider autodetect.",
            language,
        )
        return None


class NvidiaRivaSTTClient:
    def __init__(self):
        self.provider = "nvidia"

    def transcribe(
        self,
        audio_file_path: str,
        model: str = NVIDIA_RIVA_DEFAULT_MODEL,
        language: Optional[str] = "en",
        hints: Optional[STTHintPayload] = None,
    ) -> Optional[str]:
        api_key = SecretsManager.get_api_key(self.provider)
        if not api_key:
            logger.error("Cannot transcribe: %s API key is missing. Set it in Settings.", self.provider)
            return None

        spec = NVIDIA_RIVA_MODEL_SPECS.get(model or "")
        if spec is None:
            logger.warning(
                "Unsupported NVIDIA STT model %r requested. Falling back to %s.",
                model,
                NVIDIA_RIVA_DEFAULT_MODEL,
            )
            model = NVIDIA_RIVA_DEFAULT_MODEL
            spec = NVIDIA_RIVA_MODEL_SPECS[model]

        grpc_module, riva_client = self._load_runtime()
        auth = riva_client.Auth(
            uri=NVIDIA_RIVA_URI,
            use_ssl=True,
            metadata_args=[
                ("function-id", spec.function_id),
                ("authorization", f"Bearer {api_key}"),
            ],
        )
        asr_service = riva_client.ASRService(auth)

        try:
            logger.debug(
                "Sending audio to NVIDIA STT (%s) via Riva %s mode (timeout=%ds).",
                model,
                spec.recognition_mode,
                NVIDIA_STT_TIMEOUT_SECONDS,
            )
            if spec.recognition_mode == "streaming":
                transcribe_fn = lambda: self._streaming_transcribe(
                    asr_service=asr_service,
                    riva_client=riva_client,
                    audio_file_path=audio_file_path,
                    model=model,
                    spec=spec,
                    language=language,
                    hints=hints,
                )
            else:
                transcribe_fn = lambda: self._offline_transcribe(
                    asr_service=asr_service,
                    riva_client=riva_client,
                    audio_file_path=audio_file_path,
                    model=model,
                    spec=spec,
                    language=language,
                    hints=hints,
                )

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(transcribe_fn)
                try:
                    transcript = future.result(timeout=NVIDIA_STT_TIMEOUT_SECONDS)
                except concurrent.futures.TimeoutError as exc:
                    logger.error(
                        "NVIDIA STT timed out after %d seconds for model %s (%s mode).",
                        NVIDIA_STT_TIMEOUT_SECONDS,
                        model,
                        spec.recognition_mode,
                    )
                    raise STTTransientError(
                        f"NVIDIA speech recognition timed out after {NVIDIA_STT_TIMEOUT_SECONDS} seconds. Please retry."
                    ) from exc
        except STTTransientError:
            raise
        except RuntimeError:
            raise
        except grpc_module.RpcError as exc:
            detail = exc.details() if hasattr(exc, "details") else str(exc)
            logger.error("NVIDIA STT RPC error for %s: %s", model, detail)
            return None
        except Exception as exc:
            logger.error("Failed to transcribe audio via NVIDIA STT: %s", exc)
            return None

        if _is_low_signal_transcript(transcript):
            logger.warning("NVIDIA STT returned a low-signal transcript for model %s: %r", model, transcript)
            return None

        logger.info("Successfully transcribed audio with NVIDIA STT (%s).", model)
        return transcript

    def close(self) -> None:
        return None

    def _load_runtime(self):
        try:
            import grpc
            import riva.client as riva_client
        except ImportError as exc:
            raise RuntimeError(
                "NVIDIA speech recognition requires nvidia-riva-client in the backend virtualenv. Install backend/requirements.txt and restart the app."
            ) from exc
        return grpc, riva_client

    def _offline_transcribe(
        self,
        *,
        asr_service,
        riva_client,
        audio_file_path: str,
        model: str,
        spec: NvidiaRivaModelSpec,
        language: Optional[str],
        hints: Optional[STTHintPayload],
    ) -> str:
        config = self._build_recognition_config(
            riva_client=riva_client,
            model=model,
            spec=spec,
            language=language,
            hints=hints,
        )
        riva_client.add_audio_file_specs_to_config(config, audio_file_path)
        with open(audio_file_path, "rb") as file:
            response = asr_service.offline_recognize(file.read(), config)
        return self._extract_offline_transcript(response)

    def _streaming_transcribe(
        self,
        *,
        asr_service,
        riva_client,
        audio_file_path: str,
        model: str,
        spec: NvidiaRivaModelSpec,
        language: Optional[str],
        hints: Optional[STTHintPayload],
    ) -> str:
        config = self._build_recognition_config(
            riva_client=riva_client,
            model=model,
            spec=spec,
            language=language,
            hints=hints,
        )
        streaming_config = riva_client.StreamingRecognitionConfig(
            config=config,
            interim_results=False,
        )
        riva_client.add_audio_file_specs_to_config(streaming_config, audio_file_path)
        with riva_client.AudioChunkFileIterator(audio_file_path, NVIDIA_RIVA_STREAM_CHUNK_FRAMES, None) as audio_chunks:
            responses = asr_service.streaming_response_generator(
                audio_chunks=audio_chunks,
                streaming_config=streaming_config,
            )
            return self._extract_streaming_transcript(responses)

    def _build_recognition_config(
        self,
        *,
        riva_client,
        model: str,
        spec: NvidiaRivaModelSpec,
        language: Optional[str],
        hints: Optional[STTHintPayload],
    ):
        config_kwargs: dict[str, object] = {
            "enable_automatic_punctuation": True,
            "max_alternatives": 1,
            "profanity_filter": False,
            "verbatim_transcripts": True,
        }
        normalized_language = self._normalize_language(spec=spec, language=language)
        if normalized_language:
            config_kwargs["language_code"] = normalized_language

        config = riva_client.RecognitionConfig(**config_kwargs)
        if hints and hints.keywords:
            boosted_words = [keyword.strip() for keyword in hints.keywords if keyword.strip()]
            if boosted_words:
                riva_client.add_word_boosting_to_config(
                    config,
                    boosted_lm_words=boosted_words,
                    boosted_lm_score=20.0,
                )
        if hints and hints.prompt:
            logger.debug("Ignoring prompt-style STT hints for provider %s.", self.provider)
        return config

    def _normalize_language(self, *, spec: NvidiaRivaModelSpec, language: Optional[str]) -> Optional[str]:
        normalized = (language or "").strip()
        if not normalized:
            return "multi" if spec.language_mode == "whisper" else None

        lowered = normalized.lower()
        if lowered in {"auto", "unknown", "multi"}:
            return "multi" if spec.language_mode == "whisper" else None

        if spec.language_mode == "whisper":
            return lowered.split("-", 1)[0]

        mapped = NVIDIA_RIVA_BCP47_LANGUAGE_MAP.get(lowered)
        if mapped:
            return mapped

        if normalized in NVIDIA_RIVA_BCP47_LANGUAGE_MAP.values():
            return normalized

        logger.warning(
            "NVIDIA STT model family %s does not have an explicit mapping for language %r. Omitting language_code and relying on provider defaults.",
            spec.language_mode,
            language,
        )
        return None

    def _extract_offline_transcript(self, response) -> str:
        segments: list[str] = []
        for result in getattr(response, "results", []) or []:
            alternatives = getattr(result, "alternatives", []) or []
            if not alternatives:
                continue
            transcript = str(getattr(alternatives[0], "transcript", "") or "").strip()
            if transcript:
                segments.append(transcript)
        return " ".join(segments).strip()

    def _extract_streaming_transcript(self, responses: Iterator[object]) -> str:
        final_segments: list[str] = []
        trailing_partial = ""
        for response in responses:
            for result in getattr(response, "results", []) or []:
                alternatives = getattr(result, "alternatives", []) or []
                if not alternatives:
                    continue
                transcript = str(getattr(alternatives[0], "transcript", "") or "").strip()
                if not transcript:
                    continue
                if getattr(result, "is_final", False):
                    final_segments.append(transcript)
                    trailing_partial = ""
                else:
                    trailing_partial = transcript

        if final_segments:
            return " ".join(final_segments).strip()
        return trailing_partial.strip()


class MLXWhisperSTTClient:
    _SUPPORTED_MODELS = {
        "mlx-community/whisper-tiny",
        "mlx-community/whisper-base-mlx",
        "mlx-community/whisper-large-v3-turbo",
    }

    def __init__(self):
        self.provider = "mlx-whisper"

    def _validate_environment(self) -> None:
        if not _supports_mlx_whisper_platform():
            raise RuntimeError("MLX Whisper requires an Apple Silicon Mac. Choose another speech provider on this device.")

    def _missing_runtime_error(self) -> str:
        if is_frozen_runtime():
            return (
                "Local speech recognition could not initialize its bundled runtime. "
                "Reinstall the app or rebuild the packaged backend bundle, then try again."
            )
        return (
            "MLX Whisper is optional and is not installed. "
            "Install backend/requirements-mlx.txt in your backend virtualenv to use local speech recognition."
        )

    def _missing_ffmpeg_error(self) -> str:
        if is_frozen_runtime():
            return f"Bundled local speech runtime is incomplete or missing. Reinstall {DISPLAY_NAME} and try again."
        return f"Local transcription requires ffmpeg. Install it with Homebrew (`brew install ffmpeg`) and restart {DISPLAY_NAME}."

    def transcribe(
        self,
        audio_file_path: str,
        model: str = "mlx-community/whisper-base-mlx",
        language: Optional[str] = "en",
        hints: Optional[STTHintPayload] = None,
    ) -> Optional[str]:
        self._validate_environment()
        try:
            import mlx_whisper
        except ImportError as exc:
            logger.error("MLX Whisper import failed inside the frozen runtime: %s", exc, exc_info=True)
            raise RuntimeError(self._missing_runtime_error()) from exc

        model_repo = model or "mlx-community/whisper-base-mlx"
        if model_repo not in self._SUPPORTED_MODELS:
            logger.warning("Unsupported MLX Whisper model %r requested. Falling back to whisper-base-mlx.", model_repo)
            model_repo = "mlx-community/whisper-base-mlx"

        try:
            model_path = self._ensure_local_model_path(model_repo)
            logger.info("Transcribing audio with MLX Whisper (%s) from %s...", model_repo, model_path)
            kwargs = {
                "path_or_hf_repo": model_path,
                "temperature": 0.0,
                "condition_on_previous_text": False,
            }
            if language:
                kwargs["language"] = language
            if hints and hints.prompt:
                logger.debug("Ignoring STT prompt hints for provider %s.", self.provider)

            result = mlx_whisper.transcribe(
                audio_file_path,
                **kwargs,
            )
            transcript = str(result.get("text", "")).strip()
            if _is_low_signal_transcript(transcript):
                logger.warning("MLX Whisper returned a low-signal transcript for model %s: %r", model_repo, transcript)
                if model_repo == "mlx-community/whisper-tiny":
                    raise RuntimeError(
                        "Local speech recognition returned too little usable text. Retry, switch to Whisper Base, or use a cloud provider."
                    )
                raise RuntimeError(
                    "Local speech recognition returned too little usable text. Retry, try a different local model, or use a cloud provider."
                )
            if transcript:
                logger.info("Successfully transcribed audio with MLX Whisper.")
            return transcript or None
        except FileNotFoundError as exc:
            missing_binary = getattr(exc, "filename", None)
            missing_binary_name = Path(str(missing_binary)).name if missing_binary else None
            if missing_binary_name in {"ffmpeg", "ffprobe"}:
                logger.error("MLX Whisper requires %s on PATH but it was not found.", missing_binary)
                raise RuntimeError(self._missing_ffmpeg_error()) from exc
            logger.error("MLX Whisper missing local dependency: %s", exc)
            raise RuntimeError("Local transcription failed because a required system dependency is missing.") from exc
        except RuntimeError:
            raise
        except Exception as exc:
            logger.error("MLX Whisper transcription failed: %s", exc)
            raise RuntimeError("Local transcription failed. Check app logs and model availability.") from exc

    def close(self) -> None:
        return None

    def _ensure_local_model_path(self, model_repo: str) -> str:
        target_dir = self._get_local_model_dir(model_repo)
        if self._model_files_exist(target_dir):
            return str(target_dir)

        try:
            from huggingface_hub import snapshot_download
        except ImportError as exc:
            raise RuntimeError(
                "Local speech model download support is unavailable. Reinstall MLX Whisper in the backend virtualenv and try again."
            ) from exc

        cache_dir = get_mlx_whisper_hf_cache_dir()
        logger.info(
            "Preparing MLX Whisper model %s in app-managed storage at %s (cache=%s).",
            model_repo,
            target_dir,
            cache_dir,
        )
        try:
            downloaded_path = Path(snapshot_download(
                repo_id=model_repo,
                local_dir=target_dir,
                cache_dir=cache_dir,
            ))
        except Exception as exc:
            logger.error("Failed to prepare MLX Whisper model %s in app-managed storage: %s", model_repo, exc)
            raise RuntimeError(
                "Local speech model download failed. Check your network connection or app logs and try again."
            ) from exc

        if self._model_files_exist(downloaded_path):
            return str(downloaded_path)
        if self._model_files_exist(target_dir):
            return str(target_dir)
        raise RuntimeError("Local speech model download completed, but the model files are incomplete.")

    def _get_local_model_dir(self, model_repo: str) -> Path:
        safe_name = model_repo.replace("/", "--").strip()
        return get_mlx_whisper_models_dir() / safe_name

    def _model_files_exist(self, model_dir: Path) -> bool:
        return (
            model_dir.is_dir()
            and (model_dir / "config.json").exists()
            and ((model_dir / "weights.safetensors").exists() or (model_dir / "weights.npz").exists())
        )


class STTFactory:
    @staticmethod
    def get_client(provider: str) -> STTClient:
        normalized_provider = provider.lower()
        if normalized_provider == "mlx-whisper":
            return MLXWhisperSTTClient()
        if normalized_provider == "nvidia":
            return NvidiaRivaSTTClient()
        return RemoteSTTClient(provider=normalized_provider)
