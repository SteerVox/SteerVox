from __future__ import annotations

from typing import Any, Optional

import requests

from config.models import AppConfig
from providers.lmstudio_native import LMSTUDIO_NATIVE_BASE_URL, extract_lmstudio_output_text
from providers.model_discovery import ModelDiscovery
from utils.logger import get_logger


logger = get_logger()
VISION_PROMPT_TRANSCRIPT_LIMIT = 120
VISION_MAX_OUTPUT_TOKENS = 96


def _truncate_for_log(text: str, limit: int = 240) -> str:
    normalized = " ".join(text.split()).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 3].rstrip() + "..."


def _truncate_transcript_for_prompt(text: str, limit: int = VISION_PROMPT_TRANSCRIPT_LIMIT) -> str:
    normalized = " ".join(str(text).split()).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 3].rstrip() + "..."


class VisionAgent:
    def summarize_screen(
        self,
        *,
        transcript: str,
        screen_capture: Optional[dict[str, Any]],
        config: AppConfig,
    ) -> str:
        if not config.vision.enabled:
            return ""
        if not screen_capture:
            return ""

        model_candidates = self._resolve_model_candidates(config)
        if not model_candidates:
            logger.info("Local vision skipped because no vision-capable LM Studio model is available.")
            return ""

        image_base64 = str(screen_capture.get("image_base64") or "").strip()
        mime_type = str(screen_capture.get("mime_type") or "image/jpeg").strip() or "image/jpeg"
        if not image_base64:
            return ""

        transcript_hint = _truncate_transcript_for_prompt(transcript)

        try:
            attempted: list[str] = []
            for index, model_id in enumerate(model_candidates):
                attempted.append(model_id)
                payload = {
                    "model": model_id,
                    "input": [
                        {
                            "type": "text",
                            "content": (
                                f"User request: {transcript_hint!r}. Summarize only the visible screen details relevant to answering it. "
                                "Return a concise factual summary only."
                            ),
                        },
                        {
                            "type": "image",
                            "data_url": f"data:{mime_type};base64,{image_base64}",
                        },
                    ],
                    "temperature": 0.0,
                    "stream": False,
                    "store": False,
                    "max_output_tokens": VISION_MAX_OUTPUT_TOKENS,
                }
                logger.info(
                    "Local vision request model=%s screenshot=%sx%s timeout_ms=%s",
                    model_id,
                    screen_capture.get("width"),
                    screen_capture.get("height"),
                    config.vision.timeout_ms,
                )
                response = requests.post(
                    f"{LMSTUDIO_NATIVE_BASE_URL}/chat",
                    json=payload,
                    headers={"Content-Type": "application/json"},
                    timeout=max(config.vision.timeout_ms / 1000.0, 0.5),
                )
                if response.status_code >= 400:
                    response_text = response.text or ""
                    lowered_response_text = response_text.lower()
                    if "exceeds the available context size" in response_text:
                        logger.info(
                            "Local vision skipped because the request exceeded the loaded model context window. "
                            "Try a larger-context vision model or keep the capture budget small. Response=%s",
                            _truncate_for_log(response_text or ""),
                        )
                        return ""
                    if "failed to process image" in lowered_response_text:
                        logger.info(
                            "Local vision skipped because the selected vision model could not decode the image payload. "
                            "Classification=vision_decode_failure Response=%s",
                            _truncate_for_log(response_text or ""),
                        )
                        return ""
                    if "failed to load model" in lowered_response_text:
                        logger.info(
                            "Local vision skipped because model=%s is listed in LM Studio but not currently usable. "
                            "Classification=vision_model_unavailable Response=%s",
                            model_id,
                            _truncate_for_log(response_text or ""),
                        )
                        if index + 1 < len(model_candidates):
                            logger.info("Retrying local vision with fallback model=%s.", model_candidates[index + 1])
                            continue
                        return ""
                    logger.info(
                        "Local vision request failed with HTTP %s: %s",
                        response.status_code,
                        _truncate_for_log(response_text or ""),
                    )
                    return ""
                response_payload = response.json()
                if not isinstance(response_payload, dict):
                    return ""
                summary = extract_lmstudio_output_text(response_payload).strip()
                if summary:
                    logger.info("Local vision summary (%d chars): %s", len(summary), _truncate_for_log(summary))
                else:
                    logger.info("Local vision returned an empty summary.")
                return summary
            if attempted:
                logger.info("Local vision skipped after exhausting %d configured/loaded model candidate(s).", len(attempted))
            return ""
        except requests.exceptions.Timeout:
            logger.info("Local vision request timed out after %s ms; continuing without screen context.", config.vision.timeout_ms)
            return ""
        except Exception as exc:
            logger.info("Local vision request failed; continuing without screen context: %s", exc)
            return ""

    def _resolve_model_candidates(self, config: AppConfig) -> list[str]:
        candidates: list[str] = []
        explicit_vision_model = str(config.vision.model or "").strip() or None
        selected_llm_model = str(config.llm.model or "").strip() or None

        if config.llm.provider.lower() == "lmstudio":
            if ModelDiscovery.lmstudio_supports_vision(selected_llm_model, require_loaded=True):
                candidates.append(selected_llm_model)
            elif ModelDiscovery.lmstudio_supports_vision(selected_llm_model):
                logger.info(
                    "Local vision model %s is listed in LM Studio but not currently loaded. "
                    "Vision will use another loaded vision model if available.",
                    selected_llm_model,
                )

        if explicit_vision_model:
            if ModelDiscovery.lmstudio_supports_vision(explicit_vision_model, require_loaded=True):
                if explicit_vision_model not in candidates:
                    candidates.append(explicit_vision_model)
            elif ModelDiscovery.lmstudio_supports_vision(explicit_vision_model):
                logger.info(
                    "Configured vision model %s is listed in LM Studio but not currently loaded. "
                    "Vision will use another loaded vision model if available.",
                    explicit_vision_model,
                )

        fallback_model = ModelDiscovery.resolve_lmstudio_vision_model(
            explicit_vision_model or selected_llm_model,
            require_loaded=True,
            exclude_model_ids=set(candidates),
        )
        if fallback_model and fallback_model not in candidates:
            candidates.append(fallback_model)

        return candidates
