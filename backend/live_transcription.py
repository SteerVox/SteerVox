from __future__ import annotations

import base64
import threading
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Callable, Optional

from config.manager import ConfigManager
from providers.stt_factory import STTFactory
from utils.logger import get_logger
from utils.paths import get_temp_dir, safe_chmod


logger = get_logger()
SUPPORTED_PROVIDER_LIVE_SOURCES = {"openai", "deepgram"}
PCM_SAMPLE_RATE = 16_000
PCM_SAMPLE_WIDTH_BYTES = 2
PCM_CHANNELS = 1
MAX_STREAM_WINDOW_SEC = 18
MIN_PARTIAL_AUDIO_MS = 500


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _merge_transcript(previous: str, current: str) -> str:
    previous_text = str(previous or "").strip()
    current_text = str(current or "").strip()
    if not previous_text:
        return current_text
    if not current_text:
        return previous_text
    if current_text.startswith(previous_text):
        return current_text
    if previous_text.endswith(current_text):
        return previous_text
    if previous_text in current_text:
        return current_text
    if current_text in previous_text:
        return previous_text

    max_overlap = min(len(previous_text), len(current_text))
    for overlap in range(max_overlap, 11, -1):
        if previous_text[-overlap:] == current_text[:overlap]:
            return f"{previous_text}{current_text[overlap:]}"

    return current_text


@dataclass
class _LiveSession:
    session_id: str
    mode: str
    source: str
    provider: str
    pcm_bytes: bytearray = field(default_factory=bytearray)
    started_at: str = field(default_factory=_now_iso)
    first_partial_at: Optional[str] = None
    last_partial_started_at: float = 0.0
    inflight: bool = False
    finalizing: bool = False
    text: str = ""
    error: Optional[str] = None


