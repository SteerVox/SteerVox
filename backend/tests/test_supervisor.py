from agent.skills.defaults import DefaultSkills
from agent.supervisor import SupervisorAgent
from langchain_core.runnables import RunnableLambda


def _mock_loaded_lmstudio_model(monkeypatch, *, model_id: str, context_length: int = 8192):
    monkeypatch.setattr(
        "agent.supervisor.ModelDiscovery.get_lmstudio_model_catalog",
        lambda: [
            {
                "key": model_id,
                "loaded_instances": [
                    {
                        "config": {
                            "context_length": context_length,
                        }
                    }
                ],
            }
        ],
    )


def test_supervisor_builds_formal_tone_guidance_for_email_apps():
    agent = SupervisorAgent()

    block, fields = agent._build_tone_guidance_block({"app_name": "Outlook"})

    assert "Recommended Tone: formal" in block
    assert fields == ["tone_guidance"]


def test_supervisor_builds_casual_tone_guidance_for_chat_apps():
    agent = SupervisorAgent()

    block, fields = agent._build_tone_guidance_block({"app_name": "Slack", "window_title": "eng-updates"})

    assert "Recommended Tone: casual" in block
    assert fields == ["tone_guidance"]


def test_supervisor_uses_compact_prompt_profile_for_small_lmstudio_models(monkeypatch):
    _mock_loaded_lmstudio_model(
        monkeypatch,
        model_id="nvidia/nemotron-3-nano-4b",
        context_length=8192,
    )
    agent = SupervisorAgent(provider="lmstudio", model="nvidia/nemotron-3-nano-4b", temperature=0.3)

    spec = agent._build_prompt_spec(
        "make this sound polite",
        {
            "app_name": "Slack",
            "window_title": "eng-updates",
            "target_type": "chat",
            "surface_kind": "chat_input",
            "external_text": "ship this after qa signs off",
            "external_text_source": "selection",
        },
        DefaultSkills.SYSTEM_REWRITE,
    )

    assert spec.compact_profile is True
    assert spec.llm_temperature == 0.1
    assert spec.llm_max_retries == 0
    assert spec.llm_max_tokens == 2200
    assert spec.llm_context_length == 8192
    assert spec.llm_reasoning_mode == "off"
    assert "--- ACTIVE DOMAIN CONTEXT ---" not in spec.invoke_payload["instructions_block"]
    assert "--- CURRENT EXTERNAL TEXT ---" in spec.invoke_payload["instructions_block"]
    assert "--- ACTIVE SURFACE CONTRACT ---" in spec.invoke_payload["instructions_block"]
    assert "transform the external text itself" in spec.invoke_payload["instructions_block"]
    assert "Source text to transform (selected text):" in spec.invoke_payload["source_material_block"]


def test_supervisor_keeps_full_local_profile_for_prompt_heavy_skills(monkeypatch):
    _mock_loaded_lmstudio_model(
        monkeypatch,
        model_id="nvidia/nemotron-3-nano-4b",
        context_length=8192,
    )
    agent = SupervisorAgent(provider="lmstudio", model="nvidia/nemotron-3-nano-4b", temperature=0.3)

    spec = agent._build_prompt_spec(
        "create a system prompt for a coding agent that fixes tests and preserves existing behavior",
        {
            "app_name": "Codex",
            "window_title": "workspace",
            "target_type": "ide",
        },
        DefaultSkills.PROMPT_ARCHITECT,
    )

    assert spec.compact_profile is False
    assert spec.llm_timeout == 12.0
    assert spec.llm_max_retries == 0
    assert spec.llm_max_tokens == 3000
    assert spec.llm_context_length == 8192
    assert spec.llm_reasoning_mode == "off"
    assert "--- OUTPUT DEPTH GUIDANCE ---" in spec.invoke_payload["local_depth_section"]
    assert "Keep simple requests direct and shorter." in spec.invoke_payload["local_depth_section"]
    assert "Use sections only when they materially improve the result or when the user is clearly asking for a system or agent prompt." in spec.invoke_payload["local_depth_section"]
    assert "The transcript asks for substantial detail." not in spec.invoke_payload["local_depth_section"]


def test_supervisor_uses_slim_context_for_ai_chat_prompt_skill(monkeypatch):
    _mock_loaded_lmstudio_model(
        monkeypatch,
        model_id="qwen2.5-7b-instruct",
        context_length=8192,
    )
    agent = SupervisorAgent(provider="lmstudio", model="qwen2.5-7b-instruct", temperature=0.0)

    spec = agent._build_prompt_spec(
        "do deep research on this YouTube transcript and pull out the main claims",
        {
            "app_name": "Microsoft Edge",
            "bundle_id": "com.microsoft.edgemac",
            "window_title": "Google Gemini - Microsoft Edge",
            "page_title": "Google Gemini",
            "url_host": "gemini.google.com",
            "context_quality": "app_only",
            "target_type": "generic",
            "surface_kind": "generic",
        },
        DefaultSkills.AI_CHAT_PROMPT,
    )

    assert spec.llm_max_tokens == 3000
    assert spec.llm_context_length == 8192
    assert "Bundle ID:" not in spec.invoke_payload["context_block"]
    assert "Window Title:" not in spec.invoke_payload["context_block"]
    assert "Context Quality:" not in spec.invoke_payload["context_block"]
    assert "Site Host: gemini.google.com" in spec.invoke_payload["context_block"]
    assert "Output Mode: plain_text" in spec.invoke_payload["contract_block"]
    assert "Skill Name:" not in spec.invoke_payload["contract_block"]
    assert spec.invoke_payload["tone_section"] == ""
    assert "The transcript asks for substantial detail." in spec.invoke_payload["local_depth_section"]
    assert "Goal, Context, Inputs/Reference Material, Constraints, Deliverables, Output Format, Verification, and Risks/Open Questions." in spec.invoke_payload["local_depth_section"]


