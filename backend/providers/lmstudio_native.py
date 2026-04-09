from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any, Optional

import requests
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.runnables import RunnableLambda
from providers.model_discovery import ModelDiscovery


LMSTUDIO_NATIVE_BASE_URL = "http://localhost:1234/api/v1"
DEFAULT_TIMEOUT_SECONDS = 30.0
DISCOVERY_TIMEOUT_SECONDS = 2.0
LMSTUDIO_PLACEHOLDER_MODEL_ID = "local-model"
THINKING_BLOCK_PATTERN = re.compile(r"(?is)<(?:think|thinking)>\s*.*?\s*</(?:think|thinking)>")


def build_lmstudio_native_runnable(
    *,
    model: str,
    temperature: float,
    api_key: Optional[str] = None,
    timeout: float | None = None,
    max_tokens: int | None = None,
    context_length: int | None = None,
    reasoning_mode: str | None = None,
):
    client = LMStudioNativeChat(
        model=model,
        temperature=temperature,
        api_key=api_key,
        timeout=timeout,
        max_tokens=max_tokens,
        context_length=context_length,
        reasoning_mode=reasoning_mode,
    )
    runnable = RunnableLambda(client.invoke)
    setattr(runnable, "native_client", client)
    return runnable


def extract_lmstudio_output_text(payload: dict[str, Any]) -> str:
    return _extract_output_text(payload)


