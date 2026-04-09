from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config.manager import ConfigManager
from utils.logger import get_logger


def main():
    logger = get_logger()
    logger.info("Starting config tests...")

    manager = ConfigManager()

    print("\n--- Current Configuration ---")
    config = manager.get_config()
    print(f"STT Provider: {config.stt.provider}")
    print(f"LLM Provider: {config.llm.provider}")
    print(f"Default Smart skill: {config.hotkeys.default_skill_id}")

    print("\n--- Updating Configuration ---")
    logger.info("Testing config update")
    updated = manager.update_config({"stt": {"provider": "deepgram"}})

    print("New STT Provider:", updated.stt.provider)
    print("Config saved to:", manager.CONFIG_FILE)

    manager.update_config({"stt": {"provider": "groq"}})


if __name__ == "__main__":
    main()
