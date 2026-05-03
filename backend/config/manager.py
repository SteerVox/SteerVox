import json
import os
import tempfile
from pathlib import Path

from .models import AppConfig, DEFAULT_LMSTUDIO_MODEL_ID, LMSTUDIO_LEGACY_PLACEHOLDER_MODEL_ID
from utils.branding import EXPERIMENTAL_MEDIA_DEFAULT_ENV_VAR
from utils.paths import get_app_home, safe_chmod

DEFAULT_NVIDIA_LLM_MODEL_ID = "minimaxai/minimax-m2.7"
LEGACY_NVIDIA_DEFAULT_MODEL_IDS = {
    "moonshotai/kimi-k2-instruct-0905",
    "moonshotai/kimi-k2-instruct",
    "moonshotai/kimi-k2.5",
}

class ConfigManager:
    """
    Singleton manager for loading, validating, and saving application configuration.
    """
    _instance = None
    _config: AppConfig = None
    
    # Store config in the user's app-home directory.
    CONFIG_DIR = None
    CONFIG_FILE = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(ConfigManager, cls).__new__(cls)
            cls._instance._ensure_config_exists()
            cls._instance.load_config()
        return cls._instance

    def _ensure_config_exists(self):
        self.CONFIG_DIR = get_app_home()
        self.CONFIG_FILE = self.CONFIG_DIR / "config.json"
        self.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        safe_chmod(self.CONFIG_DIR, 0o700)
        if not self.CONFIG_FILE.exists():
            self._save_raw(self._build_default_config())

    def _resolve_experimental_media_default(self) -> bool:
        raw_value = str(os.environ.get(EXPERIMENTAL_MEDIA_DEFAULT_ENV_VAR, "")).strip().lower()
        return raw_value in {"1", "true", "yes", "on"}

    def _build_default_config(self) -> dict:
        payload = AppConfig().model_dump()
        payload.setdefault("actions", {})
        payload["actions"]["experimental_media_controls"] = self._resolve_experimental_media_default()
        return self._normalize_config_payload(payload)

    def _normalize_config_payload(self, data: dict) -> dict:
        next_data = dict(data or {})
        actions = dict(next_data.get("actions") or {})
        if "experimental_media_controls" not in actions:
            actions["experimental_media_controls"] = self._resolve_experimental_media_default()
        next_data["actions"] = actions

        llm = dict(next_data.get("llm") or {})
        llm_provider = str(llm.get("provider") or AppConfig().llm.provider).strip() or AppConfig().llm.provider
        llm_model = str(llm.get("model") or AppConfig().llm.model).strip() or AppConfig().llm.model
        if llm_provider.lower() == "lmstudio" and llm_model == LMSTUDIO_LEGACY_PLACEHOLDER_MODEL_ID:
            llm_model = DEFAULT_LMSTUDIO_MODEL_ID
        routing = dict(llm.get("routing") or {})
        routing["provider"] = llm_provider
        routing["model"] = llm_model
        llm["provider"] = llm_provider
        llm["model"] = llm_model
        llm["routing"] = routing
        next_data["llm"] = llm

        vision = dict(next_data.get("vision") or {})
        vision_model = vision.get("model")
        if isinstance(vision_model, str) and vision_model.strip() == LMSTUDIO_LEGACY_PLACEHOLDER_MODEL_ID:
            vision["model"] = DEFAULT_LMSTUDIO_MODEL_ID
        next_data["vision"] = vision
        return next_data

    def _normalize_loaded_config_payload(self, data: dict) -> dict:
        normalized = self._normalize_config_payload(data)
        llm = dict(normalized.get("llm") or {})
        llm_provider = str(llm.get("provider") or "").strip().lower()
        llm_model = str(llm.get("model") or "").strip()

        if llm_provider == "nvidia" and llm_model in LEGACY_NVIDIA_DEFAULT_MODEL_IDS:
            llm["model"] = DEFAULT_NVIDIA_LLM_MODEL_ID
            routing = dict(llm.get("routing") or {})
            routing["provider"] = "nvidia"
            routing["model"] = DEFAULT_NVIDIA_LLM_MODEL_ID
            llm["routing"] = routing
            normalized["llm"] = llm

        return normalized

    def _save_raw(self, data: dict) -> bool:
        try:
            with tempfile.NamedTemporaryFile(
                mode='w',
                dir=self.CONFIG_DIR,
                prefix='config_',
                suffix='.json',
                delete=False,
            ) as handle:
                json.dump(data, handle, indent=4)
                temp_path = Path(handle.name)
            safe_chmod(temp_path, 0o600)
            temp_path.replace(self.CONFIG_FILE)
            safe_chmod(self.CONFIG_FILE, 0o600)
            return True
        except Exception as e:
            print(f"[ConfigManager] Failed to save config to disk: {e}")
            return False

    def load_config(self) -> AppConfig:
        try:
            with open(self.CONFIG_FILE, 'r') as f:
                data = json.load(f)
            loaded_data = self._normalize_loaded_config_payload(data)
            self._config = AppConfig(**loaded_data)
            normalized = self._config.model_dump()
            if normalized != loaded_data:
                self._save_raw(normalized)
        except Exception as e:
            print(f"Error loading config, falling back to defaults: {e}")
            self._config = AppConfig(**self._build_default_config())
        return self._config

    def get_config(self) -> AppConfig:
        if not self._config:
            return self.load_config()
        return self._config

    def update_config(self, new_data: dict) -> AppConfig:
        """
        Updates the current configuration with new partial data,
        validates it via Pydantic, and saves it to disk.
        """
        # Convert current config to dict, update it, and revalidate
        current_data = self._config.model_dump()
        
        # Deep update helper
        def pretty_deep_update(d, u):
            for k, v in u.items():
                if isinstance(v, dict):
                    d[k] = pretty_deep_update(d.get(k, {}), v)
                else:
                    d[k] = v
            return d
            
        updated_data = pretty_deep_update(current_data, new_data)
        updated_data = self._normalize_config_payload(updated_data)
        
        try:
            # Validate through Pydantic
            next_config = AppConfig(**updated_data)
        except Exception as e:
            print(f"[ConfigManager] Config validation failed: {e}")
            return None
        
        # Save to disk
        if not self._save_raw(next_config.model_dump()):
            return None

        self._config = next_config
        return self._config