def test_supervisor_allocates_larger_local_budget_for_coding_agent_prompt_skills(monkeypatch):
    _mock_loaded_lmstudio_model(
        monkeypatch,
        model_id="qwen2.5-7b-instruct",
        context_length=8192,
    )
    agent = SupervisorAgent(provider="lmstudio", model="qwen2.5-7b-instruct", temperature=0.0)

    spec = agent._build_prompt_spec(
        "update the auth flow, keep tests green, and explain the migration risk",
        {
            "app_name": "Codex",
            "window_title": "repo",
            "target_type": "ide",
        },
        DefaultSkills.CODEX_PROMPT,
    )

    assert spec.llm_max_tokens == 3000
    assert spec.llm_context_length == 8192
    assert "Keep the primary requested outcome first" in spec.invoke_payload["local_depth_section"]


def test_supervisor_strips_thinking_blocks_from_local_model_output():
    agent = SupervisorAgent(provider="lmstudio", model="qwen2.5-7b-instruct", temperature=0.0)

    cleaned = agent._normalize_model_output("<think>private reasoning</think>\n\nFinal answer only.")

    assert cleaned == "Final answer only."


def test_supervisor_labels_inline_and_screen_source_material_for_local_models(monkeypatch):
    _mock_loaded_lmstudio_model(
        monkeypatch,
        model_id="nvidia/nemotron-3-nano-4b",
        context_length=8192,
    )
    agent = SupervisorAgent(provider="lmstudio", model="nvidia/nemotron-3-nano-4b", temperature=0.0)

    inline_spec = agent._build_prompt_spec(
        "make this sound more professional",
        {
            "app_name": "Slack",
            "target_type": "chat",
            "external_text": "we can ship tomorrow morning",
            "external_text_source": "transcript_inline",
        },
        DefaultSkills.SYSTEM_REWRITE,
    )
    screen_spec = agent._build_prompt_spec(
        "Summarize this screen.",
        {
            "app_name": "Google Chrome",
            "target_type": "browser_doc",
            "external_text": "Dashboard shows delayed shipments and three overdue items.",
            "external_text_source": "screen_context",
            "screen_context": "Dashboard shows delayed shipments and three overdue items.",
        },
        DefaultSkills.DICTATION,
    )

    assert "Source text to transform (spoken source text):" in inline_spec.invoke_payload["source_material_block"]
    assert "The user spoke the following source text within the command:" in inline_spec.invoke_payload["instructions_block"]
    assert "Source text to transform (screen context):" in screen_spec.invoke_payload["source_material_block"]


def test_supervisor_does_not_inject_passive_clipboard_text_into_local_prompt(monkeypatch):
    _mock_loaded_lmstudio_model(
        monkeypatch,
        model_id="nvidia/nemotron-3-nano-4b",
        context_length=8192,
    )
    agent = SupervisorAgent(provider="lmstudio", model="nvidia/nemotron-3-nano-4b", temperature=0.0)

    spec = agent._build_prompt_spec(
        "write this LinkedIn post in a cleaner way",
        {
            "app_name": "Microsoft Edge",
            "window_title": "LinkedIn",
            "target_type": "generic",
            "clipboard_text": "stale clipboard draft that should not be used",
        },
        DefaultSkills.SYSTEM_REWRITE,
    )

    assert "clipboard" not in spec.invoke_payload["instructions_block"].lower()
    assert "stale clipboard draft" not in spec.invoke_payload["instructions_block"]
    assert "clipboard_text" not in spec.context_fields_sent


def test_supervisor_keeps_full_prompt_profile_for_non_local_models():
    agent = SupervisorAgent(provider="groq", model="llama3-70b-8192", temperature=0.0)

    spec = agent._build_prompt_spec(
        "rewrite this update",
        {
            "app_name": "Gmail",
            "window_title": "Compose",
            "target_type": "generic",
            "surface_kind": "email_body",
        },
        DefaultSkills.SYSTEM_REWRITE,
    )

    assert spec.compact_profile is False
    assert spec.llm_temperature == 0.0
    assert spec.llm_timeout == 18.0
    assert spec.llm_max_retries == 0
    assert spec.human_template.startswith("Raw STT Transcript")


