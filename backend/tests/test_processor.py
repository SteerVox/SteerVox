from action_execution import ActionBuildResult, ActionResolutionError, PendingActionReview
from agent.processor import SmartModeProcessor
from agent.skills.defaults import DefaultSkills
from agent.skills.manager import SkillManager
from agent.supervisor import SupervisorResponse
from agent.smart_router_agent import SmartRouterAgentResult
from agent.smart_models import RoutingDecision, SkillReference, SmartIntent, SmartLane


class FakeSupervisorAgent:
    def __init__(self, text: str | None, *, error: str | None = None, preview_text: str | None = None):
        self.text = text
        self.error = error
        self.preview_text = preview_text
        self.calls = 0
        self.last_context = None
        self.last_transcript = None

    def process_transcript(self, raw_transcript, os_context, skill, *, preview_callback=None):
        self.calls += 1
        self.last_transcript = raw_transcript
        self.last_context = dict(os_context)
        if preview_callback and self.preview_text:
            preview_callback(self.preview_text)
        return SupervisorResponse(
            text=self.text,
            context_fields_sent=["app_name", "window_title", "target_type"],
            payload_estimated_bytes=321,
            latency_ms=44,
            error=self.error,
        )


class FakeSmartRouterAgent:
    def __init__(
        self,
        result: SmartRouterAgentResult | None = None,
        *,
        error: str | None = None,
        provider: str = "groq",
        model: str = "groq/compound-mini",
    ):
        self.result = result
        self.error = error
        self.calls = 0
        self.provider = provider
        self.model = model
        self.last_kwargs = None

    def resolve(self, **kwargs):
        self.calls += 1
        self.last_kwargs = dict(kwargs)
        return self.result, self.error


def test_processor_applies_raw_dictation_fallback_without_hitting_llm():
    skill_manager = SkillManager()
    skill_manager.add_custom_skill({
        "id": "chat_only",
        "name": "Chat Only",
        "prompt": "Reply like a teammate.",
        "target_types": ["chat"],
        "fallback_behavior": "raw_dictation",
    })
    fake_agent = FakeSupervisorAgent("should not be used")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        skill_manager=skill_manager,
        agent=fake_agent,
    )

    result = processor.process(
        "need to send this later",
        {
            "app_name": "Cursor",
            "window_title": "notes.md",
            "context_quality": "app_only",
            "target_type": "ide",
        },
        "chat_only",
    )

    assert result.intent == SmartIntent.RAW_DICTATION
    assert result.lane == SmartLane.PASSTHROUGH
    assert result.fallback_applied is True
    assert result.skill_used.id == "raw_dictation"
    assert result.final_text == "need to send this later"
    assert fake_agent.calls == 0


def test_processor_enforces_skill_max_chars_for_plain_text_outputs():
    skill_manager = SkillManager()
    skill_manager.add_custom_skill({
        "id": "chat_short",
        "name": "Short Chat",
        "prompt": "Keep it concise.",
        "target_types": ["chat"],
        "max_chars": 20,
    })
    fake_agent = FakeSupervisorAgent("This reply is definitely longer than twenty characters.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        skill_manager=skill_manager,
        agent=fake_agent,
    )

    result = processor.process(
        "can you make this short",
        {
            "app_name": "Slack",
            "window_title": "eng",
            "context_quality": "full",
            "target_type": "chat",
        },
        "chat_short",
    )

    assert result.lane == SmartLane.LLM
    assert fake_agent.calls == 1
    assert len(result.final_text) <= 20
    assert result.final_text.endswith("...")
    assert result.telemetry.external_request_made is True
    assert result.telemetry.payload_estimated_bytes == 321


def test_processor_keeps_prompt_heavy_outputs_above_old_codex_cap():
    skill_manager = SkillManager()
    fake_agent = FakeSupervisorAgent("Detailed migration brief. " * 80)
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        skill_manager=skill_manager,
        agent=fake_agent,
    )

    result = processor.process(
        "perform deep research on the auth migration, compare rollout options, and include verification steps",
        {
            "app_name": "Codex",
            "window_title": "repo",
            "context_quality": "full",
            "target_type": "ide",
        },
        DefaultSkills.CODEX_PROMPT.id,
    )

    assert result.lane == SmartLane.LLM
    assert fake_agent.calls == 1
    assert len(result.final_text) == len(fake_agent.text)
    assert len(result.final_text) > 1000


def test_processor_records_requested_skill_override_provenance():
    skill_manager = SkillManager()
    skill_manager.add_custom_skill({
        "id": "slack_reply",
        "name": "Slack Reply",
        "prompt": "Reply like a teammate.",
        "target_types": ["chat"],
    })
    fake_agent = FakeSupervisorAgent("Looks good to me.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        skill_manager=skill_manager,
        agent=fake_agent,
    )

    result = processor.process(
        "ship it today",
        {
            "app_name": "Slack",
            "window_title": "eng-updates",
            "context_quality": "full",
            "target_type": "chat",
        },
        "slack_reply",
        requested_skill_source="app_override",
        requested_app_override_id="slack_rule",
        requested_app_override_label="Slack",
    )

    assert result.telemetry.requested_skill_source == "app_override"
    assert result.telemetry.requested_app_override_id == "slack_rule"
    assert result.telemetry.requested_app_override_label == "Slack"


