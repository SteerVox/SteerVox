import json
from pathlib import Path
from typing import Optional
from utils.logger import get_logger
from utils.paths import get_app_home, safe_chmod

logger = get_logger()

class SecretsManager:
    """
    Utility class to securely store and retrieve sensitive API keys.
    Instead of macOS Keychain (which forces a locked 'Local Items' prompt), 
    we store keys in a local JSON file with strict 0o600 permissions.
    """

    @classmethod
    def _secrets_file(cls) -> Path:
        return get_app_home() / ".env_secrets"

    @classmethod
    def _ensure_secrets_file(cls):
        """Ensures the secrets file exists and has 600 permissions."""
        secrets_file = cls._secrets_file()
        if not secrets_file.parent.exists():
            secrets_file.parent.mkdir(parents=True, exist_ok=True)

        if not secrets_file.exists():
            with open(secrets_file, "w") as f:
                json.dump({}, f)
            # Set strict permissions: read/write for owner only
            safe_chmod(secrets_file, 0o600)

    @classmethod
    def _read_secrets(cls) -> dict:
        cls._ensure_secrets_file()
        try:
            with open(cls._secrets_file(), "r") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to read secrets file: {e}")
            return {}

    @classmethod
    def _write_secrets(cls, secrets: dict) -> bool:
        cls._ensure_secrets_file()
        try:
            with open(cls._secrets_file(), "w") as f:
                json.dump(secrets, f)
            safe_chmod(cls._secrets_file(), 0o600)
            return True
        except Exception as e:
            logger.error(f"Failed to write secrets file: {e}")
            return False

    @classmethod
    def set_api_key(cls, provider: str, api_key: str) -> bool:
        """Save an API key securely."""
        secrets = cls._read_secrets()
        secrets[provider] = api_key
        success = cls._write_secrets(secrets)
        if success:
            logger.info(f"Successfully saved API key for {provider}")
        return success

    @classmethod
    def get_api_key(cls, provider: str) -> Optional[str]:
        """Retrieve an API key securely."""
        secrets = cls._read_secrets()
        return secrets.get(provider)

    @classmethod
    def delete_api_key(cls, provider: str) -> bool:
        """Delete a stored API key."""
        secrets = cls._read_secrets()
        if provider in secrets:
            del secrets[provider]
            return cls._write_secrets(secrets)
        return True
