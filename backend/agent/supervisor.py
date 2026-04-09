import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from agent.router import infer_format_preference
from providers.llm_factory import LLMFactory
from providers.lmstudio_native import LMStudioNativeChat, THINKING_BLOCK_PATTERN
from agent.skills.models import SkillDefinition
from utils.logger import get_logger

logger = get_logger()
CASUAL_TONE_KEYWORDS = ("slack", "discord", "teams", "messages", "signal", "telegram")
FORMAL_TONE_KEYWORDS = ("outlook", "mail", "gmail", "superhuman", "word", "pages", "docs")
PROFESSIONAL_TONE_KEYWORDS = ("jira", "linear", "asana", "notion", "confluence")
LOCAL_SMART_TIMEOUT_SECONDS = 12.0
REMOTE_SMART_TIMEOUT_SECONDS = 18.0
REMOTE_PROMPT_HEAVY_TIMEOUT_SECONDS = 24.0
TIMEOUT_ERROR_MARKERS = (
    "timed out",
    "timeout",
    "readtimeout",
    "read timeout",
    "apitimeouterror",
    "deadline exceeded",
)
PROMPT_HEAVY_STYLES = {
    "structured_prompt",
    "repo_task_brief",
    "structured_repo_task",
    "editor_task_prompt",
    "chat_ready_prompt",
    "structured_agent_schema",
}


@dataclass
class SupervisorResponse:
    text: Optional[str]
    context_fields_sent: list[str]
    payload_estimated_bytes: int
    latency_ms: int
    error: Optional[str] = None
    timeout_budget_ms: Optional[int] = None
    timeout_triggered: bool = False


@dataclass
class SupervisorPromptSpec:
    system_template: str
    human_template: str
    invoke_payload: Dict[str, str]
    context_fields_sent: list[str]
    payload_estimated_bytes: int
    llm_temperature: float
    llm_timeout: Optional[float] = None
    llm_max_retries: Optional[int] = None
    llm_max_tokens: Optional[int] = None
    llm_context_length: Optional[int] = None
    llm_reasoning_mode: Optional[str] = None
    compact_profile: bool = False