def test_processor_preserves_requested_skill_when_auto_routing_uses_a_different_skill():
    fake_agent = FakeSupervisorAgent("We shipped offline transcription and learned a lot about fallback design.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "we shipped offline transcription and learned a lot about fallback design",
        {
            "app_name": "Google Chrome",
            "window_title": "LinkedIn",
            "context_quality": "full",
            "target_type": "social_post",
        },
        "system_dictation",
        resolved_skill_id="system_social_post",
        skill_router_resolver="local",
        auto_selected_skill_id="system_social_post",
        auto_selected_skill_name="Social / Professional Post",
        auto_selected_skill_reason="Social post context matched the current writing surface.",
    )

    assert result.requested_skill.id == "system_dictation"
    assert result.skill_used.id == "system_social_post"
    assert result.telemetry.auto_selected_skill_id == "system_social_post"
    assert result.telemetry.skill_router_resolver == "local"


def test_processor_builds_local_task_request_for_explicit_local_task_skill():
    fake_agent = FakeSupervisorAgent("should not be used")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="local-model",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "run git status",
        {
            "app_name": "Cursor",
            "window_title": "repo",
            "context_quality": "full",
            "target_type": "ide",
        },
        DefaultSkills.LOCAL_TASK.id,
    )

    assert result.intent == SmartIntent.LOCAL_TASK
    assert result.local_task_request is not None
    assert result.local_task_request.command == "git status"
    assert result.local_task_request.source_intent == "local_task"
    assert result.final_text == ""
    assert fake_agent.calls == 0


def test_processor_builds_local_task_request_for_computer_use_repo_search():
    fake_agent = FakeSupervisorAgent("should not be used")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="local-model",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "search the repo for LocalTaskShellService",
        {
            "app_name": "Cloud Code",
            "window_title": "repo",
            "context_quality": "full",
            "target_type": "ide",
            "workspace_root": "/tmp/steervox",
        },
        DefaultSkills.CLOUD_CODE_PROMPT.id,
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.local_task_request is not None
    assert result.local_task_request.command == "rg -n -- LocalTaskShellService ."
    assert result.local_task_request.source_intent == "computer_use"
    assert result.telemetry.computer_use_trigger == "action_phrase"
    assert result.telemetry.computer_use_plan_kind == "local_task"
    assert fake_agent.calls == 0


def test_processor_uses_selection_text_for_computer_use_file_search():
    fake_agent = FakeSupervisorAgent("should not be used")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="local-model",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "browse through the file and find me this",
        {
            "app_name": "Cursor",
            "window_title": "parser.ts",
            "context_quality": "full",
            "target_type": "ide",
            "code_file_name": "parser.ts",
        },
        DefaultSkills.DICTATION.id,
        selection_text="LocalTaskShellService",
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.local_task_request is not None
    assert result.local_task_request.command == "rg -n -- LocalTaskShellService parser.ts"
    assert result.local_task_request.source_intent == "computer_use"
    assert result.telemetry.computer_use_plan_kind == "local_task"


def test_processor_builds_multi_step_local_task_request_for_computer_use(monkeypatch):
    fake_agent = FakeSupervisorAgent("should not be used")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="local-model",
        temperature=0.0,
        agent=fake_agent,
    )

    monkeypatch.setattr(
        processor.reviewed_action_builder,
        "build",
        lambda **_kwargs: ActionBuildResult(
            pending_review=PendingActionReview(
                run_id="desktop-review-1",
                action_type="open_app",
                title="Open Finder",
                summary="Open Finder.",
                script='tell application id "com.apple.finder"\nreopen\nactivate\nend tell',
            )
        ),
    )

    result = processor.process(
        "open Finder and search the repo for LocalTaskShellService",
        {
            "app_name": "Cursor",
            "window_title": "repo",
            "context_quality": "full",
            "target_type": "ide",
        },
        DefaultSkills.COMPUTER_USE.id,
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.local_task_request is not None
    assert result.local_task_request.run_kind == "multi_step"
    assert result.local_task_request.source_intent == "computer_use"
    assert result.local_task_request.command is None
    assert len(result.local_task_request.steps) == 2
    assert result.local_task_request.steps[0].kind == "desktop_action"
    assert result.local_task_request.steps[0].script is not None
    assert result.local_task_request.steps[1].kind == "shell_command"
    assert result.local_task_request.steps[1].command == "rg -n -- LocalTaskShellService ."
    assert result.telemetry.computer_use_plan_kind == "multi_step"
    assert fake_agent.calls == 0


def test_processor_builds_bounded_youtube_browser_plan_for_computer_use(monkeypatch):
    fake_agent = FakeSupervisorAgent("should not be used")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="local-model",
        temperature=0.0,
        agent=fake_agent,
    )
    monkeypatch.setattr(
        processor.reviewed_action_builder,
        "build_planned_step",
        lambda planned_step, **_kwargs: ActionBuildResult(
            pending_review=PendingActionReview(
                run_id=f"review-{planned_step.action_type}",
                action_type=planned_step.action_type,
                title=planned_step.title,
                summary=planned_step.summary,
                script=f"-- {planned_step.action_type}",
            )
        ),
    )

    result = processor.process(
        "open Chrome and play indie songs on YouTube",
        {
            "app_name": "Codex",
            "window_title": "repo",
            "context_quality": "full",
            "target_type": "ide",
        },
        DefaultSkills.DICTATION.id,
        resolved_skill_id=DefaultSkills.CODEX_PROMPT.id,
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.local_task_request is not None
    assert result.local_task_request.run_kind == "multi_step"
    assert len(result.local_task_request.steps) == 4
    assert result.local_task_request.steps[0].action_type == "open_app"
    assert result.local_task_request.steps[1].action_type == "open_url"
    assert result.local_task_request.steps[2].action_type == "youtube_open_first_result"
    assert result.local_task_request.steps[3].action_type == "youtube_ensure_playing"
    assert result.action_error is None
    assert result.telemetry.computer_use_plan_kind == "multi_step"
    assert fake_agent.calls == 0


def test_processor_uses_smart_router_for_ambiguous_llm_routes():
    fake_agent = FakeSupervisorAgent("def parse_payload(data):\n    return data.strip()\n")
    fake_router_agent = FakeSmartRouterAgent(
        SmartRouterAgentResult(
            intent=SmartIntent.CODE_REFACTOR,
            lane=SmartLane.LLM,
            confidence=0.91,
            reason="Code editor context and cleanup phrasing fit the refactor route better than a generic code snippet route.",
            latency_ms=28,
        )
    )
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
        smart_router_agent=fake_router_agent,
    )

    result = processor.process(
        "clean this up",
        {
            "app_name": "Cursor",
            "window_title": "parser.ts",
            "context_quality": "full",
            "target_type": "ide",
        },
        "system_dictation",
    )

    assert fake_router_agent.calls == 1
    assert result.intent == SmartIntent.CODE_REFACTOR
    assert result.lane == SmartLane.LLM
    assert result.telemetry.planner_resolver == "model"
    assert result.telemetry.planner_model_attempted is True
    assert result.telemetry.planner_model_error is None


