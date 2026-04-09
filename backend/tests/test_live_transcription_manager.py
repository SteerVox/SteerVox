from live_transcription import LiveTranscriptionManager


def test_live_transcription_manager_disables_local_mlx_preview():
    manager = LiveTranscriptionManager()

    assert manager._resolve_source(live_mode="auto", provider="mlx-whisper") is None
    assert manager._resolve_source(live_mode="local_only", provider="mlx-whisper") is None


def test_live_transcription_manager_keeps_provider_live_preview_for_supported_providers():
    manager = LiveTranscriptionManager()

    assert manager._resolve_source(live_mode="auto", provider="openai") == "provider"
    assert manager._resolve_source(live_mode="provider_only", provider="deepgram") == "provider"
