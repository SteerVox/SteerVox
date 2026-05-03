from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Optional

try:
    from langchain_core.prompts import ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate
    SMART_ROUTER_PROMPT_IMPORT_ERROR: Optional[Exception] = None
except Exception as exc:  # pragma: no cover - exercised indirectly when dependencies are absent
    ChatPromptTemplate = None
    HumanMessagePromptTemplate = None
    SystemMessagePromptTemplate = None
    SMART_ROUTER_PROMPT_IMPORT_ERROR = exc

from agent.smart_models import RoutingDecision, SmartIntent, SmartLane
from providers.llm_factory import LLMFactory
from providers.model_discovery import ModelDiscovery
from security.secrets_manager import SecretsManager
from utils.logger import get_logger

logger = get_logger()
ROUTER_TIMEOUT_SECONDS = 3.0
SMART_ROUTER_INTENTS = ", ".join(f'"{intent.value}"' for intent in SmartIntent)
SMART_ROUTER_LANES = ", ".join(f'"{lane.value}"' for lane in SmartLane)


@dataclass(frozen=True)
class SmartRouterAgentResult:
    intent: SmartIntent
    lane: SmartLane
    confidence: float
    reason: str
    latency_ms: int


@dataclass(frozen=True)
class SmartSkillRouterAgentResult:
    skill_id: str
    confidence: float
    reason: str
    latency_ms: int


def should_use_smart_router_model(decision: RoutingDecision, *, mode: str) -> bool:
    if mode != "smart_transform":
        return False
    if decision.lane != SmartLane.LLM:
        return False
    return (
        decision.intent == SmartIntent.GENERIC
        or decision.confidence < 0.86
        or decision.fallback_applied
    )


