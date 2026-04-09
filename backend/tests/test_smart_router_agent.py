import agent.smart_router_agent as smart_router_agent_module
from agent.skills.defaults import DefaultSkills
from agent.skills.models import SkillDefinition
from agent.smart_models import SmartIntent, SmartLane
from agent.smart_router_agent import SmartRouterAgent, should_use_smart_router_model
from agent.router import LocalIntentRouter


def test_smart_router_model_normalizes_groq_prefix():
    assert SmartRouterAgent._normalize_router_model("groq", "groq/compound-mini") == "compound-mini"
    assert SmartRouterAgent._normalize_router_model("groq", "compound-mini") == "compound-mini"


def test_smart_router_uses_router_timeout_for_non_groq_clients(monkeypatch):
    captured = {}

    def fake_get_llm(provider, model, temperature, **kwargs):
        captured.update({
            "provider": provider,
            "model": model,
            "temperature": temperature,
            **kwargs,
        })
        return object()

    monkeypatch.setattr(smart_router_agent_module.LLMFactory, "get_llm", fake_get_llm)

    agent = SmartRouterAgent(provider="openai", model="gpt-4.1-mini", temperature=0.2)
    llm = agent._build_llm()

    assert llm is not None
    assert captured == {
        "provider": "openai",
        "model": "gpt-4.1-mini",
        "temperature": 0.2,
        "timeout": smart_router_agent_module.ROUTER_TIMEOUT_SECONDS,
        "max_retries": 0,
    }


def test_smart_router_uses_local_request_tuning_for_lmstudio(monkeypatch):
    captured = {}

    def fake_get_llm(provider, model, temperature, **kwargs):
        captured.update({
            "provider": provider,
            "model": model,
            "temperature": temperature,
            **kwargs,
        })
        return object()

    monkeypatch.setattr(smart_router_agent_module.LLMFactory, "get_llm", fake_get_llm)

    agent = SmartRouterAgent(provider="lmstudio", model="qwen2.5-7b-instruct", temperature=0.0)
    llm = agent._build_llm()

    assert llm is not None
    assert captured == {
        "provider": "lmstudio",
        "model": "qwen2.5-7b-instruct",
        "temperature": 0.0,
        "timeout": smart_router_agent_module.ROUTER_TIMEOUT_SECONDS,
        "max_retries": 0,
        "max_tokens": 600,
        "context_length": 4096,
        "reasoning_mode": "off",
    }


def test_smart_router_gate_triggers_for_ambiguous_llm_route():
    generic_skill = SkillDefinition(
        id="custom_generic",
        name="Generic Rewriter",
        prompt="Rewrite with clarity.",
    )
    decision = LocalIntentRouter().plan(
        "Need a better structure for this paragraph before we send it",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=generic_skill,
        effective_skill=generic_skill,
    )

    assert decision.intent == SmartIntent.GENERIC
    assert decision.lane == SmartLane.LLM
    assert should_use_smart_router_model(decision, mode="smart_transform") is True


