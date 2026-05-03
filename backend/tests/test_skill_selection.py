from agent.skills.manager import SkillManager
from config.models import HotkeyConfig
from skill_selection import resolve_active_skill_selection, resolve_requested_skill


class FakeSkillRouterAgent:
    def __init__(self, *, skill_id: str | None = None, error: str | None = None, provider: str = "groq", model: str = "groq/compound-mini"):
        self.skill_id = skill_id
        self.error = error
        self.provider = provider
        self.model = model
        self.calls = 0
        self.last_kwargs = None

    def resolve_skill(self, **kwargs):
        self.calls += 1
        self.last_kwargs = dict(kwargs)
        if self.error:
            return None, self.error
        if self.skill_id is None:
            return None, None
        return type("Result", (), {
            "skill_id": self.skill_id,
            "confidence": 0.91,
            "reason": f"Model chose {self.skill_id}.",
            "latency_ms": 18,
        })(), None


def test_requested_skill_prefers_bundle_id_match_over_app_name():
    manager = SkillManager()

    hotkeys = HotkeyConfig(
        default_skill_id="system_dictation",
        app_skill_defaults=[
            {
                "id": "slack_name",
                "app_label": "Slack",
                "bundle_id": None,
                "url_host": None,
                "app_name": "Slack",
                "skill_id": "system_chat_reply",
                "enabled": True,
            },
            {
                "id": "slack_bundle",
                "app_label": "Slack macOS",
                "bundle_id": "com.tinyspeck.slackmacgap",
                "url_host": None,
                "app_name": "Slack",
                "skill_id": "system_email_draft",
                "enabled": True,
            },
        ],
    )

    selection = resolve_requested_skill(
        context={"app_name": "Slack", "bundle_id": "com.tinyspeck.slackmacgap"},
        hotkeys=hotkeys,
        skill_manager=manager,
    )

    assert selection.skill_id == "system_email_draft"
    assert selection.source == "app_override"
    assert selection.app_override_id == "slack_bundle"


def test_requested_skill_preserves_manual_non_dictation_default():
    manager = SkillManager()

    selection = resolve_requested_skill(
        context={"app_name": "Slack", "window_title": "eng-updates", "target_type": "chat"},
        hotkeys=HotkeyConfig(default_skill_id="system_grammar", app_skill_defaults=[]),
        skill_manager=manager,
    )

    assert selection.skill_id == "system_grammar"
    assert selection.source == "global_default"


def test_active_selection_auto_routes_chatgpt_context_from_system_dictation():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={"app_name": "Google Chrome", "bundle_id": "com.google.Chrome", "url_host": "chatgpt.com"},
        transcript="help me write a better prompt for this idea",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
    )

    assert selection.requested_skill_id == "system_dictation"
    assert selection.skill_id == "system_ai_chat_prompt"
    assert selection.source == "global_default"
    assert selection.auto_selected_skill_id == "system_ai_chat_prompt"
    assert selection.skill_router_resolver == "local"


def test_active_selection_keeps_imperative_codex_request_in_dictation_lane():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={"app_name": "Codex", "window_title": "repo", "target_type": "ide"},
        transcript="open Chrome and play indie songs on YouTube",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
    )

    assert selection.requested_skill_id == "system_dictation"
    assert selection.skill_id == "system_dictation"
    assert selection.auto_selected_skill_id is None


def test_active_selection_still_routes_prompt_shaped_codex_request():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={"app_name": "Codex", "window_title": "repo", "target_type": "ide"},
        transcript="write a Codex prompt for this auth migration plan",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
    )

    assert selection.requested_skill_id == "system_dictation"
    assert selection.skill_id == "system_codex_prompt"
    assert selection.auto_selected_skill_id == "system_codex_prompt"


def test_active_selection_auto_routes_social_post_context():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
            "url_host": "linkedin.com",
            "page_title": "LinkedIn",
            "focused_field_role": "AXTextArea",
            "focused_field_placeholder": "Start a post",
        },
        transcript="we just shipped native offline transcription and learned a lot about fallback design",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
    )

    assert selection.requested_skill_id == "system_dictation"
    assert selection.skill_id == "system_social_post"
    assert selection.auto_selected_skill_id == "system_social_post"
    assert selection.auto_selected_skill_name == "Social / Professional Post"


def test_active_selection_uses_issue_ticket_for_explicit_ticket_request():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={"app_name": "Notes", "window_title": "Draft"},
        transcript="turn this into a jira ticket with acceptance criteria for the paste failure",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
    )

    assert selection.requested_skill_id == "system_dictation"
    assert selection.skill_id == "system_issue_ticket"
    assert selection.auto_selected_skill_id == "system_issue_ticket"