def test_processor_passes_runtime_skill_catalog_to_smart_router():
    skill_manager = SkillManager()
    skill_manager.add_custom_skill({
        "id": "custom_generic",
        "name": "Generic Rewriter",
        "prompt": "Rewrite with clarity.",
    })
    fake_agent = FakeSupervisorAgent("Looks cleaner now.")
    fake_router_agent = FakeSmartRouterAgent(
        SmartRouterAgentResult(
            intent=SmartIntent.GENERIC,
            lane=SmartLane.LLM,
            confidence=0.89,
            reason="Generic rewrite request.",
            latency_ms=12,
        )
    )
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        skill_manager=skill_manager,
        agent=fake_agent,
        smart_router_agent=fake_router_agent,
    )

    processor.process(
        "Need a better structure for this paragraph before we send it",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        "custom_generic",
    )

    catalog = fake_router_agent.last_kwargs["available_skills"]
    assert any(skill["id"] == "custom_generic" for skill in catalog)


def test_processor_falls_back_to_local_route_when_smart_router_errors():
    skill_manager = SkillManager()
    skill_manager.add_custom_skill({
        "id": "custom_generic",
        "name": "Generic Rewriter",
        "prompt": "Rewrite with clarity.",
    })
    fake_agent = FakeSupervisorAgent("Looks cleaner now.")
    fake_router_agent = FakeSmartRouterAgent(error="Smart router model invocation failed.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        skill_manager=skill_manager,
        agent=fake_agent,
        smart_router_agent=fake_router_agent,
    )

    result = processor.process(
        "Need a better structure for this paragraph before we send it",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        "custom_generic",
    )

    assert fake_router_agent.calls == 1
    assert result.intent == SmartIntent.GENERIC
    assert result.lane == SmartLane.LLM
    assert result.telemetry.planner_resolver == "local"
    assert result.telemetry.planner_model_attempted is True
    assert result.telemetry.planner_model_error == "Smart router model invocation failed."


def test_processor_skips_smart_router_for_strong_local_routes():
    fake_agent = FakeSupervisorAgent("Texto traducido.")
    fake_router_agent = FakeSmartRouterAgent(
        SmartRouterAgentResult(
            intent=SmartIntent.GENERIC,
            lane=SmartLane.LLM,
            confidence=0.6,
            reason="Should not be used.",
            latency_ms=10,
        )
    )
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
        smart_router_agent=fake_router_agent,
    )

    result = processor.process(
        "translate this to spanish thanks for the quick update",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        "system_dictation",
    )

    assert fake_router_agent.calls == 0
    assert result.intent == SmartIntent.TRANSLATE
    assert result.telemetry.planner_resolver == "local"
    assert result.telemetry.planner_model_attempted is False


def test_processor_keeps_smart_mode_fully_local_for_lmstudio():
    fake_agent = FakeSupervisorAgent("Selected text made polite.")
    fake_router_agent = FakeSmartRouterAgent(
        SmartRouterAgentResult(
            intent=SmartIntent.GENERIC,
            lane=SmartLane.LLM,
            confidence=0.95,
            reason="Should not run for LM Studio.",
            latency_ms=8,
        )
    )
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.3,
        agent=fake_agent,
        smart_router_agent=fake_router_agent,
    )

    result = processor.process(
        "make this sound polite",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_grammar",
        selection_text="ship this after qa signs off",
        force_external_context=True,
    )

    assert fake_router_agent.calls == 0
    assert fake_agent.calls == 1
    assert fake_agent.last_context["external_text"] == "ship this after qa signs off"
    assert result.lane == SmartLane.LLM
    assert result.telemetry.planner_resolver == "local"
    assert result.telemetry.planner_model_attempted is False