class LMStudioNativeChat:
    def __init__(
        self,
        *,
        model: str,
        temperature: float,
        api_key: Optional[str] = None,
        timeout: float | None = None,
        max_tokens: int | None = None,
        context_length: int | None = None,
        reasoning_mode: str | None = None,
    ):
        self.model = model
        self.temperature = temperature
        self.api_key = api_key
        self.timeout = timeout or DEFAULT_TIMEOUT_SECONDS
        self.max_tokens = max_tokens
        self.context_length = context_length
        self.reasoning_mode = reasoning_mode
        self._reasoning_disabled = False

    def invoke(self, prompt_input: Any) -> AIMessage:
        payload, headers, model_id = self._build_chat_request(prompt_input, stream=False)
        response = self._post_chat(payload, headers, stream_response=False)
        data = _safe_json(response)
        error_message = _extract_error_message(data, status_code=response.status_code, model_id=model_id)
        if error_message:
            raise RuntimeError(error_message)
        return AIMessage(
            content=_extract_output_text(data),
            additional_kwargs={
                "lmstudio_stats": data.get("stats", {}),
                "lmstudio_response_id": data.get("response_id"),
                "lmstudio_model_instance_id": data.get("model_instance_id"),
            },
        )

    def stream(self, prompt_input: Any) -> Iterator[dict[str, Any]]:
        payload, headers, model_id = self._build_chat_request(prompt_input, stream=True)
        response = self._post_chat(payload, headers, stream_response=True)

        try:
            for event_name, event_data in _iter_sse_events(response):
                if event_name == "error":
                    error_message = _extract_stream_error_message(event_data, model_id=model_id)
                    yield {
                        "event": event_name,
                        "data": event_data,
                        "error_message": error_message,
                    }
                    continue

                if event_name == "chat.end":
                    result_payload = event_data.get("result") if isinstance(event_data, dict) else None
                    result = result_payload if isinstance(result_payload, dict) else {}
                    error_message = _extract_error_message(result, status_code=response.status_code, model_id=model_id)
                    yield {
                        "event": event_name,
                        "data": event_data,
                        "error_message": error_message,
                    }
                    continue

                yield {
                    "event": event_name,
                    "data": event_data,
                    "error_message": None,
                }
        finally:
            response.close()

    def extract_output_text(self, payload: dict[str, Any]) -> str:
        return extract_lmstudio_output_text(payload)

    def _build_chat_request(self, prompt_input: Any, *, stream: bool) -> tuple[dict[str, Any], dict[str, str], str]:
        system_prompt, user_input = _split_prompt_input(prompt_input)
        model_id = self._resolve_model_id()
        payload: dict[str, Any] = {
            "model": model_id,
            "input": user_input,
            "temperature": self.temperature,
            "stream": stream,
            "store": False,
        }
        if system_prompt:
            payload["system_prompt"] = system_prompt
        if self.max_tokens is not None:
            payload["max_output_tokens"] = self.max_tokens
        if self.context_length is not None:
            payload["context_length"] = self.context_length
        if self.reasoning_mode is not None and not self._reasoning_disabled:
            payload["reasoning"] = self.reasoning_mode

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return payload, headers, model_id

    def _resolve_model_id(self) -> str:
        requested_model = str(self.model or "").strip()
        if requested_model and requested_model != LMSTUDIO_PLACEHOLDER_MODEL_ID:
            return requested_model

        discovered_model = self._discover_model_id()
        if discovered_model:
            return discovered_model

        raise RuntimeError(
            "No downloaded LM Studio model is available. Download a local model in LM Studio or choose one in Settings and try again."
        )

    def _discover_model_id(self) -> Optional[str]:
        response = self._request(
            "GET",
            f"{LMSTUDIO_NATIVE_BASE_URL}/models",
            headers={"Content-Type": "application/json"},
            timeout=min(self.timeout, DISCOVERY_TIMEOUT_SECONDS),
        )
        if response.status_code >= 400:
            raise RuntimeError(_build_http_error_message(response, model_id=None))

        payload = _safe_json(response)
        models = payload.get("models")
        if not isinstance(models, list):
            return None

        llm_models = [item for item in models if isinstance(item, dict) and item.get("type") == "llm"]
        if not llm_models:
            return None

        smart_models = [
            item for item in llm_models
            if ModelDiscovery._lmstudio_smart_capabilities(item)["smart_capable"]
        ]

        def priority(item: dict[str, Any]) -> tuple[int, int]:
            loaded_instances = item.get("loaded_instances")
            is_loaded = 0 if isinstance(loaded_instances, list) and loaded_instances else 1
            capabilities = item.get("capabilities") if isinstance(item.get("capabilities"), dict) else {}
            is_vision = 1 if capabilities.get("vision") else 0
            return (is_loaded, is_vision)

        def smart_priority(item: dict[str, Any]) -> tuple[int, int, int, int, int]:
            capabilities = ModelDiscovery._lmstudio_smart_capabilities(item)
            max_context = capabilities["max_context_length"] or 0
            return (
                0 if capabilities["recommended_for_smart"] else 1,
                0 if capabilities["tool_use"] else 1,
                0 if capabilities["reasoning"] else 1,
                0 if capabilities["loaded"] else 1,
                -max_context,
            )

        for item in sorted(smart_models, key=smart_priority):
            model_id = str(item.get("key") or item.get("id") or "").strip()
            if model_id:
                return model_id

        for item in sorted(llm_models, key=priority):
            model_id = str(item.get("key") or item.get("id") or "").strip()
            if model_id:
                return model_id
        return None

    def _post_chat(self, payload: dict[str, Any], headers: dict[str, str], *, stream_response: bool):
        response = self._request(
            "POST",
            f"{LMSTUDIO_NATIVE_BASE_URL}/chat",
            json=payload,
            headers=headers,
            timeout=self.timeout,
            stream_response=stream_response,
        )
        if response.status_code >= 400 and payload.get("reasoning") is not None and _response_rejects_reasoning(response):
            self._reasoning_disabled = True
            retry_payload = dict(payload)
            retry_payload.pop("reasoning", None)
            retry_response = self._request(
                "POST",
                f"{LMSTUDIO_NATIVE_BASE_URL}/chat",
                json=retry_payload,
                headers=headers,
                timeout=self.timeout,
                stream_response=stream_response,
            )
            if retry_response.status_code >= 400:
                raise RuntimeError(_build_http_error_message(retry_response, model_id=str(retry_payload.get("model") or "").strip() or None))
            return retry_response

        if response.status_code >= 400:
            raise RuntimeError(_build_http_error_message(response, model_id=str(payload.get("model") or "").strip() or None))
        return response

    def _request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        timeout: float,
        json: Optional[dict[str, Any]] = None,
        stream_response: bool = False,
    ):
        try:
            return requests.request(
                method,
                url,
                json=json,
                headers=headers,
                timeout=timeout,
                stream=stream_response,
            )
        except requests.exceptions.ConnectionError as exc:
            raise RuntimeError(
                "LM Studio local server is not reachable on port 1234. Start LM Studio and enable its local server, then try again."
            ) from exc
        except requests.exceptions.Timeout as exc:
            raise RuntimeError(
                "LM Studio local model timed out while generating output. Try a smaller model, reduce the prompt context, or try again."
            ) from exc
        except requests.RequestException as exc:
            raise RuntimeError(f"LM Studio request failed before a response was received: {exc}") from exc