def test_active_selection_app_override_wins_before_auto_routing():
    manager = SkillManager()

    hotkeys = HotkeyConfig(
        default_skill_id="system_dictation",
        app_skill_defaults=[
            {
                "id": "linkedin_host",
                "app_label": "LinkedIn",
                "bundle_id": None,
                "url_host": "linkedin.com",
                "app_name": "Google Chrome",
                "skill_id": "system_rewrite",
                "enabled": True,
            },
        ],
    )

    selection = resolve_active_skill_selection(
        context={
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
            "url_host": "linkedin.com",
            "focused_field_role": "AXTextArea",
            "focused_field_placeholder": "Start a post",
        },
        transcript="write a product launch update",
        hotkeys=hotkeys,
        skill_manager=manager,
    )

    assert selection.skill_id == "system_rewrite"
    assert selection.requested_skill_id == "system_rewrite"
    assert selection.source == "app_override"
    assert selection.auto_selected_skill_id is None


def test_active_selection_keeps_manual_non_dictation_template_sticky():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={"app_name": "Slack", "window_title": "eng-updates", "target_type": "chat"},
        transcript="please ship this today after qa signs off",
        hotkeys=HotkeyConfig(default_skill_id="system_grammar", app_skill_defaults=[]),
        skill_manager=manager,
    )

    assert selection.skill_id == "system_grammar"
    assert selection.requested_skill_id == "system_grammar"
    assert selection.auto_selected_skill_id is None


def test_active_selection_prefers_domain_skill_over_other_routes():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={"app_name": "Google Chrome", "bundle_id": "com.google.Chrome", "url_host": "linkedin.com"},
        transcript="write a professional post about the update",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
        domain_id="shipping",
        domain_skill_id="system_domain_email",
    )

    assert selection.skill_id == "system_domain_email"
    assert selection.requested_skill_id == "system_domain_email"
    assert selection.source == "domain_forced"
    assert selection.domain_skill_id == "system_domain_email"


def test_active_selection_falls_back_to_global_default_when_domain_skill_missing():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={"app_name": "Google Chrome", "bundle_id": "com.google.Chrome", "url_host": "athenahealth.com"},
        transcript="draft the patient update",
        hotkeys=HotkeyConfig(default_skill_id="system_grammar", app_skill_defaults=[]),
        skill_manager=manager,
        domain_id="medical",
        domain_skill_id="missing_domain_skill",
    )

    assert selection.skill_id == "system_grammar"
    assert selection.requested_skill_id == "system_grammar"
    assert selection.source == "global_default"


def test_active_selection_can_use_model_assisted_skill_router_for_ambiguous_candidates():
    manager = SkillManager()
    fake_router = FakeSkillRouterAgent(skill_id="system_issue_ticket")

    selection = resolve_active_skill_selection(
        context={"app_name": "Notes", "window_title": "Draft"},
        transcript="turn this into a jira ticket and summarize the bug clearly",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
        smart_router_agent=fake_router,
    )

    assert fake_router.calls == 1
    assert selection.skill_id == "system_issue_ticket"
    assert selection.requested_skill_id == "system_dictation"
    assert selection.skill_router_resolver == "model"
    assert selection.skill_router_model_attempted is True
    assert selection.auto_selected_skill_reason == "Model chose system_issue_ticket."


def test_active_selection_uses_local_candidate_when_skill_router_model_errors():
    manager = SkillManager()
    fake_router = FakeSkillRouterAgent(error="router timeout")

    selection = resolve_active_skill_selection(
        context={"app_name": "Notes", "window_title": "Draft"},
        transcript="turn this into a jira ticket and summarize the bug clearly",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
        smart_router_agent=fake_router,
    )

    assert fake_router.calls == 1
    assert selection.skill_id == "system_issue_ticket"
    assert selection.skill_router_resolver == "local"
    assert selection.skill_router_model_attempted is True
    assert selection.skill_router_model_error == "router timeout"


def test_active_selection_uses_cloud_code_prompt_for_cloud_code_app_context():
    manager = SkillManager()

    selection = resolve_active_skill_selection(
        context={"app_name": "Cloud Code", "window_title": "SteerVox task brief"},
        transcript="write me a prompt for the implementation plan",
        hotkeys=HotkeyConfig(default_skill_id="system_dictation", app_skill_defaults=[]),
        skill_manager=manager,
    )

    assert selection.skill_id == "system_cloud_code_prompt"
    assert selection.requested_skill_id == "system_dictation"
    assert selection.source == "global_default"
    assert selection.auto_selected_skill_id == "system_cloud_code_prompt"


def test_active_selection_does_not_auto_select_computer_use_for_cloud_code_context():
    manager = SkillManager()
    hotkeys = HotkeyConfig(
        default_skill_id="system_dictation",
        app_skill_defaults=[
            {
                "id": "cloud_code_app",
                "app_label": "Cloud Code",
                "bundle_id": None,
                "url_host": None,
                "app_name": "Cloud Code",
                "skill_id": "system_cloud_code_prompt",
                "enabled": True,
            },
        ],
    )

    selection = resolve_active_skill_selection(
        context={"app_name": "Cloud Code", "window_title": "Implementation brief"},
        transcript="write me an implementation prompt for this backend route",
        hotkeys=hotkeys,
        skill_manager=manager,
    )

    assert selection.requested_skill_id == "system_cloud_code_prompt"
    assert selection.skill_id == "system_cloud_code_prompt"
    assert selection.source == "app_override"
    assert selection.auto_selected_skill_id is None