def test_processor_skips_local_smart_router_for_lmstudio_even_when_configured():
    fake_agent = FakeSupervisorAgent("Selected text made polite.")
    fake_router_agent = FakeSmartRouterAgent(
        SmartRouterAgentResult(
            intent=SmartIntent.GENERIC,
            lane=SmartLane.LLM,
            confidence=0.89,
            reason="Local router refined the ambiguous request.",
            latency_ms=8,
        ),
        provider="lmstudio",
        model="qwen2.5-7b-instruct",
    )
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.3,
        agent=fake_agent,
        smart_router_agent=fake_router_agent,
    )

    result = processor.process(
        "Need a better structure for this paragraph before we send it",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_dictation",
    )

    assert fake_router_agent.calls == 0
    assert result.intent == SmartIntent.LOCAL_UNSUPPORTED
    assert result.lane == SmartLane.REFUSED
    assert result.telemetry.planner_model_attempted is False


def test_processor_falls_back_to_safe_local_cleanup_when_lmstudio_returns_empty_output():
    fake_agent = FakeSupervisorAgent("")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.3,
        agent=fake_agent,
    )

    result = processor.process(
        "make this sound polite",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_grammar",
        selection_text="ship this after qa signs off",
        force_external_context=True,
    )

    assert result.final_text == "Ship this after qa signs off."
    assert result.fallback_applied is True
    assert "local_empty_output_fallback" in result.deterministic_operations


def test_processor_normalizes_compact_local_labeled_segments_into_bullets():
    fake_agent = FakeSupervisorAgent(
        "Update: add comprehensive test coverage verification; update: modify all docs in docs/ with latest info; verify: ensure all functionalities are tested and docs are current."
    )
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.3,
        agent=fake_agent,
    )

    result = processor.process(
        "make this sound more organized",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "full",
            "target_type": "generic",
            "surface_kind": "document_body",
        },
        "system_grammar",
        selection_text="placeholder content",
        force_external_context=True,
    )

    assert result.final_text == "\n".join([
        "- Update: Add comprehensive test coverage verification",
        "- Update: Modify all docs in docs/ with latest info",
        "- Verify: Ensure all functionalities are tested and docs are current",
    ])
    assert "normalize_local_labeled_segments" in result.deterministic_operations


def test_processor_bypasses_local_compact_for_medical_domain_note_generation():
    fake_agent = FakeSupervisorAgent(
        "HPI: Patient reports left-sided toothache for two months with intermittent clicking and popping sounds; denies other dental symptoms, decay, or recent tooth-related issues. Assessment details: pain duration noted, no visible decay or inspection findings. Follow-up: clinical review of clicking mechanism discussed."
    )
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="google/medgemma-4b-it",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "draft the clinical summary",
        {
            "app_name": "Epic",
            "window_title": "Patient chart",
            "context_quality": "full",
            "target_type": "generic",
            "surface_kind": "document_body",
        },
        "system_domain_structured_note",
        domain_id="medical",
    )

    assert result.intent == SmartIntent.GENERIC
    assert result.lane == SmartLane.LLM
    assert fake_agent.calls == 1
    assert result.final_text == "\n\n".join([
        "HPI: Patient reports left-sided toothache for two months with intermittent clicking and popping sounds; denies other dental symptoms, decay, or recent tooth-related issues.",
        "Assessment details: pain duration noted, no visible decay or inspection findings.",
        "Follow-up: clinical review of clicking mechanism discussed.",
    ])
    assert result.telemetry.smart_profile == "default"
    assert "local_compact_contract_id" not in (fake_agent.last_context or {})


def test_processor_bypasses_local_compact_for_domain_email_generation():
    fake_agent = FakeSupervisorAgent("Subject: Shift handover update\n\nDear Team,\nContainer ETA moved to tomorrow.\n\nBest regards,")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "draft a handover update",
        {
            "app_name": "Gmail",
            "window_title": "Compose",
            "context_quality": "full",
            "target_type": "generic",
            "surface_kind": "email_body",
        },
        "system_domain_email",
        domain_id="shipping",
        domain_skill_id="system_domain_email",
    )

    assert result.lane == SmartLane.LLM
    assert fake_agent.calls == 1
    assert result.final_text == fake_agent.text
    assert result.telemetry.smart_profile == "default"
    assert "local_compact_contract_id" not in (fake_agent.last_context or {})


def test_processor_forwards_stream_preview_updates_to_the_supervisor_agent():
    preview_updates: list[str] = []
    fake_agent = FakeSupervisorAgent(
        "Please ship this once QA has approved it.",
        preview_text="Please ship this once QA",
    )
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="nvidia/nemotron-3-nano-4b",
        temperature=0.3,
        agent=fake_agent,
    )

    result = processor.process(
        "make this sound polite",
        {
            "app_name": "Slack",
            "window_title": "eng-updates",
            "context_quality": "full",
            "target_type": "chat",
        },
        "system_grammar",
        selection_text="ship this after qa signs off",
        force_external_context=True,
        preview_callback=preview_updates.append,
    )

    assert result.final_text == "Please ship this once QA has approved it."
    assert preview_updates == ["Please ship this once QA"]