def _split_prompt_input(prompt_input: Any) -> tuple[str, str]:
    if isinstance(prompt_input, str):
        stripped = prompt_input.strip()
        return "", stripped

    messages = _coerce_messages(prompt_input)
    system_parts: list[str] = []
    user_parts: list[str] = []
    for message in messages:
        content = _content_to_text(getattr(message, "content", ""))
        if not content:
            continue
        if getattr(message, "type", "") == "system":
            system_parts.append(content)
        else:
            user_parts.append(content)

    return "\n\n".join(system_parts).strip(), "\n\n".join(user_parts).strip()


def _coerce_messages(prompt_input: Any) -> list[BaseMessage]:
    if isinstance(prompt_input, BaseMessage):
        return [prompt_input]
    if isinstance(prompt_input, list) and all(isinstance(item, BaseMessage) for item in prompt_input):
        return list(prompt_input)

    to_messages = getattr(prompt_input, "to_messages", None)
    if callable(to_messages):
        coerced = to_messages()
        if isinstance(coerced, list):
            return [item for item in coerced if isinstance(item, BaseMessage)]

    return []


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                stripped = item.strip()
                if stripped:
                    parts.append(stripped)
                continue
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text":
                text = str(item.get("text") or "").strip()
                if text:
                    parts.append(text)
                continue
            text = str(item.get("content") or "").strip()
            if text:
                parts.append(text)
        return "\n".join(parts).strip()

    return str(content or "").strip()


def _extract_output_text(payload: dict[str, Any]) -> str:
    output_items = payload.get("output")
    if isinstance(output_items, list):
        message_parts = []
        for item in output_items:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "reasoning":
                continue
            content = _coerce_text_fragment(item.get("content"))
            if not content:
                content = _coerce_text_fragment(item.get("text"))
            if not content:
                continue
            if item.get("type") in {"message", "output_text", "text"}:
                message_parts.append(content)
        if message_parts:
            return _strip_reasoning_artifacts("\n\n".join(message_parts).strip())

    fallback_content = _coerce_text_fragment(payload.get("content"))
    if fallback_content:
        return _strip_reasoning_artifacts(fallback_content)
    return _strip_reasoning_artifacts(_coerce_text_fragment(payload.get("output_text")))