def test_supervisor_allocates_larger_remote_timeout_for_prompt_heavy_skills():
    agent = SupervisorAgent(provider="nvidia", model="moonshotai/kimi-k2.5", temperature=0.0)

    spec = agent._build_prompt_spec(
        "create a coding agent prompt that updates auth, keeps tests green, and documents rollout risk",
        {
            "app_name": "Codex",
            "window_title": "repo",
            "target_type": "ide",
        },
        DefaultSkills.CODEX_PROMPT,
    )

    assert spec.compact_profile is False
    assert spec.llm_timeout == 24.0
    assert spec.llm_max_retries == 0


def test_supervisor_includes_memory_context_when_present():
    agent = SupervisorAgent(provider="groq", model="llama3-70b-8192", temperature=0.0)

    spec = agent._build_prompt_spec(
        "draft the weekly update",
        {
            "app_name": "Slack",
            "target_type": "chat",
            "memory_context_block": "Use these stable local user preferences and recurring facts only when they are directly relevant:\n- Writing preference: keep status updates concise.\n- Project: Atlas.",
        },
        DefaultSkills.SYSTEM_REWRITE,
    )

    assert spec.compact_profile is False
    assert "memory_context" in spec.context_fields_sent
    assert "--- RELEVANT LOCAL MEMORY ---" in spec.invoke_payload["memory_section"]
    assert "Writing preference: keep status updates concise." in spec.invoke_payload["memory_section"]


def test_supervisor_surfaces_lmstudio_runtime_errors(monkeypatch):
    _mock_loaded_lmstudio_model(
        monkeypatch,
        model_id="missing-model",
        context_length=8192,
    )

    def raise_runtime_error(_input):
        raise RuntimeError("The selected LM Studio model 'missing-model' is not available. Choose a downloaded local model in Settings and try again.")

    monkeypatch.setattr(
        "agent.supervisor.LLMFactory.get_llm",
        lambda *args, **kwargs: RunnableLambda(raise_runtime_error),
    )

    agent = SupervisorAgent(provider="lmstudio", model="missing-model", temperature=0.0)
    response = agent.process_transcript(
        "make this sound polite",
        {
            "app_name": "Slack",
            "window_title": "eng-updates",
            "target_type": "chat",
        },
        DefaultSkills.SYSTEM_REWRITE,
    )

    assert response.text is None
    assert response.error == "The selected LM Studio model 'missing-model' is not available. Choose a downloaded local model in Settings and try again."


def test_supervisor_streams_preview_updates_from_lmstudio_when_supported(monkeypatch):
    _mock_loaded_lmstudio_model(
        monkeypatch,
        model_id="nvidia/nemotron-3-nano-4b",
        context_length=8192,
    )
    preview_updates: list[str] = []

    class FakeNativeClient:
        def stream(self, _prompt_input):
            yield {
                "event": "message.delta",
                "data": {"content": "Please ship this once "},
                "error_message": None,
            }
            yield {
                "event": "message.delta",
                "data": {"content": "QA has approved it."},
                "error_message": None,
            }
            yield {
                "event": "chat.end",
                "data": {
                    "result": {
                        "output": [
                            {"type": "message", "content": "Please ship this once QA has approved it."},
                        ],
                    },
                },
                "error_message": None,
            }

        def extract_output_text(self, payload):
            return payload["output"][0]["content"]

    runnable = RunnableLambda(lambda _input: None)
    setattr(runnable, "native_client", FakeNativeClient())
    monkeypatch.setattr(
        "agent.supervisor.LLMFactory.get_llm",
        lambda *args, **kwargs: runnable,
    )

    agent = SupervisorAgent(provider="lmstudio", model="nvidia/nemotron-3-nano-4b", temperature=0.0)
    response = agent.process_transcript(
        "make this sound polite",
        {
            "app_name": "Slack",
            "window_title": "eng-updates",
            "target_type": "chat",
            "external_text": "ship this after QA signs off",
            "external_text_source": "selection",
        },
        DefaultSkills.SYSTEM_REWRITE,
        preview_callback=preview_updates.append,
    )

    assert response.text == "Please ship this once QA has approved it."
    assert preview_updates == [
        "Please ship this once",
        "Please ship this once QA has approved it.",
    ]


def test_supervisor_emits_single_preview_update_for_non_streaming_providers(monkeypatch):
    preview_updates: list[str] = []

    def return_message(_input):
        class Response:
            content = "Please ship this once QA has approved it."

        return Response()

    monkeypatch.setattr(
        "agent.supervisor.LLMFactory.get_llm",
        lambda *args, **kwargs: RunnableLambda(return_message),
    )

    agent = SupervisorAgent(provider="groq", model="llama3-70b-8192", temperature=0.0)
    response = agent.process_transcript(
        "make this sound polite",
        {
            "app_name": "Slack",
            "window_title": "eng-updates",
            "target_type": "chat",
        },
        DefaultSkills.SYSTEM_REWRITE,
        preview_callback=preview_updates.append,
    )

    assert response.text == "Please ship this once QA has approved it."
    assert preview_updates == ["Please ship this once QA has approved it."]