def test_processor_records_system_rule_provenance():
    fake_agent = FakeSupervisorAgent("Use these instructions.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "write a system prompt for this API response",
        {
            "app_name": "Google Chrome",
            "window_title": "Claude",
            "url_host": "claude.ai",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_prompt_architect",
        requested_skill_source="system_rule",
        requested_app_override_id="prompt_claude",
        requested_app_override_label="Claude",
    )

    assert result.telemetry.requested_skill_source == "system_rule"
    assert result.telemetry.requested_app_override_id == "prompt_claude"
    assert result.telemetry.requested_app_override_label == "Claude"


def test_processor_records_domain_forced_skill_telemetry():
    fake_agent = FakeSupervisorAgent("Structured handoff note.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "write a shift handoff update for the warehouse team",
        {
            "app_name": "Google Chrome",
            "window_title": "project44",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_domain_structured_note",
        requested_skill_source="domain_forced",
        domain_skill_id="system_domain_structured_note",
        note_routing_suppressed=True,
        suppressed_requested_skill_source="app_override",
        suppressed_requested_app_override_id="shipping_host",
        suppressed_requested_app_override_label="Shipping Portal",
    )

    assert result.telemetry.requested_skill_source == "domain_forced"
    assert result.telemetry.domain_skill_id == "system_domain_structured_note"
    assert result.telemetry.note_routing_suppressed is True
    assert result.telemetry.suppressed_requested_skill_source == "app_override"
    assert result.telemetry.suppressed_requested_app_override_id == "shipping_host"


def test_processor_collapses_full_email_output_for_subject_line_surface():
    fake_agent = FakeSupervisorAgent("Subject: Shift handover update\n\nDear Team,\nContainer ETA moved to tomorrow.\n\nBest regards,")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "draft a handover update",
        {
            "app_name": "Google Chrome",
            "window_title": "Gmail",
            "context_quality": "full",
            "target_type": "generic",
            "surface_kind": "email_subject",
        },
        "system_domain_email",
    )

    assert result.final_text == "Shift handover update"
    assert result.telemetry.surface_kind == "email_subject"


def test_processor_prefers_selection_for_referential_llm_commands():
    fake_agent = FakeSupervisorAgent("Texto traducido.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "translate this into spanish",
        {
            "app_name": "Google Chrome",
            "window_title": "Gmail",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_translate",
        selection_text="Selected paragraph to translate.",
        selection_truncated=False,
        clipboard_text="Please review the attached timeline.",
        clipboard_truncated=True,
    )

    assert result.lane == SmartLane.LLM
    assert fake_agent.last_context["external_text"] == "Selected paragraph to translate."
    assert fake_agent.last_context["external_text_source"] == "selection"
    assert result.telemetry.selection_available is True
    assert result.telemetry.selection_used is True
    assert result.telemetry.external_context_source == "selection"
    assert result.telemetry.clipboard_available is True
    assert result.telemetry.clipboard_used is False
    assert result.telemetry.clipboard_truncated is True


def test_processor_does_not_use_clipboard_without_referential_command():
    fake_agent = FakeSupervisorAgent("Looks good.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "translate into spanish",
        {
            "app_name": "Google Chrome",
            "window_title": "Gmail",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_translate",
        clipboard_text="Please review the attached timeline.",
        clipboard_truncated=False,
    )

    assert result.lane == SmartLane.LLM
    assert "external_text" not in (fake_agent.last_context or {})
    assert result.telemetry.clipboard_available is True
    assert result.telemetry.clipboard_used is False


def test_processor_promotes_cleanup_to_llm_when_external_text_is_required():
    fake_agent = FakeSupervisorAgent("Cleaned external paragraph.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "clean this up",
        {
            "app_name": "Google Chrome",
            "window_title": "Docs",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_grammar",
        selection_text="messy selected paragraph",
        force_external_context=True,
        action_route="transform_then_save_note",
        action_resolver="local",
    )

    assert result.lane == SmartLane.LLM
    assert fake_agent.calls == 1
    assert fake_agent.last_context["external_text"] == "messy selected paragraph"
    assert result.telemetry.action_route == "transform_then_save_note"
    assert result.telemetry.action_resolver == "local"


def test_processor_uses_external_text_for_prompt_crafting_intent():
    fake_agent = FakeSupervisorAgent("Structured prompt")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "write a system prompt for this json format",
        {
            "app_name": "Google Chrome",
            "window_title": "ChatGPT",
            "url_host": "chatgpt.com",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_prompt_architect",
        selection_text='{"status":"ok","items":[1,2,3]}',
    )

    assert result.intent == SmartIntent.PROMPT_CRAFTING
    assert result.lane == SmartLane.LLM
    assert fake_agent.last_context["external_text"] == '{"status":"ok","items":[1,2,3]}'
    assert result.telemetry.selection_used is True


def test_processor_prioritizes_explicit_actions_over_prompt_site_skill(monkeypatch):
    fake_agent = FakeSupervisorAgent("This should not be used.")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    monkeypatch.setattr(
        processor.reviewed_action_builder,
        "build",
        lambda **_kwargs: type(
            "BuiltAction",
            (),
            {
                "pending_review": None,
                "auto_action": type(
                    "AutoAction",
                    (),
                    {"model_dump": lambda self, mode="json": {
                        "action_type": "focus_field",
                        "title": "Focus Field",
                        "summary": "Focus Message in Google Chrome.",
                        "app_name": "Google Chrome",
                        "bundle_id": "com.google.Chrome",
                        "target_label": "Message",
                        "target_role": "AXTextArea",
                        "ui_index": 9,
                    }},
                )(),
            },
        )(),
    )

    result = processor.process(
        "focus the chat input box",
        {
            "app_name": "Google Chrome",
            "window_title": "ChatGPT",
            "url_host": "chatgpt.com",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_prompt_architect",
        requested_skill_source="system_rule",
        requested_app_override_id="prompt_chatgpt",
        requested_app_override_label="ChatGPT",
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.auto_action is not None
    assert result.auto_action.action_type == "focus_field"
    assert result.telemetry.computer_use_trigger == "action_phrase"
    assert result.telemetry.computer_use_plan_kind == "desktop_action"
    assert result.final_text == ""
    assert fake_agent.calls == 0


def test_processor_falls_back_to_cleaned_transcript_when_llm_returns_low_signal_output():
    fake_agent = FakeSupervisorAgent(".")
    skill_manager = SkillManager()
    skill_manager.add_custom_skill({
        "id": "generic_rewrite",
        "name": "Generic Rewrite",
        "prompt": "Rewrite for clarity.",
    })
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
        skill_manager=skill_manager,
    )

    result = processor.process(
        "Need a better structure for this paragraph before we send it",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        "generic_rewrite",
    )

    assert result.lane == SmartLane.LLM
    assert result.final_text == "Need a better structure for this paragraph before we send it."
    assert result.fallback_applied is True
    assert "too little usable text" in (result.fallback_reason or "")


def test_processor_normalizes_literal_point_markers_for_bullet_skill_outputs():
    skill_manager = SkillManager()
    skill_manager.add_custom_skill({
        "id": "bullet_writer",
        "name": "Bullet Writer",
        "prompt": "Turn this into bullets.",
        "output_mode": "bullets",
    })
    fake_agent = FakeSupervisorAgent(
        "Point, Bangalore outgoing shipments are pending pick up\n"
        "Point, refurbookingmatch for blue peak account\n"
        "Point, refurbooking for Chennai needs carrier confirmation"
    )
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        skill_manager=skill_manager,
        agent=fake_agent,
    )

    result = processor.process(
        "make this a bulleted list for the shipping handover",
        {
            "app_name": "Google Chrome",
            "window_title": "project44",
            "context_quality": "full",
            "target_type": "generic",
        },
        "bullet_writer",
    )

    assert result.lane == SmartLane.LLM
    assert result.final_text.splitlines() == [
        "- Bangalore outgoing shipments are pending pick up",
        "- Refurbookingmatch for blue peak account",
        "- Refurbooking for Chennai needs carrier confirmation",
    ]
    assert "normalize_literal_bullet_markers" in result.deterministic_operations


def test_processor_routes_spoken_list_formatting_through_the_llm_in_smart_mode():
    fake_agent = FakeSupervisorAgent("- Ship routing\n- Add tests\n- Update docs")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "point one ship routing point two add tests point three update docs",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        "system_dictation",
    )

    assert result.intent == SmartIntent.BULLETIZE
    assert result.lane == SmartLane.LLM
    assert result.final_text.splitlines() == [
        "- Ship routing",
        "- Add tests",
        "- Update docs",
    ]
    assert fake_agent.calls == 1


def test_processor_does_not_fallback_to_local_bulletization_when_llm_returns_empty_output():
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=FakeSupervisorAgent(""),
    )

    result = processor.process(
        "point one ship routing point two add tests point three update docs",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        "system_dictation",
    )

    assert result.intent == SmartIntent.BULLETIZE
    assert result.lane == SmartLane.LLM
    assert result.final_text == "Point one ship routing point two add tests point three update docs."
    assert "\n" not in result.final_text
    assert not result.final_text.startswith("- ")
    assert "local_empty_output_fallback" in result.deterministic_operations


def test_processor_does_not_force_numbered_formatting_from_transcript_after_llm_output():
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=FakeSupervisorAgent("Ship routing and add tests."),
    )

    result = processor.process(
        "make this a numbered list number one ship routing number two add tests",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        "system_dictation",
    )

    assert result.intent == SmartIntent.BULLETIZE
    assert result.lane == SmartLane.LLM
    assert result.final_text == "Ship routing and add tests."


def test_processor_collapses_bullets_when_paragraph_is_explicitly_requested():
    fake_agent = FakeSupervisorAgent("- Bangalore outgoing shipments are pending pick up\n- Chennai needs carrier confirmation")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "turn this into a paragraph for the shipping handover",
        {
            "app_name": "Google Chrome",
            "window_title": "project44",
            "context_quality": "full",
            "target_type": "generic",
        },
        "system_domain_structured_note",
    )

    assert result.lane == SmartLane.LLM
    assert result.final_text == "Bangalore outgoing shipments are pending pick up Chennai needs carrier confirmation"
    assert "collapse_bullets_to_paragraph" in result.deterministic_operations