def test_smart_router_gate_skips_strong_local_routes():
    decision = LocalIntentRouter().plan(
        "translate this to spanish thanks for the quick update",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.TRANSLATE
    assert should_use_smart_router_model(decision, mode="smart_transform") is False


def test_smart_router_returns_clear_error_when_prompt_imports_are_unavailable(monkeypatch):
    monkeypatch.setattr(smart_router_agent_module, "SMART_ROUTER_PROMPT_IMPORT_ERROR", RuntimeError("missing prompt deps"))

    agent = SmartRouterAgent(provider="groq", model="groq/compound-mini")
    result, error = agent.resolve(
        transcript="clean this up",
        context={"app_name": "Notes", "context_quality": "app_only", "target_type": "generic"},
        requested_skill_id="system_grammar",
        requested_skill_name="Fix Grammar & Tone",
        effective_skill_id="system_grammar",
        effective_skill_name="Fix Grammar & Tone",
        local_decision=LocalIntentRouter().plan(
            "clean this up",
            {"app_name": "Notes", "context_quality": "app_only", "target_type": "generic"},
            requested_skill=DefaultSkills.GRAMMAR_FIX,
            effective_skill=DefaultSkills.GRAMMAR_FIX,
        ),
        selection_available=False,
        clipboard_available=False,
        available_skills=[],
    )

    assert result is None
    assert error == "Smart router prompt dependencies were unavailable."


def test_smart_router_renders_available_skill_catalog_into_prompt(monkeypatch):
    captured_payload = {}

    class FakePrompt:
        def __or__(self, _llm):
            class FakeChain:
                @staticmethod
                def invoke(payload):
                    captured_payload.update(payload)
                    return type("Response", (), {
                        "content": '{"intent":"generic","lane":"llm","confidence":0.88,"reason":"Generic rewrite."}',
                    })()

            return FakeChain()

    class FakeChatPromptTemplate:
        @staticmethod
        def from_messages(_messages):
            return FakePrompt()

    class FakePromptMessage:
        @staticmethod
        def from_template(template):
            return template

    monkeypatch.setattr(smart_router_agent_module, "SMART_ROUTER_PROMPT_IMPORT_ERROR", None)
    monkeypatch.setattr(smart_router_agent_module, "ChatPromptTemplate", FakeChatPromptTemplate)
    monkeypatch.setattr(smart_router_agent_module, "SystemMessagePromptTemplate", FakePromptMessage)
    monkeypatch.setattr(smart_router_agent_module, "HumanMessagePromptTemplate", FakePromptMessage)
    monkeypatch.setattr(SmartRouterAgent, "_build_llm", lambda self: object())

    agent = SmartRouterAgent(provider="groq", model="groq/compound-mini")
    result, error = agent.resolve(
        transcript="make this sound more polished",
        context={"app_name": "Notes", "context_quality": "app_only", "target_type": "generic"},
        requested_skill_id="system_rewrite",
        requested_skill_name="Professional Rewrite",
        effective_skill_id="system_rewrite",
        effective_skill_name="Professional Rewrite",
        local_decision=LocalIntentRouter().plan(
            "make this sound more polished",
            {"app_name": "Notes", "context_quality": "app_only", "target_type": "generic"},
            requested_skill=DefaultSkills.SYSTEM_REWRITE,
            effective_skill=DefaultSkills.SYSTEM_REWRITE,
        ),
        selection_available=True,
        clipboard_available=False,
        available_skills=[
            {"id": "strict_grammar", "name": "Strict Grammar"},
            {"id": "system_rewrite", "name": "Professional Rewrite"},
        ],
    )

    assert error is None
    assert result is not None
    assert "- strict_grammar: Strict Grammar" in captured_payload["available_skills"]
    assert "- system_rewrite: Professional Rewrite" in captured_payload["available_skills"]


def test_smart_skill_router_parses_candidate_skill_selection(monkeypatch):
    captured_payload = {}

    class FakePrompt:
        def __or__(self, _llm):
            class FakeChain:
                @staticmethod
                def invoke(payload):
                    captured_payload.update(payload)
                    return type("Response", (), {
                        "content": '{"skill_id":"system_social_post","confidence":0.92,"reason":"LinkedIn compose context fits the social post skill."}',
                    })()

            return FakeChain()

    class FakeChatPromptTemplate:
        @staticmethod
        def from_messages(_messages):
            return FakePrompt()

    class FakePromptMessage:
        @staticmethod
        def from_template(template):
            return template

    monkeypatch.setattr(smart_router_agent_module, "SMART_ROUTER_PROMPT_IMPORT_ERROR", None)
    monkeypatch.setattr(smart_router_agent_module, "ChatPromptTemplate", FakeChatPromptTemplate)
    monkeypatch.setattr(smart_router_agent_module, "SystemMessagePromptTemplate", FakePromptMessage)
    monkeypatch.setattr(smart_router_agent_module, "HumanMessagePromptTemplate", FakePromptMessage)
    monkeypatch.setattr(SmartRouterAgent, "_build_llm", lambda self: object())

    agent = SmartRouterAgent(provider="groq", model="groq/compound-mini")
    result, error = agent.resolve_skill(
        transcript="write a short launch update",
        context={"app_name": "Google Chrome", "url_host": "linkedin.com", "target_type": "social_post"},
        requested_skill_id="system_dictation",
        requested_skill_name="Standard Dictation",
        local_candidate_skill_id="system_social_post",
        local_candidate_reason="LinkedIn compose context matched the current writing surface.",
        candidate_skills=[
            {"id": "system_dictation", "name": "Standard Dictation", "target_types": [], "output_mode": "plain_text", "description": "Neutral dictation"},
            {"id": "system_social_post", "name": "Social / Professional Post", "target_types": ["social_post"], "output_mode": "plain_text", "description": "Platform-native post writer"},
        ],
    )

    assert error is None
    assert result is not None
    assert result.skill_id == "system_social_post"
    assert "system_social_post" in captured_payload["candidate_skills"]