class SupervisorAgent:
    def __init__(self, provider: str = "groq", model: str = "llama3-70b-8192", temperature: float = 0.0):
        self.provider = provider
        self.model_name = model
        self.temperature = temperature

    def process_transcript(
        self,
        raw_transcript: str,
        os_context: Dict[str, Any],
        skill: SkillDefinition,
        *,
        preview_callback: Optional[Callable[[str], None]] = None,
    ) -> SupervisorResponse:
        if not raw_transcript or not raw_transcript.strip():
            logger.warning("Empty transcript provided to supervisor.")
            return SupervisorResponse(
                text=None,
                context_fields_sent=[],
                payload_estimated_bytes=0,
                latency_ms=0,
                error="Smart Mode received an empty transcript.",
                timeout_budget_ms=None,
                timeout_triggered=False,
            )

        prompt_spec = self._build_prompt_spec(raw_transcript, os_context, skill)

        try:
            llm = LLMFactory.get_llm(
                self.provider,
                self.model_name,
                prompt_spec.llm_temperature,
                timeout=prompt_spec.llm_timeout,
                max_retries=prompt_spec.llm_max_retries,
                max_tokens=prompt_spec.llm_max_tokens,
                context_length=prompt_spec.llm_context_length,
                reasoning_mode=prompt_spec.llm_reasoning_mode,
            )
        except Exception as e:
            logger.error(f"Failed to initialize LLM for agent processing: {e}")
            return SupervisorResponse(
                text=None,
                context_fields_sent=prompt_spec.context_fields_sent,
                payload_estimated_bytes=prompt_spec.payload_estimated_bytes,
                latency_ms=0,
                error="Smart Mode could not initialize the selected language model. Check your provider setup and try again.",
                timeout_budget_ms=self._timeout_budget_ms(prompt_spec.llm_timeout),
                timeout_triggered=False,
            )

        from langchain_core.prompts import ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate

        prompt = ChatPromptTemplate.from_messages([
            SystemMessagePromptTemplate.from_template(prompt_spec.system_template),
            HumanMessagePromptTemplate.from_template(prompt_spec.human_template)
        ])

        prompt_value = prompt.invoke(prompt_spec.invoke_payload)
        chain = prompt | llm

        logger.info(f"Invoking Supervisor Agent (Model: {self.model_name}, Skill: {skill.name})")

        started_at = time.perf_counter()
        try:
            final_text: Optional[str] = None
            if preview_callback is not None:
                final_text = self._invoke_with_preview(
                    llm=llm,
                    prompt_value=prompt_value,
                    invoke_payload=prompt_spec.invoke_payload,
                    chain=chain,
                    preview_callback=preview_callback,
                )
            if final_text is None:
                response = chain.invoke(prompt_spec.invoke_payload)
                final_text = self._normalize_model_output(response.content)

            elapsed_ms = int((time.perf_counter() - started_at) * 1000)

            return SupervisorResponse(
                text=final_text,
                context_fields_sent=prompt_spec.context_fields_sent,
                payload_estimated_bytes=prompt_spec.payload_estimated_bytes,
                latency_ms=elapsed_ms,
                timeout_budget_ms=self._timeout_budget_ms(prompt_spec.llm_timeout),
                timeout_triggered=False,
            )

        except Exception as e:
            logger.error(f"Supervisor Agent execution failed: {e}")
            timeout_triggered = self._is_timeout_error(e)
            error_message = "Smart Mode failed while generating the transformed result. Check your provider connection and try again."
            if timeout_triggered:
                if self.provider.lower() == "lmstudio":
                    error_message = "LM Studio local model timed out while generating output. Try a smaller model, reduce the prompt context, or try again."
                else:
                    error_message = f"{self.provider.title()} timed out while generating output. Smart Mode will fall back to safe local cleanup."
            elif self.provider.lower() == "lmstudio" and isinstance(e, RuntimeError):
                detail = str(e).strip()
                if detail:
                    error_message = detail
            return SupervisorResponse(
                text=None,
                context_fields_sent=prompt_spec.context_fields_sent,
                payload_estimated_bytes=prompt_spec.payload_estimated_bytes,
                latency_ms=int((time.perf_counter() - started_at) * 1000),
                error=error_message,
                timeout_budget_ms=self._timeout_budget_ms(prompt_spec.llm_timeout),
                timeout_triggered=timeout_triggered,
            )

    def _invoke_with_preview(
        self,
        *,
        llm: Any,
        prompt_value: Any,
        invoke_payload: Dict[str, str],
        chain: Any,
        preview_callback: Callable[[str], None],
    ) -> Optional[str]:
        streamed_text = self._stream_lmstudio_preview(llm=llm, prompt_value=prompt_value, preview_callback=preview_callback)
        if streamed_text is not None:
            return streamed_text

        response = chain.invoke(invoke_payload)
        final_text = self._normalize_model_output(response.content)
        if final_text:
            self._emit_preview_text(preview_callback, final_text)
        return final_text

    def _stream_lmstudio_preview(
        self,
        *,
        llm: Any,
        prompt_value: Any,
        preview_callback: Callable[[str], None],
    ) -> Optional[str]:
        if self.provider.lower() != "lmstudio":
            return None

        native_client = getattr(llm, "native_client", None)
        if not isinstance(native_client, LMStudioNativeChat) and not (
            hasattr(native_client, "stream") and hasattr(native_client, "extract_output_text")
        ):
            return None

        accumulated_text = ""
        final_text = ""
        last_emitted_text = ""
        last_emit_at = 0.0
        stream_error: Optional[str] = None
        chunk_emit_interval_seconds = 0.08
        min_chars_between_emits = 20

        for event in native_client.stream(prompt_value):
            event_name = str(event.get("event") or "").strip()
            payload = event.get("data")
            data = payload if isinstance(payload, dict) else {}
            if event_name == "message.delta":
                delta = str(data.get("content") or "")
                if not delta:
                    continue
                accumulated_text += delta
                now = time.perf_counter()
                should_emit = (
                    len(accumulated_text) - len(last_emitted_text) >= min_chars_between_emits
                    or "\n" in delta
                    or (now - last_emit_at) >= chunk_emit_interval_seconds
                )
                if should_emit:
                    self._emit_preview_text(preview_callback, accumulated_text)
                    last_emitted_text = accumulated_text
                    last_emit_at = now
                continue

            if event_name == "error":
                detail = str(event.get("error_message") or "").strip()
                if detail:
                    stream_error = detail
                continue

            if event_name != "chat.end":
                continue

            detail = str(event.get("error_message") or "").strip()
            if detail:
                stream_error = detail
            result_payload = data.get("result")
            result = result_payload if isinstance(result_payload, dict) else {}
            final_text = self._normalize_model_output(native_client.extract_output_text(result))
            if final_text and final_text != last_emitted_text:
                self._emit_preview_text(preview_callback, final_text)
                last_emitted_text = final_text

        if final_text:
            return final_text

        fallback_text = self._normalize_model_output(accumulated_text)
        if fallback_text:
            if fallback_text != last_emitted_text:
                self._emit_preview_text(preview_callback, fallback_text)
            return fallback_text

        if stream_error:
            raise RuntimeError(stream_error)
        return None

    def _emit_preview_text(self, preview_callback: Callable[[str], None], text: str) -> None:
        preview_text = text.strip()
        if not preview_text:
            return
        try:
            preview_callback(preview_text)
        except Exception as exc:
            logger.warning("Smart preview callback failed: %s", exc)

    def _normalize_model_output(self, raw_text: Any) -> str:
        final_text = str(raw_text or "").strip()
        if final_text.startswith("```") and final_text.endswith("```"):
            lines = final_text.split('\n')
            if len(lines) >= 3:
                final_text = '\n'.join(lines[1:-1])
        stripped_thinking = THINKING_BLOCK_PATTERN.sub("", final_text).strip()
        if stripped_thinking:
            final_text = stripped_thinking
        return final_text.strip()

    def _build_prompt_spec(self, raw_transcript: str, os_context: Dict[str, Any], skill: SkillDefinition) -> SupervisorPromptSpec:
        compact_profile = self._should_use_compact_local_profile(skill)
        slim_context = self._should_use_slim_prompt_context(skill)
        context_block, context_fields_sent = self._build_context_block(
            os_context,
            compact=compact_profile,
            minimal=slim_context,
        )
        external_block, external_fields_sent = self._build_external_text_block(os_context)
        screen_context_block, screen_context_fields_sent = self._build_screen_context_block(os_context)
        domain_block, domain_fields_sent = self._build_domain_block(os_context)
        memory_block, memory_fields_sent = self._build_memory_block(os_context)
        surface_contract_block, surface_fields_sent = self._build_surface_contract_block(os_context)
        format_preference_block, format_fields_sent = self._build_format_preference_block(raw_transcript, skill, os_context)
        tone_guidance_block, tone_fields_sent = self._build_tone_guidance_block(
            os_context,
            enabled=not slim_context,
        )
        local_depth_guidance_block, local_depth_fields_sent = self._build_local_depth_guidance_block(skill)
        all_context_fields_sent = context_fields_sent + external_fields_sent + screen_context_fields_sent + domain_fields_sent + memory_fields_sent + surface_fields_sent + format_fields_sent + tone_fields_sent + local_depth_fields_sent
        contract_block = self._build_contract_block(skill, minimal=slim_context)

        if compact_profile:
            instructions_block = self._build_compact_instructions_block(
                context_block=context_block,
                domain_block=domain_block,
                memory_block=memory_block,
                surface_contract_block=surface_contract_block,
                format_preference_block=format_preference_block,
                tone_guidance_block=tone_guidance_block,
                external_block=external_block,
                screen_context_block=screen_context_block,
                local_depth_guidance_block=local_depth_guidance_block,
            )
            source_material_block = self._build_source_material_block(os_context)
            payload_estimated_bytes = len(json.dumps({
                "prompt": skill.prompt,
                "contract": contract_block,
                "instructions": instructions_block,
                "transcript": raw_transcript,
                "source_material": source_material_block,
                "memory_context": memory_block,
            }).encode("utf-8"))
            return SupervisorPromptSpec(
                system_template="""{system_instruction}

Return only the transformed output.

--- SMART MODE SKILL CONTRACT ---
{contract_block}
---------------------------------
{instructions_block}
""",
                human_template="""Instruction:
{transcript}
{source_material_block}
""",
                invoke_payload={
                    "system_instruction": skill.prompt,
                    "contract_block": contract_block,
                    "instructions_block": instructions_block or "",
                    "transcript": raw_transcript,
                    "source_material_block": source_material_block or "",
                },
                context_fields_sent=all_context_fields_sent,
                payload_estimated_bytes=payload_estimated_bytes,
                llm_temperature=min(self.temperature, 0.1),
                llm_timeout=LOCAL_SMART_TIMEOUT_SECONDS,
                llm_max_retries=0,
                llm_max_tokens=self._resolve_local_max_tokens(skill),
                llm_context_length=self._resolve_local_context_length(skill),
                llm_reasoning_mode="off",
                compact_profile=True,
            )

        payload_estimated_bytes = len(json.dumps({
            "prompt": skill.prompt,
                "context": context_block,
                "external_text": external_block,
                "screen_context": screen_context_block,
                "domain_context": domain_block,
                "memory_context": memory_block,
                "surface_contract": surface_contract_block,
                "format_preference": format_preference_block,
                "tone_guidance": tone_guidance_block,
                "local_depth_guidance": local_depth_guidance_block,
            "contract": contract_block,
            "transcript": raw_transcript,
        }).encode("utf-8"))
        local_full_profile = self.provider.lower() == "lmstudio"
        remote_timeout = self._resolve_remote_timeout(skill) if not local_full_profile else None
        return SupervisorPromptSpec(
            system_template="""{system_instruction}

--- SMART MODE SKILL CONTRACT ---
{contract_block}
---------------------------------

--- CURRENT ACTIVE WINDOW CONTEXT ---
{context_block}
-------------------------------------
{domain_section}
{memory_section}
{surface_section}
{format_section}
{tone_section}
{local_depth_section}
{screen_context_section}
{external_text_section}
""",
            human_template="""Raw STT Transcript to Process:
{transcript}
""",
            invoke_payload={
                "system_instruction": skill.prompt,
                "context_block": context_block,
                "domain_section": self._format_domain_section(domain_block),
                "memory_section": self._format_memory_section(memory_block),
                "surface_section": self._format_surface_section(surface_contract_block),
                "format_section": self._format_format_section(format_preference_block),
                "tone_section": self._format_tone_section(tone_guidance_block),
                "local_depth_section": self._format_local_depth_section(local_depth_guidance_block),
                "screen_context_section": self._format_screen_context_section(screen_context_block),
                "contract_block": contract_block,
                "external_text_section": self._format_external_text_section(external_block),
                "transcript": raw_transcript,
            },
            context_fields_sent=all_context_fields_sent,
            payload_estimated_bytes=payload_estimated_bytes,
            llm_temperature=self.temperature,
            llm_timeout=LOCAL_SMART_TIMEOUT_SECONDS if local_full_profile else remote_timeout,
            llm_max_retries=0,
            llm_max_tokens=self._resolve_local_max_tokens(skill) if local_full_profile else None,
            llm_context_length=self._resolve_local_context_length(skill) if local_full_profile else None,
            llm_reasoning_mode="off" if local_full_profile else None,
        )

    def _resolve_remote_timeout(self, skill: SkillDefinition) -> float:
        if self._is_prompt_heavy_skill(skill):
            return REMOTE_PROMPT_HEAVY_TIMEOUT_SECONDS
        return REMOTE_SMART_TIMEOUT_SECONDS

    def _timeout_budget_ms(self, timeout_seconds: Optional[float]) -> Optional[int]:
        if timeout_seconds is None:
            return None
        return int(timeout_seconds * 1000)

    def _is_timeout_error(self, exc: Exception) -> bool:
        detail = " ".join(
            part.strip()
            for part in (
                type(exc).__name__,
                str(exc),
            )
            if part and str(part).strip()
        ).lower()
        return any(marker in detail for marker in TIMEOUT_ERROR_MARKERS)

    def _should_use_compact_local_profile(self, skill: SkillDefinition) -> bool:
        if self.provider.lower() != "lmstudio":
            return False
        if self._is_prompt_heavy_skill(skill):
            return False

        lowered_model = self.model_name.lower()
        return any(marker in lowered_model for marker in ("1b", "2b", "3b", "4b", "nano", "mini"))

    def _is_prompt_heavy_skill(self, skill: SkillDefinition) -> bool:
        return (skill.style or "").strip().lower() in PROMPT_HEAVY_STYLES

    def _should_use_slim_prompt_context(self, skill: SkillDefinition) -> bool:
        return (skill.style or "").strip().lower() in PROMPT_HEAVY_STYLES

    def _resolve_local_max_tokens(self, skill: SkillDefinition) -> int:
        if self._is_prompt_heavy_skill(skill):
            return 3000
        if skill.output_mode == "code":
            return 2200
        if skill.output_mode == "bullets":
            return 1200
        if skill.max_chars and skill.max_chars <= 120:
            return 512
        if skill.max_chars and skill.max_chars <= 400:
            return 900
        if skill.max_chars and skill.max_chars <= 1200:
            return 1600
        return 2200

    def _resolve_local_context_length(self, skill: SkillDefinition) -> int:
        if self._is_prompt_heavy_skill(skill):
            return 8192
        return 6144

    def _build_compact_instructions_block(
        self,
        *,
        context_block: str,
        domain_block: str,
        memory_block: str,
        surface_contract_block: str,
        format_preference_block: str,
        tone_guidance_block: str,
        external_block: str,
        screen_context_block: str,
        local_depth_guidance_block: str,
    ) -> str:
        sections = [
            self._format_context_section(context_block),
            self._format_domain_section(domain_block),
            self._format_memory_section(memory_block),
            self._format_surface_section(surface_contract_block),
            self._format_format_section(format_preference_block),
            self._format_tone_section(tone_guidance_block),
            self._format_local_depth_section(local_depth_guidance_block),
            self._format_screen_context_section(screen_context_block),
            self._format_external_text_section(external_block),
        ]
        rendered_sections = [section.strip() for section in sections if section.strip()]
        return "\n\n".join(rendered_sections)

    def _build_source_material_block(self, os_context: Dict[str, Any]) -> str:
        external_text = str(os_context.get("external_text") or "").strip()
        if not external_text:
            return ""
        source = str(os_context.get("external_text_source") or "clipboard").strip().lower()
        if source == "selection":
            source_label = "selected text"
        elif source == "transcript_inline":
            source_label = "spoken source text"
        elif source == "screen_context":
            source_label = "screen context"
        else:
            source_label = "clipboard text"
        return "\n".join([
            "",
            f"Source text to transform ({source_label}):",
            external_text,
        ]).strip()

    def _build_context_block(
        self,
        os_context: Dict[str, Any],
        *,
        compact: bool = False,
        minimal: bool = False,
    ) -> tuple[str, list[str]]:
        if minimal:
            fields: list[tuple[str, str, Any]] = [
                ("app_name", "App Name", os_context.get("app_name")),
                ("url_host", "Site Host", os_context.get("url_host")),
                ("code_file_name", "Detected File", os_context.get("code_file_name")),
                ("surface_kind", "Surface Kind", os_context.get("surface_kind")),
                ("target_type", "Target Type", os_context.get("target_type")),
                ("focused_field_label", "Focused Field Label", os_context.get("focused_field_label")),
            ]
        elif compact:
            fields: list[tuple[str, str, Any]] = [
                ("app_name", "App Name", os_context.get("app_name")),
                ("window_title", "Window Title", os_context.get("window_title")),
                ("page_title", "Page Title", os_context.get("page_title")),
                ("url_host", "Site Host", os_context.get("url_host")),
                ("code_file_name", "Detected File", os_context.get("code_file_name")),
                ("surface_kind", "Surface Kind", os_context.get("surface_kind")),
                ("target_type", "Target Type", os_context.get("target_type")),
                ("focused_field_label", "Focused Field Label", os_context.get("focused_field_label")),
                ("focused_field_placeholder", "Focused Field Placeholder", os_context.get("focused_field_placeholder")),
            ]
        else:
            fields = [
                ("app_name", "App Name", os_context.get("app_name")),
                ("bundle_id", "Bundle ID", os_context.get("bundle_id")),
                ("window_title", "Window Title", os_context.get("window_title")),
                ("page_title", "Page Title", os_context.get("page_title")),
                ("url_host", "Site Host", os_context.get("url_host")),
                ("url_path", "Page Path", os_context.get("url_path")),
                ("code_file_name", "Detected File", os_context.get("code_file_name")),
                ("code_file_extension", "Detected File Extension", os_context.get("code_file_extension")),
                ("surface_kind", "Surface Kind", os_context.get("surface_kind")),
                ("focused_field_label", "Focused Field Label", os_context.get("focused_field_label")),
                ("focused_field_placeholder", "Focused Field Placeholder", os_context.get("focused_field_placeholder")),
                ("context_quality", "Context Quality", os_context.get("context_quality")),
                ("target_type", "Target Type", os_context.get("target_type")),
            ]

        lines = []
        included_fields = []
        for key, label, value in fields:
            if value in (None, "", "Unknown"):
                continue
            lines.append(f"{label}: {value}")
            included_fields.append(key)

        if not lines:
            if minimal:
                return "", []
            return "Transcript-only fallback. No app or browser context was available.", []

        return "\n".join(lines), included_fields

    def _format_context_section(self, context_block: str) -> str:
        if not context_block:
            return ""
        return f"""
--- CURRENT ACTIVE WINDOW CONTEXT ---
{context_block}
-------------------------------------
"""

    def _build_external_text_block(self, os_context: Dict[str, Any]) -> tuple[str, list[str]]:
        external_text = os_context.get("external_text")
        if external_text:
            source = os_context.get("external_text_source") or "clipboard"
            guidance = [
                "If the transcript gives a referential instruction such as 'make this sound polite', 'rewrite this', or 'clean this up', transform the external text itself.",
                "Do not rewrite the instruction or answer it as a question.",
            ]
            if source == "selection":
                return "\n".join([
                    "The user currently has the following selected text:",
                    external_text,
                    *guidance,
                ]), ["selection_text"]
            if source == "transcript_inline":
                return "\n".join([
                    "The user spoke the following source text within the command:",
                    external_text,
                    *guidance,
                ]), ["external_text"]
            if source == "screen_context":
                return "\n".join([
                    "The local vision system extracted the following screen context:",
                    external_text,
                    "Use it as the source material when the transcript refers to this screen or page.",
                ]), ["screen_context"]
            return "\n".join([
                "The user currently has the following text on their clipboard:",
                external_text,
                *guidance,
            ]), ["clipboard_text"]

        # Clipboard text should only be sent once Smart has explicitly decided to
        # use it as source material. Including passive clipboard contents in the
        # prompt makes smaller local models echo the prompt scaffold itself.
        return "", []

    def _format_external_text_section(self, external_block: str) -> str:
        if not external_block:
            return ""
        return f"""
--- CURRENT EXTERNAL TEXT ---
{external_block}
-----------------------------
"""

    def _build_screen_context_block(self, os_context: Dict[str, Any]) -> tuple[str, list[str]]:
        block = str(os_context.get("screen_context") or "").strip()
        if not block:
            return "", []
        return block, ["screen_context"]

    def _format_screen_context_section(self, screen_context_block: str) -> str:
        if not screen_context_block:
            return ""
        return f"""
--- SCREEN CONTEXT ---
{screen_context_block}
----------------------
"""

    def _build_domain_block(self, os_context: Dict[str, Any]) -> tuple[str, list[str]]:
        block = str(os_context.get("domain_context_block") or "").strip()
        if not block:
            return "", []

        fields = ["domain_context"]
        if os_context.get("domain_id"):
            fields.append("domain_id")
        if os_context.get("domain_intent"):
            fields.append("domain_intent")
        if os_context.get("domain_glossary_hits"):
            fields.append("domain_glossary")
        if os_context.get("domain_template_id"):
            fields.append("domain_template")
        if os_context.get("domain_example_id"):
            fields.append("domain_example")
        return block, fields

    def _format_domain_section(self, domain_block: str) -> str:
        if not domain_block:
            return ""
        return f"""
--- ACTIVE DOMAIN CONTEXT ---
{domain_block}
-----------------------------
"""

    def _build_memory_block(self, os_context: Dict[str, Any]) -> tuple[str, list[str]]:
        block = str(os_context.get("memory_context_block") or "").strip()
        if not block:
            return "", []
        return block, ["memory_context"]

    def _format_memory_section(self, memory_block: str) -> str:
        if not memory_block:
            return ""
        return f"""
--- RELEVANT LOCAL MEMORY ---
{memory_block}
-----------------------------
"""

    def _build_surface_contract_block(self, os_context: Dict[str, Any]) -> tuple[str, list[str]]:
        surface_kind = str(os_context.get("surface_kind") or "").strip()
        domain_surface = str(os_context.get("domain_default_surface_behavior") or "").strip()
        if not surface_kind:
            if not domain_surface:
                return "", []
            surface_kind = "domain_default"

        label = str(os_context.get("focused_field_label") or "").strip()
        placeholder = str(os_context.get("focused_field_placeholder") or "").strip()
        lines = [f"Surface Kind: {surface_kind}"]
        if domain_surface:
            lines.append(f"Domain Surface Preference: {domain_surface}")
        if label:
            lines.append(f"Focused Field Label: {label}")
        if placeholder:
            lines.append(f"Focused Field Placeholder: {placeholder}")
        code_hint = str(os_context.get("code_format_hint") or "").strip()
        if code_hint:
            lines.append(f"Code Format Hint: {code_hint}")

        if surface_kind == "email_subject":
            lines.append("Return one concise subject line only. Do not include greeting, sign-off, bullets, labels, or body text.")
            lines.append("Do not prefix the output with 'Subject:'.")
        elif surface_kind in {"single_line_input", "search"}:
            lines.append("Return a single line only. Do not include bullets, labels, greeting, or sign-off.")
        elif surface_kind == "email_body":
            lines.append("You are writing inside an email body field. Include greeting or sign-off only when the transcript clearly asks for a full email.")
        elif surface_kind == "structured_editor":
            lines.append("Favor structured note or summary formatting over email-style greetings and sign-offs.")
        elif surface_kind == "chat_input":
            lines.append("Return a single chat-style message with no greeting, sign-off, or subject line.")
        elif domain_surface == "email":
            lines.append("Favor an email-style body only when the active field can accept multi-line content.")
        elif domain_surface == "note":
            lines.append("Favor structured note formatting over greeting-led email phrasing.")
        elif domain_surface == "summary":
            lines.append("Favor a summary or structured overview over a conversational reply.")

        fields = ["surface_kind"]
        if domain_surface:
            fields.append("domain_default_surface_behavior")
        if code_hint:
            fields.append("code_format_hint")
        return "\n".join(lines), fields

    def _format_surface_section(self, surface_contract_block: str) -> str:
        if not surface_contract_block:
            return ""
        return f"""
--- ACTIVE SURFACE CONTRACT ---
{surface_contract_block}
-------------------------------
"""

    def _build_format_preference_block(self, raw_transcript: str, skill: SkillDefinition, os_context: Dict[str, Any]) -> tuple[str, list[str]]:
        preference = infer_format_preference(raw_transcript, skill, os_context)
        if not preference:
            return "", []

        lines = [f"Preferred Format: {preference}"]
        if os_context.get("domain_default_format") and os_context.get("domain_default_format") != "auto":
            lines.append(f"Domain default format: {os_context.get('domain_default_format')}")
        if preference == "bullets":
            lines.append("Return a clean bulleted list instead of writing spoken scaffolding such as point, bullet, dash, item, first, or second.")
            lines.append("Each bullet should contain only the underlying item content.")
        elif preference == "checklist":
            lines.append("Return a checkbox-style list with one clean item per line.")
        elif preference == "numbered":
            lines.append("Return a numbered list with one step or item per line.")
        elif preference == "table":
            lines.append("Return a compact plain-text table or aligned columns only when the transcript clearly asks for table-like output.")
        elif preference == "paragraph":
            lines.append("Prefer a clean paragraph over bullets unless the transcript explicitly asks for a list.")
        fields = ["format_preference"]
        if os_context.get("domain_default_format"):
            fields.append("domain_default_format")
        return "\n".join(lines), fields

    def _format_format_section(self, format_preference_block: str) -> str:
        if not format_preference_block:
            return ""
        return f"""
--- FORMAT PREFERENCE ---
{format_preference_block}
-------------------------
"""

    def _build_tone_guidance_block(self, os_context: Dict[str, Any], *, enabled: bool = True) -> tuple[str, list[str]]:
        if not enabled:
            return "", []
        searchable = " ".join(
            str(part).strip().lower()
            for part in (
                os_context.get("app_name"),
                os_context.get("window_title"),
                os_context.get("page_title"),
                os_context.get("url_host"),
            )
            if part
        )
        if not searchable:
            return "", []

        if any(keyword in searchable for keyword in CASUAL_TONE_KEYWORDS):
            return "\n".join([
                "Recommended Tone: casual",
                "Adapt the wording for a fast, natural chat surface while preserving the user's meaning.",
                "Keep the original vocabulary whenever possible unless the active skill explicitly calls for a stronger rewrite.",
            ]), ["tone_guidance"]

        if any(keyword in searchable for keyword in FORMAL_TONE_KEYWORDS):
            return "\n".join([
                "Recommended Tone: formal",
                "Adapt the wording for a polished email or document surface while preserving the user's meaning.",
                "Keep the original vocabulary whenever possible unless the active skill explicitly calls for a stronger rewrite.",
            ]), ["tone_guidance"]

        if any(keyword in searchable for keyword in PROFESSIONAL_TONE_KEYWORDS):
            return "\n".join([
                "Recommended Tone: concise professional",
                "Favor direct, organized wording appropriate for work tracking or project updates.",
                "Keep the original vocabulary whenever possible unless the active skill explicitly calls for a stronger rewrite.",
            ]), ["tone_guidance"]

        return "", []

    def _format_tone_section(self, tone_guidance_block: str) -> str:
        if not tone_guidance_block:
            return ""
        return f"""
--- APP TONE GUIDANCE ---
{tone_guidance_block}
------------------------
"""

    def _build_local_depth_guidance_block(self, skill: SkillDefinition) -> tuple[str, list[str]]:
        if not self._is_prompt_heavy_skill(skill):
            return "", []

        style = (skill.style or "").strip().lower()
        lines = [
            "Depth Requirement: Do not collapse this into a one-line or two-line summary.",
            "Return a directly usable prompt or engineering brief with enough detail to paste into the target AI tool immediately.",
        ]
        if style == "chat_ready_prompt":
            lines.append("Prefer a direct request over meta prompt scaffolding.")
            lines.append("Use headings or bullets only when they materially improve clarity.")
            lines.append("Do not default to Role, Context, Constraints, Output Format, or Edge Cases for simple chatbot requests.")
        elif style == "structured_prompt":
            lines.append("Prefer a direct ready-to-paste prompt unless the user explicitly asked for a system or agent prompt.")
            lines.append("Use sections such as Role, Objective, Context, Constraints, Output Format, and Edge Cases only when they materially improve the result.")
        else:
            lines.append("Include concrete scope, constraints, implementation details, and verification notes when the transcript implies them.")
        return "\n".join(lines), ["local_depth_guidance"]

    def _format_local_depth_section(self, local_depth_guidance_block: str) -> str:
        if not local_depth_guidance_block:
            return ""
        return f"""
--- OUTPUT DEPTH GUIDANCE ---
{local_depth_guidance_block}
-----------------------------
"""

    def _build_contract_block(self, skill: SkillDefinition, *, minimal: bool = False) -> str:
        if minimal:
            lines = [f"Output Mode: {skill.output_mode}"]
            if skill.max_chars:
                lines.append(f"Target Length: up to {skill.max_chars} characters when practical")
            return "\n".join(lines)

        lines = [
            f"Skill Name: {skill.name}",
            f"Output Mode: {skill.output_mode}",
            f"Fallback Behavior: {skill.fallback_behavior}",
        ]
        if skill.style:
            lines.append(f"Style: {skill.style}")
        if skill.max_chars:
            lines.append(f"Max Chars: {skill.max_chars}")
        if skill.target_types:
            lines.append(f"Target Types: {', '.join(skill.target_types)}")
        if skill.triggers:
            lines.append(f"Triggers: {', '.join(skill.triggers)}")
        return "\n".join(lines)