class LiveTranscriptionManager:
    def __init__(
        self,
        *,
        runtime_event_emitter: Optional[Callable[[str, Optional[dict[str, Any]]], None]] = None,
    ) -> None:
        self.config_manager = ConfigManager()
        self._runtime_event_emitter = runtime_event_emitter
        self._lock = threading.Lock()
        self._session: Optional[_LiveSession] = None
        self._state: Optional[dict[str, Any]] = None

    @property
    def state(self) -> Optional[dict[str, Any]]:
        with self._lock:
            return dict(self._state) if self._state is not None else None

    def start_session(self, *, session_id: str, mode: str) -> Optional[dict[str, Any]]:
        config = self.config_manager.get_config()
        source = self._resolve_source(
            live_mode=config.audio.live_transcription_mode,
            provider=config.stt.provider,
        )
        with self._lock:
            self._session = None
            self._state = None
            if source is None:
                return None
            session = _LiveSession(
                session_id=session_id,
                mode=mode,
                source=source,
                provider=config.stt.provider,
            )
            self._session = session
            self._state = self._build_state_payload(session=session, state="starting", is_final=False)
        self._emit_runtime_event()
        return self.state

    def append_chunk(
        self,
        *,
        session_id: str,
        pcm_s16le_base64: str,
        sample_rate: int = PCM_SAMPLE_RATE,
    ) -> bool:
        if sample_rate != PCM_SAMPLE_RATE:
            logger.warning("[LiveTranscription] Ignoring unsupported sample rate=%s session=%s", sample_rate, session_id)
            return False

        try:
            pcm_bytes = base64.b64decode(pcm_s16le_base64, validate=True)
        except Exception as exc:
            logger.warning("[LiveTranscription] Failed to decode chunk for session=%s: %s", session_id, exc)
            return False

        if not pcm_bytes:
            return False

        should_schedule = False
        with self._lock:
            session = self._session
            if session is None or session.session_id != session_id or session.finalizing:
                return False
            session.pcm_bytes.extend(pcm_bytes)
            if self._should_schedule_partial(session):
                session.inflight = True
                session.last_partial_started_at = time.monotonic()
                should_schedule = True

        if should_schedule:
            threading.Thread(
                target=self._run_partial_transcription,
                args=(session_id, False),
                daemon=True,
            ).start()
        return True

    def finish_session(self, *, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._session
            if session is None or session.session_id != session_id:
                return {
                    "session_id": session_id,
                    "transcript": None,
                    "source": None,
                    "first_partial_at": None,
                    "error": None,
                }
            session.finalizing = True

        final_text, error = self._transcribe_session_audio(session_id=session_id, is_final=True)
        with self._lock:
            session = self._session
            if session is None or session.session_id != session_id:
                return {
                    "session_id": session_id,
                    "transcript": final_text,
                    "source": None,
                    "first_partial_at": None,
                    "error": error,
                }
            if final_text:
                session.text = _merge_transcript(session.text, final_text)
                if session.first_partial_at is None:
                    session.first_partial_at = _now_iso()
            if error and not session.error:
                session.error = error
            self._state = self._build_state_payload(
                session=session,
                state="done" if session.text or not session.error else "error",
                is_final=bool(session.text),
            )
            payload = {
                "session_id": session_id,
                "transcript": session.text or None,
                "source": session.source,
                "first_partial_at": session.first_partial_at,
                "error": session.error,
            }
        self._emit_runtime_event()
        return payload

    def clear_session(self, *, session_id: Optional[str] = None) -> None:
        with self._lock:
            if session_id and self._session and self._session.session_id != session_id:
                return
            self._session = None
            self._state = None
        self._emit_runtime_event()

    def _emit_runtime_event(self) -> None:
        if self._runtime_event_emitter is None:
            return
        try:
            self._runtime_event_emitter("live_transcription", self.state)
        except Exception as exc:
            logger.warning("[LiveTranscription] Failed to emit runtime event: %s", exc)

    def _resolve_source(self, *, live_mode: str, provider: str) -> Optional[str]:
        normalized_provider = str(provider or "").strip().lower()
        normalized_mode = str(live_mode or "auto").strip().lower()
        if normalized_mode == "off":
            return None

        if normalized_provider not in SUPPORTED_PROVIDER_LIVE_SOURCES:
            return None

        if normalized_mode in {"auto", "provider_only"}:
            return "provider"

        return None

    def _build_state_payload(self, *, session: _LiveSession, state: str, is_final: bool) -> dict[str, Any]:
        return {
            "session_id": session.session_id,
            "mode": session.mode,
            "state": state,
            "text": session.text,
            "source": session.source,
            "is_final": is_final,
            "updated_at": _now_iso(),
            "error": session.error,
        }

    def _should_schedule_partial(self, session: _LiveSession) -> bool:
        if session.inflight:
            return False
        min_bytes = int((PCM_SAMPLE_RATE * PCM_SAMPLE_WIDTH_BYTES) * (MIN_PARTIAL_AUDIO_MS / 1000))
        if len(session.pcm_bytes) < min_bytes:
            return False
        interval = self._partial_interval_sec(source=session.source)
        return (time.monotonic() - session.last_partial_started_at) >= interval

    def _partial_interval_sec(self, *, source: str) -> float:
        if source == "local":
            return 0.55
        if source == "provider":
            return 1.1
        return 1.4

    def _run_partial_transcription(self, session_id: str, is_final: bool) -> None:
        text, error = self._transcribe_session_audio(session_id=session_id, is_final=is_final)
        with self._lock:
            session = self._session
            if session is None or session.session_id != session_id:
                return
            session.inflight = False
            if error and not session.error:
                session.error = error
                self._state = self._build_state_payload(session=session, state="error", is_final=False)
            elif text:
                session.text = _merge_transcript(session.text, text)
                if session.first_partial_at is None:
                    session.first_partial_at = _now_iso()
                self._state = self._build_state_payload(session=session, state="streaming", is_final=False)
            elif session.text:
                self._state = self._build_state_payload(session=session, state="streaming", is_final=False)
            should_reschedule = self._should_schedule_partial(session)
            if should_reschedule:
                session.inflight = True
                session.last_partial_started_at = time.monotonic()
        self._emit_runtime_event()
        if should_reschedule:
            threading.Thread(
                target=self._run_partial_transcription,
                args=(session_id, False),
                daemon=True,
            ).start()

    def _transcribe_session_audio(self, *, session_id: str, is_final: bool) -> tuple[Optional[str], Optional[str]]:
        with self._lock:
            session = self._session
            if session is None or session.session_id != session_id:
                return None, None
            pcm_bytes = bytes(session.pcm_bytes)

        if not pcm_bytes:
            return None, None

        max_bytes = PCM_SAMPLE_RATE * PCM_SAMPLE_WIDTH_BYTES * MAX_STREAM_WINDOW_SEC
        if not is_final and len(pcm_bytes) > max_bytes:
            pcm_bytes = pcm_bytes[-max_bytes:]

        config = self.config_manager.get_config()
        wav_path = self._write_pcm_wav(pcm_bytes)
        client = STTFactory.get_client(config.stt.provider)
        try:
            transcript = client.transcribe(
                wav_path,
                model=config.stt.model,
                language=None if config.stt.language_mode == "auto" else config.stt.language,
            )
            return str(transcript or "").strip() or None, None
        except Exception as exc:
            logger.warning("[LiveTranscription] Rolling transcription failed session=%s: %s", session_id, exc)
            return None, str(exc).strip() or "Live transcription failed."
        finally:
            try:
                Path(wav_path).unlink(missing_ok=True)
            except Exception:
                pass
            close_client = getattr(client, "close", None)
            if callable(close_client):
                close_client()

    def _write_pcm_wav(self, pcm_bytes: bytes) -> str:
        with NamedTemporaryFile(
            suffix=".wav",
            prefix="live_capture_",
            dir=get_temp_dir(),
            delete=False,
        ) as handle:
            temp_path = Path(handle.name)

        safe_chmod(temp_path, 0o600)
        with wave.open(str(temp_path), "wb") as wav_file:
            wav_file.setnchannels(PCM_CHANNELS)
            wav_file.setsampwidth(PCM_SAMPLE_WIDTH_BYTES)
            wav_file.setframerate(PCM_SAMPLE_RATE)
            wav_file.writeframes(pcm_bytes)
        return str(temp_path)