class SmartRouterAgent:
    def __init__(self, *, provider: str, model: str, temperature: float = 0.0):
        self.provider = provider
        self.model = model
        self.temperature = temperature

    def resolve(
        self,
        *,
        transcript: str,
        context: dict,
        requested_skill_id: str,
        requested_skill_name: str,
        effective_skill_id: str,
        effective_skill_name: str,
        local_decision: RoutingDecision,
        selection_available: bool,
        clipboard_available: bool,
        available_skills: list[dict[str, Any]],
    ) -> tuple[Optional[SmartRouterAgentResult], Optional[str]]:
        if SMART_ROUTER_PROMPT_IMPORT_ERROR is not None:
            logger.warning("Smart router prompt dependencies are unavailable: %s", SMART_ROUTER_PROMPT_IMPORT_ERROR)
            return None, "Smart router prompt dependencies were unavailable."

        try:
            llm = self._build_llm()
        except Exception as exc:
            logger.warning("Smart router model unavailable: %s", exc)
            return None, "Smart router model was unavailable."

        prompt = ChatPromptTemplate.from_messages([
            SystemMessagePromptTemplate.from_template(
                """You classify Smart Mode requests for a desktop dictation assistant.

Return strict JSON only with keys:
- intent: one of {intents}
- lane: one of {lanes}
- confidence: number between 0 and 1
- reason: string

Rules:
- You are routing only the Smart transform step. Do not choose note-save behavior.
- Do not rewrite or improve the transcript. You are only classifying intent and lane.
- Prefer "deterministic" only for clearly safe local cleanup or terminal-command cases.
- Prefer "passthrough" only when the transcript should stay literal.
- If the local candidate already looks correct, keep it.
- Use the transcript, Smart context, selected/clipboard availability, and skill information together.
- The currently loaded skills are runtime data from the app. Use them to understand what kinds of rewrites the user can invoke.
- Be conservative. If the request clearly needs the selected LLM, choose "llm".
"""
            ),
            HumanMessagePromptTemplate.from_template(
                """Transcript: {transcript}

Requested skill: {requested_skill_name} ({requested_skill_id})
Effective skill: {effective_skill_name} ({effective_skill_id})

Local candidate:
- intent: {local_intent}
- lane: {local_lane}
- confidence: {local_confidence}
- reason: {local_reason}

Context:
{context_json}

Available skills:
{available_skills}

External text available:
- selection: {selection_available}
- clipboard: {clipboard_available}
"""
            ),
        ])

        chain = prompt | llm
        started_at = time.perf_counter()
        try:
            response = chain.invoke({
                "transcript": transcript,
                "requested_skill_name": requested_skill_name,
                "requested_skill_id": requested_skill_id,
                "effective_skill_name": effective_skill_name,
                "effective_skill_id": effective_skill_id,
                "local_intent": local_decision.intent.value,
                "local_lane": local_decision.lane.value,
                "local_confidence": local_decision.confidence,
                "local_reason": local_decision.reason,
                "context_json": json.dumps(context, ensure_ascii=True, sort_keys=True),
                "available_skills": self._format_available_skills(available_skills),
                "selection_available": "yes" if selection_available else "no",
                "clipboard_available": "yes" if clipboard_available else "no",
                "intents": SMART_ROUTER_INTENTS,
                "lanes": SMART_ROUTER_LANES,
            })
        except Exception as exc:
            logger.warning("Smart router model invocation failed: %s", exc)
            return None, "Smart router model invocation failed."

        latency_ms = int((time.perf_counter() - started_at) * 1000)
        try:
            raw = (response.content or "").strip()
            if raw.startswith("```"):
                lines = raw.splitlines()
                if len(lines) >= 3:
                    raw = "\n".join(lines[1:-1]).strip()
            data = json.loads(raw)
            intent = SmartIntent(str(data.get("intent", "")).strip())
            lane = SmartLane(str(data.get("lane", "")).strip())
            confidence = min(max(float(data.get("confidence", 0.0)), 0.0), 1.0)
            reason = str(data.get("reason") or "Resolved by the Groq Smart router.").strip()
            return SmartRouterAgentResult(
                intent=intent,
                lane=lane,
                confidence=confidence,
                reason=reason,
                latency_ms=latency_ms,
            ), None
        except Exception as exc:
            logger.warning("Smart router model failed to parse a decision: %s", exc)
            return None, "Smart router model returned an invalid routing decision."

    def resolve_skill(
        self,
        *,
        transcript: str,
        context: dict,
        requested_skill_id: str,
        requested_skill_name: str,
        local_candidate_skill_id: str,
        local_candidate_reason: str,
        candidate_skills: list[dict[str, Any]],
    ) -> tuple[Optional[SmartSkillRouterAgentResult], Optional[str]]:
        if SMART_ROUTER_PROMPT_IMPORT_ERROR is not None:
            logger.warning("Smart router prompt dependencies are unavailable: %s", SMART_ROUTER_PROMPT_IMPORT_ERROR)
            return None, "Smart router prompt dependencies were unavailable."

        try:
            llm = self._build_llm()
        except Exception as exc:
            logger.warning("Smart skill router model unavailable: %s", exc)
            return None, "Smart skill router model was unavailable."

        prompt = ChatPromptTemplate.from_messages([
            SystemMessagePromptTemplate.from_template(
                """You select the best Smart Mode writing skill for a desktop dictation assistant.

Return strict JSON only with keys:
- skill_id: one of the listed candidate skills
- confidence: number between 0 and 1
- reason: string

Rules:
- Choose exactly one candidate skill_id from the provided list.
- Be conservative. If no specialized skill is clearly better than neutral dictation, choose system_dictation.
- Use transcript, app/site context, focused-field hints, and the candidate catalog together.
- Prefer platform-native writing skills when the context clearly matches the writing surface.
- Do not invent a skill id that is not in the candidate list.
"""
            ),
            HumanMessagePromptTemplate.from_template(
                """Transcript: {transcript}

Requested skill: {requested_skill_name} ({requested_skill_id})
Local candidate: {local_candidate_skill_id}
Local candidate reason: {local_candidate_reason}

Context:
{context_json}

Candidate skills:
{candidate_skills}
"""
            ),
        ])

        chain = prompt | llm
        started_at = time.perf_counter()
        try:
            response = chain.invoke({
                "transcript": transcript,
                "requested_skill_name": requested_skill_name,
                "requested_skill_id": requested_skill_id,
                "local_candidate_skill_id": local_candidate_skill_id,
                "local_candidate_reason": local_candidate_reason,
                "context_json": json.dumps(context, ensure_ascii=True, sort_keys=True),
                "candidate_skills": self._format_available_skills(candidate_skills),
            })
        except Exception as exc:
            logger.warning("Smart skill router model invocation failed: %s", exc)
            return None, "Smart skill router model invocation failed."

        latency_ms = int((time.perf_counter() - started_at) * 1000)
        candidate_ids = {str(skill.get("id")) for skill in candidate_skills}
        try:
            raw = (response.content or "").strip()
            if raw.startswith("```"):
                lines = raw.splitlines()
                if len(lines) >= 3:
                    raw = "\n".join(lines[1:-1]).strip()
            data = json.loads(raw)
            skill_id = str(data.get("skill_id", "")).strip()
            if skill_id not in candidate_ids:
                raise ValueError(f"Unknown skill id {skill_id!r}")
            confidence = min(max(float(data.get("confidence", 0.0)), 0.0), 1.0)
            reason = str(data.get("reason") or "Resolved by the Smart skill router.").strip()
            return SmartSkillRouterAgentResult(
                skill_id=skill_id,
                confidence=confidence,
                reason=reason,
                latency_ms=latency_ms,
            ), None
        except Exception as exc:
            logger.warning("Smart skill router model failed to parse a decision: %s", exc)
            return None, "Smart skill router model returned an invalid skill decision."

    def _build_llm(self):
        provider = self.provider.lower()
        normalized_model = self._normalize_router_model(provider, self.model)
        if provider == "groq":
            from langchain_groq import ChatGroq

            api_key = SecretsManager.get_api_key(provider)
            return ChatGroq(
                model=normalized_model,
                temperature=self.temperature,
                api_key=api_key,
                timeout=ROUTER_TIMEOUT_SECONDS,
                max_retries=0,
            )
        extra_kwargs: dict[str, Any] = {
            "timeout": ROUTER_TIMEOUT_SECONDS,
            "max_retries": 0,
        }
        if provider == "lmstudio":
            extra_kwargs.update({
                "max_tokens": 600,
                "context_length": ModelDiscovery.lmstudio_resolve_request_context_length(normalized_model, 4096),
                "reasoning_mode": "off",
            })
        return LLMFactory.get_llm(
            provider,
            normalized_model,
            self.temperature,
            **extra_kwargs,
        )

    @staticmethod
    def _normalize_router_model(provider: str, model: str) -> str:
        if provider.lower() == "groq" and model.startswith("groq/"):
            return model.split("/", 1)[1]
        return model

    @staticmethod
    def _format_available_skills(available_skills: list[dict[str, Any]]) -> str:
        if not available_skills:
            return "- none"
        return "\n".join(
            (
                f"- {skill.get('id')}: {skill.get('name')}"
                f" | targets={','.join(skill.get('target_types') or []) or 'any'}"
                f" | output={skill.get('output_mode') or 'plain_text'}"
                f" | {skill.get('description') or 'No description'}"
            )
            for skill in available_skills
        )