def _coerce_text_fragment(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        fragments = [_coerce_text_fragment(item) for item in value]
        return "\n".join(fragment for fragment in fragments if fragment).strip()
    if isinstance(value, dict):
        for key in ("text", "content", "value"):
            fragment = _coerce_text_fragment(value.get(key))
            if fragment:
                return fragment
    return str(value or "").strip()


def _safe_json(response: requests.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _iter_sse_events(response: requests.Response) -> Iterator[tuple[str, dict[str, Any]]]:
    event_name: str | None = None
    data_lines: list[str] = []
    for raw_line in response.iter_lines(decode_unicode=True):
        if raw_line is None:
            continue

        line = raw_line.rstrip("\r")
        if not line:
            if data_lines:
                yield event_name or "message", _coerce_sse_data("\n".join(data_lines))
            event_name = None
            data_lines = []
            continue

        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line.partition(":")[2].strip() or None
            continue
        if line.startswith("data:"):
            data_lines.append(line.partition(":")[2].lstrip())

    if data_lines:
        yield event_name or "message", _coerce_sse_data("\n".join(data_lines))


def _coerce_sse_data(raw_data: str) -> dict[str, Any]:
    stripped = raw_data.strip()
    if not stripped:
        return {}
    try:
        payload = json.loads(stripped)
    except ValueError:
        return {"content": stripped}
    return payload if isinstance(payload, dict) else {"content": str(payload)}


def _response_rejects_reasoning(response: requests.Response) -> bool:
    payload = _safe_json(response)
    error = payload.get("error")
    if isinstance(error, dict):
        param = str(error.get("param") or "").strip().lower()
        message = str(error.get("message") or "").strip().lower()
        if param == "reasoning":
            return True
        return "reasoning" in message and ("not support" in message or "invalid" in message)
    if isinstance(error, str):
        lowered = error.strip().lower()
        return "reasoning" in lowered and ("not support" in lowered or "invalid" in lowered)
    return False


def _extract_stream_error_message(payload: dict[str, Any], *, model_id: Optional[str]) -> Optional[str]:
    if not payload:
        return None
    error = payload.get("error")
    if not error:
        return None
    return _build_error_message_from_payload(error, status_code=400, model_id=model_id)


def _extract_error_message(payload: dict[str, Any], *, status_code: int, model_id: Optional[str]) -> Optional[str]:
    if not payload:
        return None
    error = payload.get("error")
    if not error:
        return None
    return _build_error_message_from_payload(error, status_code=status_code, model_id=model_id)


def _build_http_error_message(response: requests.Response, *, model_id: Optional[str]) -> str:
    payload = _safe_json(response)
    error = payload.get("error")
    if error:
        return _build_error_message_from_payload(error, status_code=response.status_code, model_id=model_id)

    raw_text = response.text.strip()
    if raw_text:
        return f"LM Studio request failed ({response.status_code}): {_truncate_text(raw_text)}"
    return f"LM Studio request failed ({response.status_code})."


def _build_error_message_from_payload(error: Any, *, status_code: int, model_id: Optional[str]) -> str:
    if isinstance(error, dict):
        message = str(error.get("message") or "").strip()
        code = str(error.get("code") or "").strip().lower()
        param = str(error.get("param") or "").strip().lower()
    else:
        message = str(error or "").strip()
        code = ""
        param = ""

    if code == "model_not_found" or param == "model":
        if model_id:
            return (
                f"The selected LM Studio model '{model_id}' is not available. "
                "Choose a downloaded local model in Settings and try again."
            )
        return "The selected LM Studio model is not available. Choose a downloaded local model in Settings and try again."

    if param == "reasoning":
        return "The selected LM Studio model does not support reasoning configuration."

    if status_code == 404 and model_id:
        return (
            f"The selected LM Studio model '{model_id}' is not available. "
            "Choose a downloaded local model in Settings and try again."
        )

    if status_code == 503:
        detail = f" {_truncate_text(message)}" if message else ""
        return f"LM Studio could not run the selected local model right now.{detail}"

    if message:
        return f"LM Studio request failed ({status_code}): {_truncate_text(message)}"
    return f"LM Studio request failed ({status_code})."


def _truncate_text(value: str, limit: int = 240) -> str:
    collapsed = " ".join(value.split()).strip()
    if len(collapsed) <= limit:
        return collapsed
    return f"{collapsed[: limit - 3].rstrip()}..."


def _strip_reasoning_artifacts(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    cleaned = THINKING_BLOCK_PATTERN.sub("", text)
    return cleaned.strip() or text