def test_processor_raises_when_supervisor_reports_llm_failure():
    fake_agent = FakeSupervisorAgent(None, error="Smart Mode could not initialize the selected language model.")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    try:
        processor.process(
            "rewrite this update",
            {
                "app_name": "Slack",
                "window_title": "eng-updates",
                "context_quality": "full",
                "target_type": "chat",
            },
            "system_grammar",
        )
        raise AssertionError("Expected SmartModeProcessor.process to raise on LLM failure.")
    except RuntimeError as exc:
        assert "could not initialize" in str(exc)


def test_processor_falls_back_to_cleaned_source_when_lmstudio_times_out():
    fake_agent = FakeSupervisorAgent(
        None,
        error="LM Studio local model timed out while generating output. Try a smaller model, reduce the prompt context, or try again.",
    )
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "make this sound more professional we can ship tomorrow morning",
        {
            "app_name": "Slack",
            "window_title": "eng-updates",
            "context_quality": "full",
            "target_type": "chat",
        },
        "system_grammar",
    )

    assert result.lane == SmartLane.LLM
    assert result.final_text == "We can ship tomorrow morning."
    assert result.fallback_applied is True
    assert result.fallback_reason is not None
    assert "timed out" in result.fallback_reason.lower()
    assert "local_timeout_fallback" in result.deterministic_operations


