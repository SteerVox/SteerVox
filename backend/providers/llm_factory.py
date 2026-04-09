import threading
from typing import Any

from providers.lmstudio_native import build_lmstudio_native_runnable
from security.secrets_manager import SecretsManager
from utils.logger import get_logger

logger = get_logger()

OPENAI_COMPAT_BASE_URLS = {
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    "sarvam": "https://api.sarvam.ai/v1",
}


def _build_openai_family_kwargs(
    *,
    timeout: float | None,
    max_retries: int | None,
    max_tokens: int | None,
    reasoning_mode: str | None,
) -> dict[str, Any]:
    extra_kwargs: dict[str, Any] = {}
    if timeout is not None:
        extra_kwargs["request_timeout"] = timeout
    if max_retries is not None:
        extra_kwargs["max_retries"] = max_retries
    if max_tokens is not None:
        extra_kwargs["max_tokens"] = max_tokens
    if reasoning_mode and reasoning_mode != "off":
        extra_kwargs["reasoning_effort"] = reasoning_mode
    return extra_kwargs


def _build_anthropic_kwargs(
    *,
    timeout: float | None,
    max_retries: int | None,
    max_tokens: int | None,
) -> dict[str, Any]:
    extra_kwargs: dict[str, Any] = {}
    if timeout is not None:
        extra_kwargs["default_request_timeout"] = timeout
    if max_retries is not None:
        extra_kwargs["max_retries"] = max_retries
    if max_tokens is not None:
        extra_kwargs["max_tokens"] = max_tokens
    return extra_kwargs


class LLMFactory:
    _cache_lock = threading.Lock()
    _client_cache: dict[tuple[str, str, float, str | None, float | None, int | None, int | None, int | None, str | None], Any] = {}

    @staticmethod
    def get_llm(
        provider: str,
        model: str,
        temperature: float = 0.0,
        *,
        timeout: float | None = None,
        max_retries: int | None = None,
        max_tokens: int | None = None,
        context_length: int | None = None,
        reasoning_mode: str | None = None,
    ) -> Any:
        provider = provider.lower()
        api_key = SecretsManager.get_api_key(provider)
        if not api_key and provider not in {"lmstudio"}:
            logger.warning(f"{provider} API key not found in keychain. LLM initialization may fail or use environment variables.")
        cache_key = (provider, model, float(temperature), api_key, timeout, max_retries, max_tokens, context_length, reasoning_mode)
        with LLMFactory._cache_lock:
            cached = LLMFactory._client_cache.get(cache_key)
        if cached is not None:
            return cached

        if provider == "groq":
            from langchain_groq import ChatGroq
            client = ChatGroq(
                model=model,
                temperature=temperature,
                api_key=api_key,
                **_build_openai_family_kwargs(
                    timeout=timeout,
                    max_retries=max_retries,
                    max_tokens=max_tokens,
                    reasoning_mode=reasoning_mode,
                ),
            )
        elif provider == "openai":
            from langchain_openai import ChatOpenAI
            client = ChatOpenAI(
                model=model,
                temperature=temperature,
                api_key=api_key,
                **_build_openai_family_kwargs(
                    timeout=timeout,
                    max_retries=max_retries,
                    max_tokens=max_tokens,
                    reasoning_mode=reasoning_mode,
                ),
            )
        elif provider in OPENAI_COMPAT_BASE_URLS:
            from langchain_openai import ChatOpenAI
            extra_kwargs: dict[str, Any] = {
                "base_url": OPENAI_COMPAT_BASE_URLS[provider],
            }
            if provider == "sarvam" and api_key:
                extra_kwargs["default_headers"] = {"api-subscription-key": api_key}
            extra_kwargs.update(
                _build_openai_family_kwargs(
                    timeout=timeout,
                    max_retries=max_retries,
                    max_tokens=max_tokens,
                    reasoning_mode=reasoning_mode,
                )
            )
            client = ChatOpenAI(
                model=model,
                temperature=temperature,
                api_key=api_key,
                **extra_kwargs,
            )
        elif provider == "lmstudio":
            client = build_lmstudio_native_runnable(
                model=model,
                temperature=temperature,
                api_key=api_key,
                timeout=timeout,
                max_tokens=max_tokens,
                context_length=context_length,
                reasoning_mode=reasoning_mode,
            )
        elif provider == "anthropic":
            from langchain_anthropic import ChatAnthropic
            client = ChatAnthropic(
                model=model,
                temperature=temperature,
                api_key=api_key,
                **_build_anthropic_kwargs(
                    timeout=timeout,
                    max_retries=max_retries,
                    max_tokens=max_tokens,
                ),
            )
        else:
            raise ValueError(f"Unsupported LLM provider: {provider}")

        with LLMFactory._cache_lock:
            return LLMFactory._client_cache.setdefault(cache_key, client)
