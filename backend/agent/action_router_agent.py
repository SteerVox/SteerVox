from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Optional

from action_routing import ActionRoute
from providers.llm_factory import LLMFactory
from utils.logger import get_logger

logger = get_logger()


@dataclass
class ActionRouterAgentResult:
    action: ActionRoute
    use_external_text: bool
    transcript_for_transform: str
    note_text: Optional[str]
    reason: str
    latency_ms: int


class ActionRouterAgent:
    def __init__(self, *, provider: str, model: str, temperature: float = 0.0):
        self.provider = provider
        self.model = model
        self.temperature = temperature

    def resolve(
        self,
        *,
        transcript: str,
        mode: str,
        external_text_available: bool,
    ) -> Optional[ActionRouterAgentResult]:
        try:
            from langchain_core.prompts import ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate
        except Exception as exc:
            logger.warning("Action router prompt dependencies are unavailable: %s", exc)
            return None

        try:
            llm = LLMFactory.get_llm(self.provider, self.model, self.temperature)
        except Exception as exc:
            logger.warning("Action router model unavailable: %s", exc)
            return None

        prompt = ChatPromptTemplate.from_messages([
            SystemMessagePromptTemplate.from_template(
                """You classify voice commands for a desktop dictation assistant.

Return strict JSON only with keys:
- action: one of "pass_through", "save_note", "transform_then_paste", "transform_then_save_note"
- use_external_text: boolean
- transcript_for_transform: string
- note_text: string or null
- reason: string

Rules:
- "save_note" means store a note in the local inbox instead of pasting anything.
- "transform_then_save_note" means run the normal Smart transform first, then save the transformed output to the inbox instead of pasting it.
- "transform_then_paste" means keep the normal Smart transform and paste flow.
- In dictation mode, never choose "transform_then_paste" or "transform_then_save_note".
- Use external text when the command refers to selected text, clipboard text, or says "this", "that", or "it" and external text is available.
- If the user clearly speaks note contents, prefer note_text over external text.
- Keep transcript_for_transform close to the user's request and remove only the save-to-note clause.
- Do not invent note text.
"""
            ),
            HumanMessagePromptTemplate.from_template(
                """Mode: {mode}
External text available: {external_text_available}
Transcript: {transcript}
"""
            ),
        ])

        chain = prompt | llm
        started_at = time.perf_counter()
        try:
            response = chain.invoke({
                "mode": mode,
                "external_text_available": "yes" if external_text_available else "no",
                "transcript": transcript,
            })
            latency_ms = int((time.perf_counter() - started_at) * 1000)
            raw = (response.content or "").strip()
            if raw.startswith("```"):
                lines = raw.splitlines()
                if len(lines) >= 3:
                    raw = "\n".join(lines[1:-1]).strip()
            data = json.loads(raw)
            return ActionRouterAgentResult(
                action=ActionRoute(data.get("action", ActionRoute.PASS_THROUGH.value)),
                use_external_text=bool(data.get("use_external_text")),
                transcript_for_transform=str(data.get("transcript_for_transform") or transcript).strip(),
                note_text=(str(data.get("note_text")).strip() or None) if data.get("note_text") is not None else None,
                reason=str(data.get("reason") or "Resolved by the Groq note router.").strip(),
                latency_ms=latency_ms,
            )
        except Exception as exc:
            logger.warning("Action router model failed to parse a route: %s", exc)
            return None