def test_processor_falls_back_to_cleaned_source_when_remote_provider_times_out():
    fake_agent = FakeSupervisorAgent(
        None,
        error="NVIDIA timed out while generating output. Smart Mode will fall back to safe local cleanup.",
    )
    processor = SmartModeProcessor(
        provider="nvidia",
        model="moonshotai/kimi-k2.5",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "make this sound more professional we can ship tomorrow morning",
        {
            "app_name": "Microsoft Edge",
            "window_title": "LinkedIn",
            "context_quality": "full",
            "target_type": "social_post",
        },
        "system_grammar",
    )

    assert result.lane == SmartLane.LLM
    assert result.final_text == "We can ship tomorrow morning."
    assert result.fallback_applied is True
    assert result.telemetry.llm_fallback_applied is True
    assert result.telemetry.llm_timeout_triggered is True
    assert result.telemetry.llm_fallback_reason is not None
    assert "remote_timeout_fallback" in result.deterministic_operations


def test_processor_records_command_and_surface_contract_telemetry():
    fake_agent = FakeSupervisorAgent("Subject: Shift handover update\nDear team")
    processor = SmartModeProcessor(
        provider="groq",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "make this a paragraph project update",
        {
            "app_name": "Mail",
            "window_title": "Compose",
            "context_quality": "full",
            "target_type": "generic",
            "surface_kind": "email_subject",
        },
        "system_domain_email",
        command_operations_applied=["new_paragraph"],
        format_contract="paragraph",
    )

    assert result.telemetry.command_operations_applied == ["new_paragraph"]
    assert result.telemetry.format_contract == "paragraph"
    assert result.telemetry.surface_contract_applied is True
    assert result.final_text == "Shift handover update"


