from pathlib import Path
import os
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from providers.stt_factory import STTFactory


def main():
    print("STT Factory Test (Groq)")

    wav_path = os.path.expanduser("~/.steervox/temp/recording.wav")

    if not os.path.exists(wav_path):
        print("Please run `python test_audio.py` first to generate a test recording.")
        sys.exit(1)

    stt = STTFactory.get_client("groq")

    print("Transcribing... (ensure your API key is set via check_secrets.py)")
    transcript = stt.transcribe(wav_path, model="whisper-large-v3-turbo")

    if transcript:
        print("\n--- Result ---")
        print(transcript)
    else:
        print("\nTranscription failed. Check your API key or logs.")


if __name__ == "__main__":
    main()
