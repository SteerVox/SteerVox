from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from security.secrets_manager import SecretsManager
from utils.logger import get_logger


def main():
    logger = get_logger()
    logger.info("Starting SecretsManager test...")

    print("\n--- Setting API Key ---")
    success = SecretsManager.set_api_key("test_provider", "test_sk_12345")
    print("Set API Key Success:", success)

    print("\n--- Getting API Key ---")
    key = SecretsManager.get_api_key("test_provider")
    print("Retrieved API Key:", key)

    print("\n--- Deleting API Key ---")
    success = SecretsManager.delete_api_key("test_provider")
    print("Delete API Key Success:", success)

    print("\n--- Verifying Deletion ---")
    key = SecretsManager.get_api_key("test_provider")
    print("Retrieved API Key after deletion (should be None):", key)


if __name__ == "__main__":
    main()