def test_processor_returns_reviewed_action_payload_without_hitting_supervisor(monkeypatch):
    fake_agent = FakeSupervisorAgent("should not be used")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    monkeypatch_payload = {
        "pending_review": {
            "run_id": "review-1",
            "action_type": "open_url",
            "title": "Open URL",
            "summary": "Open https://example.com in the default browser.",
            "script": 'open location "https://example.com"',
            "language": "applescript",
            "status": "pending",
            "error": None,
        },
        "auto_action": None,
    }

    monkeypatch.setattr(
        processor.reviewed_action_builder,
        "build",
        lambda **_kwargs: type(
            "BuiltAction",
            (),
            {
                "pending_review": type("Review", (), {"model_dump": lambda self, mode="json": monkeypatch_payload["pending_review"]})(),
                "auto_action": None,
            },
        )(),
    )

    result = processor.process(
        "open example.com",
        {
            "app_name": "Safari",
            "window_title": "Start Page",
            "context_quality": "full",
            "target_type": "browser",
        },
        "system_dictation",
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.pending_action_review is not None
    assert result.pending_action_review.action_type == "open_url"
    assert result.auto_action is None
    assert result.final_text == ""
    assert result.telemetry.computer_use_trigger == "action_phrase"
    assert result.telemetry.computer_use_plan_kind == "desktop_action"
    assert result.telemetry.action_review_required is True
    assert result.telemetry.action_execution_mode == "reviewed"
    assert fake_agent.calls == 0


def test_processor_returns_auto_action_for_low_risk_ui_requests(monkeypatch):
    fake_agent = FakeSupervisorAgent(None)
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    monkeypatch.setattr(
        processor.reviewed_action_builder,
        "build",
        lambda **_kwargs: type(
            "BuiltAction",
            (),
            {
                "pending_review": None,
                "auto_action": type(
                    "AutoAction",
                    (),
                    {"model_dump": lambda self, mode="json": {
                        "action_type": "focus_field",
                        "title": "Focus Field",
                        "summary": "Focus Search in Slack.",
                        "app_name": "Slack",
                        "bundle_id": "com.tinyspeck.slackmacgap",
                        "target_label": "Search",
                        "target_role": "AXSearchField",
                        "ui_index": 3,
                    }},
                )(),
            },
        )(),
    )

    result = processor.process(
        "focus search field",
        {
            "app_name": "Slack",
            "window_title": "engineering",
            "context_quality": "full",
            "target_type": "chat",
        },
        "system_dictation",
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.pending_action_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "focus_field"
    assert result.telemetry.computer_use_plan_kind == "desktop_action"
    assert result.telemetry.action_review_required is False
    assert result.telemetry.action_execution_mode == "auto"


def test_processor_returns_structured_action_error_for_resolution_failures(monkeypatch):
    fake_agent = FakeSupervisorAgent(None)
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    monkeypatch.setattr(
        processor.reviewed_action_builder,
        "build",
        lambda **_kwargs: (_ for _ in ()).throw(ActionResolutionError("Accessibility access is required before Smart can focus fields or press buttons.")),
    )

    result = processor.process(
        "focus search field",
        {
            "app_name": "Slack",
            "window_title": "engineering",
            "context_quality": "full",
            "target_type": "chat",
        },
        "system_dictation",
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.pending_action_review is None
    assert result.auto_action is None
    assert result.final_text == ""
    assert result.action_error == "Accessibility access is required before Smart can focus fields or press buttons."
    assert result.action_error_kind == "resolution"


def test_processor_returns_structured_action_error_when_action_builder_times_out(monkeypatch):
    fake_agent = FakeSupervisorAgent(None)
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    monkeypatch.setattr(
        processor.reviewed_action_builder,
        "build",
        lambda **_kwargs: (_ for _ in ()).throw(RuntimeError(
            "LM Studio local model timed out while generating output. Try a smaller model, reduce the prompt context, or try again."
        )),
    )

    result = processor.process(
        "focus search field",
        {
            "app_name": "Slack",
            "window_title": "engineering",
            "context_quality": "full",
            "target_type": "chat",
        },
        "system_dictation",
    )

    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.pending_action_review is None
    assert result.auto_action is None
    assert result.final_text == ""
    assert result.action_error == "LM Studio local model timed out while generating output. Try a smaller model, reduce the prompt context, or try again."
    assert result.action_error_kind == "resolution"


def test_processor_returns_structured_action_error_when_actions_are_disabled(monkeypatch):
    fake_agent = FakeSupervisorAgent(None)
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )
    build_calls = {"count": 0}

    def fake_build(**_kwargs):
        build_calls["count"] += 1
        raise AssertionError("ReviewedActionBuilder.build should not run when actions are disabled.")

    monkeypatch.setattr(processor.reviewed_action_builder, "build", fake_build)

    result = processor.process(
        "focus search field",
        {
            "app_name": "Slack",
            "window_title": "engineering",
            "context_quality": "full",
            "target_type": "chat",
        },
        "system_dictation",
        actions_enabled=False,
    )

    assert build_calls["count"] == 0
    assert result.intent == SmartIntent.COMPUTER_USE
    assert result.pending_action_review is None
    assert result.auto_action is None
    assert result.final_text == ""
    assert result.action_error == "Desktop actions are disabled in Advanced settings."
    assert result.action_error_kind == "resolution"


def test_processor_returns_structured_action_error_when_experimental_media_controls_are_disabled(monkeypatch):
    fake_agent = FakeSupervisorAgent(None)
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    monkeypatch.setattr(
        processor.reviewed_action_builder,
        "build",
        lambda **_kwargs: type(
            "BuiltAction",
            (),
            {
                "pending_review": None,
                "auto_action": type(
                    "AutoAction",
                    (),
                    {"model_dump": lambda self, mode="json": {
                        "action_type": "play_pause",
                        "title": "Play or Pause",
                        "summary": "Play or pause the current system playback.",
                        "app_name": "System",
                        "bundle_id": None,
                        "value_percent": None,
                        "target_label": None,
                        "target_role": None,
                        "ui_index": None,
                    }},
                )(),
            },
        )(),
    )
    monkeypatch.setattr(
        processor.router,
        "plan",
        lambda *args, **kwargs: RoutingDecision(
            intent=SmartIntent.ACTION_EXECUTION,
            lane=SmartLane.LLM,
            confidence=0.91,
            ambiguity=0.09,
            reason="Explicit desktop action request.",
            requested_skill=SkillReference(id="system_dictation", name="Dictation"),
            skill_used=SkillReference(id="system_action_execution", name="Desktop Actions"),
        ),
    )

    result = processor.process(
        "play pause",
        {
            "app_name": "Notes",
            "window_title": "Scratchpad",
            "context_quality": "full",
            "target_type": "editor",
        },
        "system_dictation",
        experimental_media_controls_enabled=False,
    )

    assert result.intent == SmartIntent.ACTION_EXECUTION
    assert result.auto_action is None
    assert result.action_error == "Experimental media controls are turned off in Advanced settings."
    assert result.action_error_kind == "resolution"


def test_processor_uses_inline_spoken_source_material_for_local_rewrites():
    fake_agent = FakeSupervisorAgent("We can ship tomorrow morning.")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "make this sound more professional we can ship tomorrow morning",
        {
            "app_name": "Slack",
            "window_title": "ops-updates",
            "context_quality": "full",
            "target_type": "chat",
        },
        "system_rewrite",
    )

    assert fake_agent.last_transcript == "make this sound more professional"
    assert fake_agent.last_context["external_text"] == "we can ship tomorrow morning"
    assert fake_agent.last_context["external_text_source"] == "transcript_inline"
    assert result.final_text == "We can ship tomorrow morning."


def test_processor_falls_back_when_local_model_echoes_the_inline_instruction():
    fake_agent = FakeSupervisorAgent("Make this sound more professional.")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "make this sound more professional we can ship tomorrow morning",
        {
            "app_name": "Slack",
            "window_title": "ops-updates",
            "context_quality": "full",
            "target_type": "chat",
        },
        "system_rewrite",
    )

    assert result.final_text == "We can ship tomorrow morning."
    assert "local_instruction_echo_fallback" in result.deterministic_operations


def test_processor_uses_screen_context_as_source_material_for_local_screen_summaries():
    fake_agent = FakeSupervisorAgent("Summarize this screen.")
    processor = SmartModeProcessor(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        agent=fake_agent,
    )

    result = processor.process(
        "Summarize this screen.",
        {
            "app_name": "Google Chrome",
            "window_title": "Dashboard",
            "context_quality": "full",
            "target_type": "browser_doc",
            "screen_context": "Dashboard shows delayed shipments, open tasks, and three overdue items.",
        },
        "system_dictation",
    )

    assert fake_agent.calls == 0
    assert result.intent == SmartIntent.LOCAL_UNSUPPORTED
    assert result.lane == SmartLane.REFUSED
    assert result.refusal_message is not None
