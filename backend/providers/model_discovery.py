import re
import time
from typing import Any, Dict, List, Optional, Tuple

import requests
from config.models import DEFAULT_LMSTUDIO_MODEL_ID
from security.secrets_manager import SecretsManager
from utils.logger import get_logger

logger = get_logger()

# Provider API base URLs for model listing
PROVIDER_ENDPOINTS = {
    "groq": "https://api.groq.com/openai/v1/models",
    "openai": "https://api.openai.com/v1/models",
    "nvidia": "https://integrate.api.nvidia.com/v1/models",
    "anthropic": "https://api.anthropic.com/v1/models",
    "lmstudio": "http://localhost:1234/api/v1/models",
}

# Sensible defaults when API key is missing or API call fails
DEFAULT_MODELS = {
    "llm": {
        "groq": [
            {"id": "llama-3.3-70b-versatile", "name": "Llama 3.3 70B"},
            {"id": "llama-3.1-8b-instant", "name": "Llama 3.1 8B"},
            {"id": "qwen/qwen3-32b", "name": "Qwen3 32B"},
        ],
        "nvidia": [
            {"id": "minimaxai/minimax-m2.7", "name": "MiniMax M2.7"},
            {"id": "moonshotai/kimi-k2-instruct-0905", "name": "Kimi K2 Instruct 0905"},
            {"id": "moonshotai/kimi-k2-instruct", "name": "Kimi K2 Instruct"},
        ],
        "openai": [
            {"id": "gpt-4o", "name": "GPT-4o"},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini"},
            {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo"},
        ],
        "anthropic": [
            {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4"},
            {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet"},
            {"id": "claude-3-haiku-20240307", "name": "Claude 3 Haiku"},
        ],
        "gemini": [
            {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash"},
            {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"},
            {"id": "gemini-3-flash-preview", "name": "Gemini 3 Flash Preview"},
            {"id": "gemini-3.1-flash-lite-preview", "name": "Gemini 3.1 Flash-Lite Preview"},
            {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro Preview"},
        ],
        "sarvam": [
            {"id": "sarvam-30b", "name": "Sarvam 30B"},
            {"id": "sarvam-105b", "name": "Sarvam 105B"},
            {"id": "sarvam-m", "name": "Sarvam-M (Legacy)"},
        ],
        "lmstudio": [
            {
                "id": DEFAULT_LMSTUDIO_MODEL_ID,
                "name": "Gemma 4 E4B",
                "loaded": False,
                "vision": True,
                "smart_capable": True,
                "recommended_for_smart": True,
                "discovered": False,
            },
        ],
    },
    "stt": {
        "groq": [
            {"id": "whisper-large-v3-turbo", "name": "Whisper Large v3 Turbo"},
            {"id": "whisper-large-v3", "name": "Whisper Large v3"},
        ],
        "openai": [
            {"id": "whisper-1", "name": "Whisper 1"},
        ],
        "nvidia": [
            {"id": "openai/whisper-large-v3", "name": "Whisper Large v3"},
            {"id": "nvidia/canary-1b-asr", "name": "Canary 1B ASR"},
            {"id": "nvidia/parakeet-1_1b-rnnt-multilingual-asr", "name": "Parakeet 1.1B Multilingual ASR"},
        ],
        "deepgram": [
            {"id": "nova-2", "name": "Nova 2"},
        ],
        "sarvam": [
            {"id": "saaras:v3", "name": "Saaras v3"},
            {"id": "saarika:v2.5", "name": "Saarika v2.5 (Legacy)"},
        ],
        "mlx-whisper": [
            {"id": "mlx-community/whisper-large-v3-turbo", "name": "Whisper Turbo (Local, Default)"},
            {"id": "mlx-community/whisper-base-mlx", "name": "Whisper Base (Local, Lighter)"},
            {"id": "mlx-community/whisper-tiny", "name": "Whisper Tiny (Local, Fastest)"},
        ],
    },
    "vision": {
        "lmstudio": [
            {
                "id": DEFAULT_LMSTUDIO_MODEL_ID,
                "name": "Gemma 4 E4B",
                "loaded": False,
                "vision": True,
                "discovered": False,
            },
        ],
    },
}

# Known STT model prefixes
STT_MODEL_PREFIXES = ("whisper", "nova", "distil-whisper", "canary", "parakeet")

# Non-chat model patterns to filter out (guard models, TTS, embeddings, etc.)
NON_CHAT_PATTERNS = (
    "guard",           # llama-guard, prompt-guard
    "safeguard",       # gpt-oss-safeguard
    "orpheus",         # TTS models (canopylabs/orpheus)
    "embed",           # embedding models
    "moderation",      # moderation models
)
NON_ALNUM_PATTERN = re.compile(r"[^a-z0-9]+")

LMSTUDIO_TOOL_CAPABILITY_KEYS = (
    "tool_use",
    "toolUse",
    "tool_calling",
    "toolCalling",
    "function_calling",
    "functionCalling",
    "trainedForToolUse",
    "trained_for_tool_use",
)
LMSTUDIO_REASONING_CAPABILITY_KEYS = (
    "reasoning",
    "supportsReasoning",
    "supports_reasoning",
    "thinking",
    "enableThinking",
    "enable_thinking",
)
LMSTUDIO_SMART_NAME_PATTERNS = (
    "instruct",
    "chat",
    "assistant",
    "coder",
    "reason",
    "think",
    "qwq",
    "r1",
    "qwen",
    "llama-3",
    "llama3",
    "mistral",
    "ministral",
    "mixtral",
    "command-r",
    "gpt-oss",
    "deepseek",
)
LMSTUDIO_PREFERRED_SMART_NAME_PATTERNS = (
    "google/gemma-4-e4b",
    "gemma-4-e4b",
    "gemma 4 e4b",
    "gemma4e4b",
)
LMSTUDIO_PARAMETER_COUNT_PATTERN = re.compile(r"(?<!\d)(\d+(?:\.\d+)?)b\b", re.IGNORECASE)
LMSTUDIO_SMALL_MODEL_PATTERN = re.compile(r"(?<!\d)(0?\.\d+|[1-4])b\b", re.IGNORECASE)
LMSTUDIO_SMALL_MODEL_MIN_CONTEXT_LENGTH = 8192

# Cache: { (provider, discriminator): { "models": [...], "timestamp": float } }
_cache: Dict[Tuple[str, str], dict] = {}
CACHE_TTL = 300  # 5 minutes
KEYLESS_MODEL_PROVIDERS = {"lmstudio", "mlx-whisper"}
HARDCODED_MODEL_PROVIDERS = {"gemini", "sarvam", "mlx-whisper"}
ALL_PROVIDERS = {"groq", "openai", "anthropic", "deepgram", "gemini", "nvidia", "sarvam", "lmstudio", "mlx-whisper"}


class ModelDiscovery:
    """
    Queries provider APIs for available models with caching.
    Falls back to hardcoded defaults if API key is missing or request fails.
    """

    @staticmethod
    def clear_cache(provider: Optional[str] = None) -> None:
        if provider is None:
            _cache.clear()
            return

        normalized = provider.lower()
        for cache_key in [key for key in _cache if key[0] == normalized]:
            _cache.pop(cache_key, None)

    @staticmethod
    def _cache_key(provider: str, api_key: Optional[str]) -> tuple[str, str]:
        if provider in KEYLESS_MODEL_PROVIDERS or provider in HARDCODED_MODEL_PROVIDERS:
            return (provider, "")
        return (provider, api_key or "")

    @staticmethod
    def _fetch_models_from_api(provider: str, api_key: str) -> Optional[List[dict]]:
        """Fetch raw model list from the provider endpoint."""
        endpoint = PROVIDER_ENDPOINTS.get(provider)
        if not endpoint:
            return None

        headers = {"Authorization": f"Bearer {api_key}"}

        # Anthropic uses a different header format
        if provider == "anthropic":
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01"
            }
        elif provider == "lmstudio":
            headers = {}

        try:
            # LM Studio runs locally but cold instances (model loading) can take
            # several seconds to answer the catalog probe, so we keep the budget
            # generous enough to avoid false "no models available" after a restart.
            timeout = 6 if provider == "lmstudio" else 10
            response = requests.get(endpoint, headers=headers, timeout=timeout)
            if response.status_code == 200:
                data = response.json()
                models = data.get("models", []) if provider == "lmstudio" else data.get("data", [])
                if provider == "lmstudio" and not models:
                    logger.warning("LM Studio is reachable, but no local models are available from /api/v1/models.")
                return models
            else:
                logger.warning(f"Model discovery API returned {response.status_code} for {provider}")
                return None
        except requests.exceptions.ConnectionError:
            if provider == "lmstudio":
                logger.warning("LM Studio local server is not running on port 1234.")
                return None
            logger.warning(f"Failed to fetch models from {provider}: connection error")
            return None
        except requests.exceptions.Timeout:
            if provider == "lmstudio":
                logger.warning("LM Studio model discovery timed out.")
                return None
            logger.warning(f"Failed to fetch models from {provider}: timeout")
            return None
        except Exception as e:
            logger.warning(f"Failed to fetch models from {provider}: {e}")
            return None

    @staticmethod
    def _format_model(model: dict, *, provider: str = "") -> dict:
        """Normalize a raw API model object into our format."""
        model_id = model.get("id", "") or model.get("key", "")
        # Create clean human-readable name
        name = str(model.get("display_name") or "")
        if not name:
            name = model_id.split("/")[-1] if "/" in model_id else model_id
            name = name.replace("-", " ").replace("_", " ").title()
        formatted = {"id": model_id, "name": name}
        if provider == "lmstudio":
            smart_capabilities = ModelDiscovery._lmstudio_smart_capabilities(model)
            formatted.update(smart_capabilities)
            formatted["discovered"] = True
        return formatted

    @staticmethod
    def _lmstudio_model_id(model: dict) -> str:
        return str(model.get("key") or model.get("id") or "").strip()

    @staticmethod
    def _lmstudio_model_loaded(model: dict) -> bool:
        loaded_instances = model.get("loaded_instances")
        return bool(isinstance(loaded_instances, list) and loaded_instances)

    @staticmethod
    def _lmstudio_model_supports_vision(model: dict) -> bool:
        capabilities = model.get("capabilities") if isinstance(model.get("capabilities"), dict) else {}
        return bool(capabilities.get("vision"))

    @staticmethod
    def _lmstudio_model_supports_tool_use(model: dict) -> bool:
        capabilities = model.get("capabilities") if isinstance(model.get("capabilities"), dict) else {}
        for key in LMSTUDIO_TOOL_CAPABILITY_KEYS:
            if capabilities.get(key):
                return True
            if model.get(key):
                return True
        return False

    @staticmethod
    def _lmstudio_model_supports_reasoning(model: dict) -> bool:
        capabilities = model.get("capabilities") if isinstance(model.get("capabilities"), dict) else {}
        for key in LMSTUDIO_REASONING_CAPABILITY_KEYS:
            if capabilities.get(key):
                return True
            if model.get(key):
                return True
        return False

    @staticmethod
    def _lmstudio_model_searchable_text(model: dict) -> str:
        parts = (
            model.get("key"),
            model.get("id"),
            model.get("display_name"),
            model.get("name"),
            model.get("architecture"),
            model.get("paramsString"),
        )
        return " ".join(str(part).strip().lower() for part in parts if part)

    @staticmethod
    def _normalize_search_text(value: str) -> str:
        return NON_ALNUM_PATTERN.sub("", str(value or "").strip().lower())

    @staticmethod
    def _extract_lmstudio_parameter_count_billions(value: Any) -> Optional[float]:
        if isinstance(value, dict):
            searchable = ModelDiscovery._lmstudio_model_searchable_text(value)
        else:
            searchable = str(value or "").strip().lower()

        match = LMSTUDIO_PARAMETER_COUNT_PATTERN.search(searchable)
        if not match:
            return None

        try:
            parsed = float(match.group(1))
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 else None

    @staticmethod
    def lmstudio_is_4b_or_smaller_model(value: Any) -> bool:
        parameter_count = ModelDiscovery._extract_lmstudio_parameter_count_billions(value)
        return parameter_count is not None and parameter_count <= 4.0

    @staticmethod
    def _looks_like_small_lmstudio_model(model: dict) -> bool:
        return ModelDiscovery.lmstudio_is_4b_or_smaller_model(model)

    @staticmethod
    def _looks_like_smart_lmstudio_model(model: dict) -> bool:
        searchable = ModelDiscovery._lmstudio_model_searchable_text(model)
        return any(marker in searchable for marker in LMSTUDIO_SMART_NAME_PATTERNS)

    @staticmethod
    def _looks_like_preferred_smart_lmstudio_model(model: dict) -> bool:
        searchable = ModelDiscovery._lmstudio_model_searchable_text(model)
        collapsed_searchable = ModelDiscovery._normalize_search_text(searchable)
        return any(
            marker in searchable or ModelDiscovery._normalize_search_text(marker) in collapsed_searchable
            for marker in LMSTUDIO_PREFERRED_SMART_NAME_PATTERNS
        )

    @staticmethod
    def _lmstudio_max_context_length(model: dict) -> Optional[int]:
        raw_value = model.get("maxContextLength") or model.get("max_context_length")
        if raw_value is None:
            return None
        try:
            parsed = int(raw_value)
        except (TypeError, ValueError):
            return None
        return parsed if parsed > 0 else None

    @staticmethod
    def lmstudio_resolve_request_context_length(
        model: Any,
        requested_context_length: Optional[int],
    ) -> Optional[int]:
        effective_context_length: Optional[int]
        try:
            effective_context_length = int(requested_context_length) if requested_context_length is not None else None
        except (TypeError, ValueError):
            effective_context_length = None

        if effective_context_length is not None and effective_context_length <= 0:
            effective_context_length = None

        if not ModelDiscovery.lmstudio_is_4b_or_smaller_model(model):
            return effective_context_length

        if effective_context_length is None:
            return LMSTUDIO_SMALL_MODEL_MIN_CONTEXT_LENGTH
        return max(effective_context_length, LMSTUDIO_SMALL_MODEL_MIN_CONTEXT_LENGTH)

    @staticmethod
    def _lmstudio_smart_capabilities(model: dict) -> dict[str, Any]:
        loaded = ModelDiscovery._lmstudio_model_loaded(model)
        vision = ModelDiscovery._lmstudio_model_supports_vision(model)
        tool_use = ModelDiscovery._lmstudio_model_supports_tool_use(model)
        reasoning = ModelDiscovery._lmstudio_model_supports_reasoning(model)
        looks_smart = ModelDiscovery._looks_like_smart_lmstudio_model(model)
        preferred_for_smart = ModelDiscovery._looks_like_preferred_smart_lmstudio_model(model)
        max_context_length = ModelDiscovery._lmstudio_max_context_length(model)
        small_model = ModelDiscovery._looks_like_small_lmstudio_model(model)
        smart_capable = tool_use or reasoning or looks_smart or preferred_for_smart
        recommended_for_smart = smart_capable and (preferred_for_smart or loaded) and (
            tool_use or reasoning or preferred_for_smart or not small_model
        )
        return {
            "loaded": loaded,
            "vision": vision,
            "tool_use": tool_use,
            "reasoning": reasoning,
            "smart_capable": smart_capable,
            "recommended_for_smart": recommended_for_smart,
            "max_context_length": max_context_length,
        }

    @staticmethod
    def _is_stt_model(model_id: str) -> bool:
        lower_id = model_id.lower()
        return any(lower_id.startswith(prefix) or f"/{prefix}" in lower_id for prefix in STT_MODEL_PREFIXES)

    @staticmethod
    def _is_chat_model(model_id: str) -> bool:
        """Check if this looks like a usable chat/completion model (not guard, TTS, etc.)."""
        lower_id = model_id.lower()
        return not any(p in lower_id for p in NON_CHAT_PATTERNS)

    @staticmethod
    def list_models(provider: str) -> Dict[str, List[dict]]:
        """
        Returns {"llm": [...], "stt": [...], "vision": [...]} for the given provider.
        Uses caching (5 min TTL). Falls back to defaults.
        """
        provider = provider.lower()
        now = time.time()
        api_key = SecretsManager.get_api_key(provider)
        cache_key = ModelDiscovery._cache_key(provider, api_key)

        # Check cache
        if cache_key in _cache and (now - _cache[cache_key]["timestamp"]) < CACHE_TTL:
            return _cache[cache_key]["models"]

        if provider in HARDCODED_MODEL_PROVIDERS:
            result = {
                "llm": DEFAULT_MODELS["llm"].get(provider, []),
                "stt": DEFAULT_MODELS["stt"].get(provider, []),
                "vision": DEFAULT_MODELS["vision"].get(provider, []),
            }
            _cache[cache_key] = {"models": result, "timestamp": now}
            return result

        if not api_key and provider not in KEYLESS_MODEL_PROVIDERS:
            logger.info(f"No API key for {provider}, returning default models.")
            result = {
                "llm": DEFAULT_MODELS["llm"].get(provider, []),
                "stt": DEFAULT_MODELS["stt"].get(provider, []),
                "vision": DEFAULT_MODELS["vision"].get(provider, []),
            }
            _cache[cache_key] = {"models": result, "timestamp": now}
            return result

        raw_models = ModelDiscovery._fetch_models_from_api(provider, api_key or "")

        if raw_models is None:
            result = {
                "llm": DEFAULT_MODELS["llm"].get(provider, []),
                "stt": DEFAULT_MODELS["stt"].get(provider, []),
                "vision": DEFAULT_MODELS["vision"].get(provider, []),
            }
            if provider != "lmstudio":
                _cache[cache_key] = {"models": result, "timestamp": now}
            return result

        # Split into LLM and STT, filtering out non-chat models
        llm_models = []
        stt_models = []
        vision_models = []
        for m in raw_models:
            if provider == "lmstudio" and m.get("type") != "llm":
                continue
            model_id = m.get("id", "")
            if provider == "lmstudio":
                model_id = m.get("key", "")
            formatted = ModelDiscovery._format_model(m, provider=provider)
            if ModelDiscovery._is_stt_model(model_id):
                stt_models.append(formatted)
            elif ModelDiscovery._is_chat_model(model_id):
                llm_models.append(formatted)
                if provider == "lmstudio" and ModelDiscovery._lmstudio_model_supports_vision(m):
                    vision_models.append(formatted)

        result = {
            "llm": llm_models if llm_models else DEFAULT_MODELS["llm"].get(provider, []),
            "stt": stt_models if stt_models else DEFAULT_MODELS["stt"].get(provider, []),
            "vision": vision_models if vision_models else DEFAULT_MODELS["vision"].get(provider, []),
        }

        # Cache the result
        _cache[cache_key] = {"models": result, "timestamp": now}
        return result

    @staticmethod
    def get_all_models() -> Dict[str, Dict[str, List[dict]]]:
        """Returns models for all known providers."""
        all_llm = {}
        all_stt = {}
        all_vision = {}
        for provider in ALL_PROVIDERS:
            result = ModelDiscovery.list_models(provider)
            if result["llm"]:
                all_llm[provider] = result["llm"]
            if result["stt"]:
                all_stt[provider] = result["stt"]
            if result["vision"]:
                all_vision[provider] = result["vision"]
        return {"llm": all_llm, "stt": all_stt, "vision": all_vision}

    @staticmethod
    def get_lmstudio_model_catalog() -> List[dict]:
        raw_models = ModelDiscovery._fetch_models_from_api("lmstudio", "")
        if not raw_models:
            return []
        return [item for item in raw_models if isinstance(item, dict)]

    @staticmethod
    def lmstudio_supports_vision(model_id: Optional[str], *, require_loaded: bool = False) -> bool:
        normalized_model_id = (model_id or "").strip()
        if not normalized_model_id:
            return False

        for item in ModelDiscovery.get_lmstudio_model_catalog():
            candidate_id = ModelDiscovery._lmstudio_model_id(item)
            if candidate_id != normalized_model_id:
                continue
            if not ModelDiscovery._lmstudio_model_supports_vision(item):
                return False
            if require_loaded and not ModelDiscovery._lmstudio_model_loaded(item):
                return False
            return True
        return False

    @staticmethod
    def resolve_lmstudio_vision_model(
        preferred_model_id: Optional[str] = None,
        *,
        require_loaded: bool = False,
        exclude_model_ids: Optional[set[str]] = None,
    ) -> Optional[str]:
        excluded = {value.strip() for value in (exclude_model_ids or set()) if value and value.strip()}
        if (
            preferred_model_id
            and preferred_model_id.strip() not in excluded
            and ModelDiscovery.lmstudio_supports_vision(preferred_model_id, require_loaded=require_loaded)
        ):
            return str(preferred_model_id).strip()

        for item in ModelDiscovery.get_lmstudio_model_catalog():
            if not ModelDiscovery._lmstudio_model_supports_vision(item):
                continue
            if require_loaded and not ModelDiscovery._lmstudio_model_loaded(item):
                continue
            candidate_id = ModelDiscovery._lmstudio_model_id(item)
            if candidate_id in excluded:
                continue
            if candidate_id:
                return candidate_id
        return None

    @staticmethod
    def resolve_lmstudio_smart_model(
        preferred_model_id: Optional[str] = None,
        *,
        require_loaded: bool = False,
    ) -> Optional[str]:
        normalized_preferred = str(preferred_model_id or "").strip()
        catalog = ModelDiscovery.get_lmstudio_model_catalog()
        if not catalog:
            return None

        def is_eligible(item: dict[str, Any]) -> bool:
            if item.get("type") != "llm":
                return False
            capabilities = ModelDiscovery._lmstudio_smart_capabilities(item)
            if require_loaded and not capabilities["loaded"]:
                return False
            return bool(capabilities["smart_capable"])

        if normalized_preferred:
            for item in catalog:
                if ModelDiscovery._lmstudio_model_id(item) != normalized_preferred:
                    continue
                if is_eligible(item):
                    return normalized_preferred
                break

        eligible_models = [item for item in catalog if is_eligible(item)]
        if not eligible_models:
            return None

        def priority(item: dict[str, Any]) -> tuple[int, int, int, int, int]:
            capabilities = ModelDiscovery._lmstudio_smart_capabilities(item)
            max_context = capabilities["max_context_length"] or 0
            return (
                0 if capabilities["recommended_for_smart"] else 1,
                0 if capabilities["tool_use"] else 1,
                0 if capabilities["reasoning"] else 1,
                0 if capabilities["loaded"] else 1,
                -max_context,
            )

        best = sorted(eligible_models, key=priority)[0]
        candidate_id = ModelDiscovery._lmstudio_model_id(best)
        return candidate_id or None

    @staticmethod
    def resolve_lmstudio_model_by_pattern(
        pattern: Optional[str],
        *,
        require_loaded: bool = False,
    ) -> Optional[str]:
        normalized_pattern = str(pattern or "").strip().lower()
        if not normalized_pattern:
            return None
        collapsed_pattern = ModelDiscovery._normalize_search_text(normalized_pattern)

        matches: list[dict] = []
        for item in ModelDiscovery.get_lmstudio_model_catalog():
            if item.get("type") != "llm":
                continue
            capabilities = ModelDiscovery._lmstudio_smart_capabilities(item)
            if require_loaded and not capabilities["loaded"]:
                continue
            searchable = ModelDiscovery._lmstudio_model_searchable_text(item)
            collapsed_searchable = ModelDiscovery._normalize_search_text(searchable)
            if normalized_pattern in searchable or (collapsed_pattern and collapsed_pattern in collapsed_searchable):
                matches.append(item)

        if not matches:
            return None

        def priority(item: dict[str, Any]) -> tuple[int, int, int, int]:
            capabilities = ModelDiscovery._lmstudio_smart_capabilities(item)
            max_context = capabilities["max_context_length"] or 0
            return (
                0 if capabilities["loaded"] else 1,
                0 if capabilities["smart_capable"] else 1,
                0 if capabilities["recommended_for_smart"] else 1,
                -max_context,
            )

        best = sorted(matches, key=priority)[0]
        return ModelDiscovery._lmstudio_model_id(best) or None
