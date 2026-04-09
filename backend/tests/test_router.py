import pytest

from agent.router import LocalIntentRouter, apply_deterministic_transform, infer_format_preference
from agent.skills.defaults import DefaultSkills
from agent.skills.models import SkillDefinition
from agent.smart_models import SmartIntent, SmartLane


def test_router_prefers_chat_reply_for_chat_context():
    router = LocalIntentRouter()
    decision = router.plan(
        "hey can you take a look at this after lunch",
        {
            "app_name": "Slack",
            "window_title": "engineering",
            "context_quality": "full",
            "target_type": "chat",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.CHAT_REPLY
    assert decision.lane == SmartLane.LLM


def test_router_uses_deterministic_lane_for_terminal_commands():
    router = LocalIntentRouter()
    decision = router.plan(
        "um git status.",
        {
            "app_name": "Terminal",
            "window_title": "zsh",
            "context_quality": "app_only",
            "target_type": "ide",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    final_text, operations = apply_deterministic_transform(decision.intent, "um git status.")

    assert decision.intent == SmartIntent.TERMINAL_COMMAND
    assert decision.lane == SmartLane.DETERMINISTIC
    assert final_text == "git status"
    assert "trim_fillers" in operations


def test_router_detects_spoken_bullets():
    router = LocalIntentRouter()
    decision = router.plan(
        "point one ship routing point two add tests point three update docs",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.BULLETIZE
    assert decision.lane == SmartLane.LLM


def test_router_detects_spoken_number_markers_as_list_structure():
    router = LocalIntentRouter()
    transcript = "number one ship routing number two add tests number three update docs"
    decision = router.plan(
        transcript,
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    preference = infer_format_preference(transcript, DefaultSkills.DICTATION, {})

    assert decision.intent == SmartIntent.BULLETIZE
    assert decision.lane == SmartLane.LLM
    assert preference == "numbered"


def test_infer_format_preference_detects_period_number_markers_as_numbered_preference():
    transcript = "one period ship routing two period add tests three period update docs"

    preference = infer_format_preference(
        transcript,
        DefaultSkills.DICTATION,
        {},
    )

    assert preference == "numbered"


def test_infer_format_preference_detects_inline_numbered_markers_as_numbered_preference():
    transcript = "1. ship routing 2. add tests 3. update docs"

    preference = infer_format_preference(
        transcript,
        DefaultSkills.DICTATION,
        {},
    )

    assert preference == "numbered"


def test_router_detects_bare_point_markers_as_bullets():
    router = LocalIntentRouter()
    transcript = "point, Bangalore outgoing shipments are pending pickup point, refurbookingmatch for blue peak account point, Chennai needs carrier confirmation"
    decision = router.plan(
        transcript,
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.BULLETIZE
    assert decision.lane == SmartLane.LLM


def test_router_detects_hyphen_prefixed_spoken_points_as_bullets():
    router = LocalIntentRouter()
    transcript = "- Point, Bangalore outgoing shipments are pending pick up\n- Point, refurbooking for blue peak account\n- Point, Chennai needs carrier confirmation"
    decision = router.plan(
        transcript,
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.BULLETIZE
    assert decision.lane == SmartLane.LLM


def test_router_honors_explicit_paragraph_request_over_spoken_points():
    router = LocalIntentRouter()
    transcript = "turn this into a paragraph point, Bangalore outgoing shipments are pending pickup point, Chennai needs carrier confirmation"
    decision = router.plan(
        transcript,
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.GENERIC
    assert decision.lane == SmartLane.LLM


def test_router_detects_explicit_bullet_request_without_spoken_markers():
    router = LocalIntentRouter()
    transcript = "make this a bulleted list for the warehouse team update"
    decision = router.plan(
        transcript,
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.BULLETIZE
    assert decision.lane == SmartLane.LLM


def test_router_detects_translation_intent():
    router = LocalIntentRouter()
    decision = router.plan(
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
    assert decision.lane == SmartLane.LLM


def test_router_detects_explicit_desktop_action_requests():
    router = LocalIntentRouter()
    decision = router.plan(
        "open github.com/openai",
        {
            "app_name": "Safari",
            "window_title": "Start Page",
            "context_quality": "full",
            "target_type": "browser",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.ACTION_EXECUTION
    assert decision.lane == SmartLane.DETERMINISTIC


def test_router_detects_spoken_dot_url_requests_as_deterministic_actions():
    router = LocalIntentRouter()
    decision = router.plan(
        "go to strategy dot com",
        {
            "app_name": "Google Chrome",
            "window_title": "New Tab",
            "context_quality": "full",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.ACTION_EXECUTION
    assert decision.lane == SmartLane.DETERMINISTIC


def test_router_detects_named_field_focus_requests_as_actions():
    router = LocalIntentRouter()
    decision = router.plan(
        "focus search field",
        {
            "app_name": "Slack",
            "window_title": "engineering",
            "context_quality": "full",
            "target_type": "chat",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.ACTION_EXECUTION
    assert decision.lane == SmartLane.LLM


def test_router_detects_named_button_press_requests_as_actions():
    router = LocalIntentRouter()
    decision = router.plan(
        "click send button",
        {
            "app_name": "Mail",
            "window_title": "Draft",
            "context_quality": "full",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.ACTION_EXECUTION
    assert decision.lane == SmartLane.LLM


def test_router_does_not_treat_long_freeform_speech_with_action_words_as_action_execution():
    router = LocalIntentRouter()
    decision = router.plan(
        "we need to keep the app open during the demo and focus on the onboarding steps before launch so the new users can navigate it easily",
        {
            "app_name": "Notes",
            "window_title": "Draft",
            "context_quality": "app_only",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent != SmartIntent.ACTION_EXECUTION


def test_router_treats_split_grammar_skills_as_cleanup_routes():
    router = LocalIntentRouter()

    for skill in (DefaultSkills.STRICT_GRAMMAR, DefaultSkills.SYSTEM_REWRITE, DefaultSkills.GRAMMAR_FIX):
        decision = router.plan(
            "clean this up for the team update",
            {
                "app_name": "Notes",
                "window_title": "Draft",
                "context_quality": "app_only",
                "target_type": "generic",
            },
            requested_skill=skill,
            effective_skill=skill,
        )

        assert decision.intent == SmartIntent.GRAMMAR_CLEANUP
        assert decision.lane in {SmartLane.DETERMINISTIC, SmartLane.LLM}


def test_router_uses_llm_lane_for_inline_rewrite_requests_with_source_text():
    router = LocalIntentRouter()
    decision = router.plan(
        "make this sound more professional we can ship tomorrow morning",
        {
            "app_name": "Slack",
            "window_title": "ops-updates",
            "context_quality": "full",
            "target_type": "chat",
        },
        requested_skill=DefaultSkills.SYSTEM_REWRITE,
        effective_skill=DefaultSkills.SYSTEM_REWRITE,
    )

    assert decision.intent == SmartIntent.GRAMMAR_CLEANUP
    assert decision.lane == SmartLane.LLM


def test_router_falls_back_to_raw_dictation_when_context_is_transcript_only():
    router = LocalIntentRouter()
    decision = router.plan(
        "hello there",
        {
            "app_name": "Unknown",
            "context_quality": "transcript_only",
            "target_type": None,
        },
        requested_skill=DefaultSkills.DICTATION,
        effective_skill=DefaultSkills.DICTATION,
    )

    assert decision.intent == SmartIntent.RAW_DICTATION
    assert decision.lane == SmartLane.PASSTHROUGH


def test_router_uses_generic_llm_lane_when_no_safe_local_route_matches():
    router = LocalIntentRouter()
    generic_skill = SkillDefinition(
        id="custom_generic",
        name="Generic Rewriter",
        prompt="Rewrite with clarity.",
    )
    decision = router.plan(
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


def test_router_detects_prompt_crafting_for_prompt_architect_skill():
    router = LocalIntentRouter()
    decision = router.plan(
        "write a system prompt that keeps JSON output strict",
        {
            "app_name": "Google Chrome",
            "window_title": "ChatGPT",
            "url_host": "chatgpt.com",
            "context_quality": "full",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.PROMPT_ARCHITECT,
        effective_skill=DefaultSkills.PROMPT_ARCHITECT,
    )

    assert decision.intent == SmartIntent.PROMPT_CRAFTING
    assert decision.lane == SmartLane.LLM


def test_router_uses_generic_llm_lane_for_ai_chat_surface_without_explicit_prompt_request():
    router = LocalIntentRouter()
    decision = router.plan(
        "research this YouTube transcript and pull out the main claims",
        {
            "app_name": "Google Chrome",
            "window_title": "Gemini",
            "url_host": "gemini.google.com",
            "context_quality": "full",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.AI_CHAT_PROMPT,
        effective_skill=DefaultSkills.AI_CHAT_PROMPT,
    )

    assert decision.intent == SmartIntent.GENERIC
    assert decision.lane == SmartLane.LLM


@pytest.mark.parametrize("host", ["chatgpt.com", "claude.ai", "gemini.google.com"])
def test_router_prioritizes_explicit_action_requests_over_prompt_site_skill(host):
    router = LocalIntentRouter()
    decision = router.plan(
        "focus the chat input box",
        {
            "app_name": "Google Chrome",
            "window_title": "AI chat",
            "url_host": host,
            "context_quality": "full",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.PROMPT_ARCHITECT,
        effective_skill=DefaultSkills.PROMPT_ARCHITECT,
    )

    assert decision.intent == SmartIntent.ACTION_EXECUTION
    assert decision.lane == SmartLane.LLM


@pytest.mark.parametrize("host", ["chatgpt.com", "claude.ai", "gemini.google.com"])
def test_router_prioritizes_explicit_button_actions_over_prompt_site_skill(host):
    router = LocalIntentRouter()
    decision = router.plan(
        "click send button",
        {
            "app_name": "Google Chrome",
            "window_title": "AI chat",
            "url_host": host,
            "context_quality": "full",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.PROMPT_ARCHITECT,
        effective_skill=DefaultSkills.PROMPT_ARCHITECT,
    )

    assert decision.intent == SmartIntent.ACTION_EXECUTION
    assert decision.lane == SmartLane.LLM


@pytest.mark.parametrize("host", ["chatgpt.com", "claude.ai", "gemini.google.com"])
def test_router_prioritizes_browser_focus_actions_over_prompt_site_skill(host):
    router = LocalIntentRouter()
    decision = router.plan(
        "focus address bar",
        {
            "app_name": "Google Chrome",
            "window_title": "AI chat",
            "url_host": host,
            "context_quality": "full",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.PROMPT_ARCHITECT,
        effective_skill=DefaultSkills.PROMPT_ARCHITECT,
    )

    assert decision.intent == SmartIntent.ACTION_EXECUTION
    assert decision.lane in {SmartLane.LLM, SmartLane.DETERMINISTIC}


def test_router_detects_workflow_design_for_agent_builder_skill():
    router = LocalIntentRouter()
    decision = router.plan(
        "turn this into a json schema for an agent action",
        {
            "app_name": "Google Chrome",
            "window_title": "n8n",
            "url_host": "n8n.io",
            "context_quality": "full",
            "target_type": "generic",
        },
        requested_skill=DefaultSkills.AGENT_ACTION_BUILDER,
        effective_skill=DefaultSkills.AGENT_ACTION_BUILDER,
    )

    assert decision.intent == SmartIntent.WORKFLOW_DESIGN
    assert decision.lane == SmartLane.LLM
    assert decision.output_mode == "code"


def test_router_detects_code_refactor_in_editor_context():
    router = LocalIntentRouter()
    decision = router.plan(
        "refactor this function to avoid duplicated parsing",
        {
            "app_name": "Cursor",
            "window_title": "processor.py",
            "context_quality": "full",
            "target_type": "ide",
        },
        requested_skill=DefaultSkills.CODE_SNIPPET,
        effective_skill=DefaultSkills.CODE_SNIPPET,
    )

    assert decision.intent == SmartIntent.CODE_REFACTOR
    assert decision.lane == SmartLane.LLM
