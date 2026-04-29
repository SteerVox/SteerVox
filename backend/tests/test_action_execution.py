import subprocess
from types import SimpleNamespace

import pytest

from action_execution import (
    ActionResolutionError,
    PendingActionReview,
    ReviewedActionBuilder,
    execute_auto_action,
    execute_reviewed_action,
    validate_reviewed_action,
)
from agent.skills.defaults import DefaultSkills
from agent.smart_models import AutoActionPayload
from app_catalog import InstalledAppRecord, normalize_app_match_text
from system_control import SystemControlError
from ui_automation import FrontmostUISnapshot, UIElementCandidate


class FakeAppCatalog:
    def __init__(self, records):
        self.records = records

    def list_apps(self, *, force_refresh: bool = False):
        return list(self.records)


class FakeUIAutomation:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.calls = []

    def capture_frontmost_ui_snapshot(self):
        return self.snapshot

    def execute_auto_ui_action(self, **kwargs):
        self.calls.append(kwargs)


def _app_record(display_name: str, bundle_id: str, app_path: str) -> InstalledAppRecord:
    return InstalledAppRecord(
        display_name=display_name,
        bundle_name=display_name,
        executable_name=display_name,
        bundle_id=bundle_id,
        app_path=app_path,
        aliases=(normalize_app_match_text(display_name), normalize_app_match_text(display_name).replace(" ", "")),
    )


def _ui_snapshot(*elements: UIElementCandidate, app_name: str = "Slack", bundle_id: str = "com.tinyspeck.slackmacgap") -> FrontmostUISnapshot:
    return FrontmostUISnapshot(
        app_name=app_name,
        bundle_id=bundle_id,
        elements=tuple(elements),
    )


def test_reviewed_action_builder_creates_open_url_review_locally():
    builder = ReviewedActionBuilder(provider="lmstudio", model="demo", temperature=0.0)

    result = builder.build(
        transcript="open github.com/openai",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert result.pending_review.action_type == "open_url"
    assert result.pending_review.summary == "Open https://github.com/openai in the default browser."
    assert result.pending_review.script == 'open location "https://github.com/openai"'
    assert result.auto_action is None


def test_reviewed_action_builder_navigates_current_supported_browser_tab_for_url():
    builder = ReviewedActionBuilder(provider="lmstudio", model="demo", temperature=0.0)

    result = builder.build(
        transcript="go to strategy.com",
        context={
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
        },
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert result.pending_review.action_type == "open_url"
    assert result.pending_review.summary == "Navigate the current Google Chrome tab to https://strategy.com."
    assert result.pending_review.script == '\n'.join([
        'tell application "Google Chrome"',
        'activate',
        'if (count of windows) = 0 then make new window',
        'set URL of active tab of front window to "https://strategy.com"',
        'end tell',
    ])


def test_reviewed_action_builder_understands_spoken_dot_urls():
    builder = ReviewedActionBuilder(provider="lmstudio", model="demo", temperature=0.0)

    result = builder.build(
        transcript="go to strategy dot com",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert result.pending_review.script == 'open location "https://strategy.com"'


def test_reviewed_action_builder_uses_screen_context_for_mail_draft_body():
    builder = ReviewedActionBuilder(provider="lmstudio", model="demo", temperature=0.0)

    result = builder.build(
        transcript="draft an email to Sarah about the Q3 spreadsheet",
        context={"screen_context": "Revenue beat plan by 12% and margins improved."},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert result.pending_review.action_type == "mail_draft"
    assert "Revenue beat plan by 12%" in result.pending_review.script


def test_reviewed_action_builder_resolves_near_match_apps_to_installed_catalog_entries():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        app_catalog=FakeAppCatalog([
            _app_record("Camo Studio", "com.reincubate.macos.camo", "/Applications/Camo Studio.app"),
            _app_record("Camera Hub", "com.elgato.camerahub", "/Applications/Camera Hub.app"),
        ]),
    )

    result = builder.build(
        transcript="switch to camo cam",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert result.pending_review.action_type == "open_app"
    assert result.pending_review.summary == "Bring Camo Studio to the front."
    assert 'tell application id "com.reincubate.macos.camo"' in result.pending_review.script
    assert "\nreopen\nactivate\n" in result.pending_review.script


def test_reviewed_action_builder_resolves_finder_from_system_app_catalog_entries():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        app_catalog=FakeAppCatalog([
            _app_record("Finder", "com.apple.finder", "/System/Library/CoreServices/Finder.app"),
        ]),
    )

    result = builder.build(
        transcript="open finder",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert result.pending_review.action_type == "open_app"
    assert result.pending_review.summary == "Open Finder."
    assert 'tell application id "com.apple.finder"' in result.pending_review.script


def test_reviewed_action_builder_strips_follow_up_clause_from_open_app_request():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        app_catalog=FakeAppCatalog([
            _app_record("Finder", "com.apple.finder", "/System/Library/CoreServices/Finder.app"),
        ]),
    )

    result = builder.build(
        transcript="open finder and go to downloads folder",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert result.pending_review.action_type == "open_app"
    assert result.pending_review.summary == "Open Finder."


def test_reviewed_action_builder_handles_polite_open_app_request():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        app_catalog=FakeAppCatalog([
            _app_record("Google Chrome", "com.google.Chrome", "/Applications/Google Chrome.app"),
        ]),
    )

    result = builder.build(
        transcript="could you please open Chrome for me?",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert result.pending_review.action_type == "open_app"
    assert result.pending_review.summary == "Open Google Chrome."
    assert 'tell application id "com.google.Chrome"' in result.pending_review.script


def test_reviewed_action_builder_uses_llm_tiebreak_for_ambiguous_app_matches(monkeypatch):
    builder = ReviewedActionBuilder(
        provider="groq",
        model="demo",
        temperature=0.0,
        app_catalog=FakeAppCatalog([
            _app_record("Things", "com.culturedcode.ThingsMac", "/Applications/Things.app"),
            _app_record("Thingy", "com.example.thingy", "/Applications/Thingy.app"),
        ]),
    )

    monkeypatch.setattr(
        builder,
        "_choose_candidate_with_llm",
        lambda **_kwargs: _kwargs["candidates"][1],
    )

    result = builder.build(
        transcript="open thing",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is not None
    assert "Thingy" in result.pending_review.summary


def test_reviewed_action_builder_surfaces_suggestions_when_no_app_matches():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        app_catalog=FakeAppCatalog([
            _app_record("Safari", "com.apple.Safari", "/Applications/Safari.app"),
            _app_record("Slack", "com.tinyspeck.slackmacgap", "/Applications/Slack.app"),
        ]),
    )

    with pytest.raises(ActionResolutionError, match="Try: Safari, Slack"):
        builder.build(
            transcript="open camo cam",
            context={},
            skill=DefaultSkills.ACTION_EXECUTION,
        )


def test_reviewed_action_builder_creates_auto_focus_action_for_named_field():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(
            UIElementCandidate(ui_index=3, role="AXSearchField", subrole=None, label="Search", description=None, placeholder="Search"),
            UIElementCandidate(ui_index=6, role="AXTextArea", subrole=None, label="Message", description=None, placeholder=None),
        )),
    )

    result = builder.build(
        transcript="focus search field",
        context={"app_name": "Slack"},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "focus_field"
    assert result.auto_action.target_label == "Search"
    assert result.auto_action.ui_index == 3


def test_reviewed_action_builder_creates_browser_address_bar_auto_action():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot()),
    )

    result = builder.build(
        transcript="focus address bar",
        context={"app_name": "Google Chrome", "bundle_id": "com.google.Chrome"},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "focus_browser_address_bar"
    assert result.auto_action.app_name == "Google Chrome"
    assert result.auto_action.bundle_id == "com.google.Chrome"


def test_reviewed_action_builder_creates_play_pause_auto_action_for_supported_media_apps():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot()),
    )

    result = builder.build(
        transcript="play pause",
        context={"app_name": "Music", "bundle_id": "com.apple.Music"},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "play_pause"
    assert result.auto_action.app_name == "Music"
    assert result.auto_action.target_label is None


def test_reviewed_action_builder_creates_global_play_pause_auto_action_for_any_frontmost_app():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(app_name="Notes", bundle_id="com.apple.Notes")),
    )

    result = builder.build(
        transcript="play pause",
        context={"app_name": "Notes", "bundle_id": "com.apple.Notes"},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "play_pause"
    assert result.auto_action.app_name == "Notes"


def test_reviewed_action_builder_creates_exact_volume_auto_action_from_spoken_number():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
    )

    result = builder.build(
        transcript="set volume to fifty five percent",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "set_volume_percent"
    assert result.auto_action.value_percent == 55


def test_reviewed_action_builder_creates_exact_brightness_auto_action():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
    )

    result = builder.build(
        transcript="brightness 70 percent",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "set_brightness_percent"
    assert result.auto_action.value_percent == 70


def test_reviewed_action_builder_creates_unmute_auto_action():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
    )

    result = builder.build(
        transcript="unmute audio",
        context={},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "unmute_audio"


def test_reviewed_action_builder_rejects_fuzzy_brightness_requests(monkeypatch):
    builder = ReviewedActionBuilder(provider="lmstudio", model="demo", temperature=0.0)
    monkeypatch.setattr(builder, "_build_llm_plan", lambda *_args, **_kwargs: None)

    with pytest.raises(RuntimeError, match="safe desktop action"):
        builder.build(
            transcript="make it slightly dimmer",
            context={},
            skill=DefaultSkills.ACTION_EXECUTION,
        )


def test_reviewed_action_builder_creates_browser_reload_auto_action():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot()),
    )

    result = builder.build(
        transcript="reload this page",
        context={"app_name": "Safari", "bundle_id": "com.apple.Safari"},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "browser_reload"
    assert result.auto_action.app_name == "Safari"


def test_reviewed_action_builder_creates_global_pause_action_for_unsupported_apps():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot()),
    )

    result = builder.build(
        transcript="pause",
        context={"app_name": "Notes"},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "pause_playback"
    assert result.auto_action.app_name == "Notes"


@pytest.mark.parametrize(
    ("transcript", "app_name", "bundle_id"),
    [
        ("focus address bar", "Google Chrome", "com.google.Chrome"),
        ("focus url bar", "Safari", "com.apple.Safari"),
        ("focus omnibox", "Arc", "company.thebrowser.Browser"),
        ("focus browser address", "Brave Browser", "com.brave.Browser"),
        ("focus address bar", "Microsoft Edge", "com.microsoft.edgemac"),
    ],
)
def test_reviewed_action_builder_routes_supported_browser_address_bar_requests(
    transcript,
    app_name,
    bundle_id,
):
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(app_name=app_name, bundle_id=bundle_id)),
    )

    result = builder.build(
        transcript=transcript,
        context={"app_name": app_name, "bundle_id": bundle_id},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.auto_action is not None
    assert result.auto_action.action_type == "focus_browser_address_bar"
    assert result.auto_action.app_name == app_name


@pytest.mark.parametrize(
    "transcript",
    [
        "focus the chat input box",
        "focus the prompt box",
        "focus the message field",
        "select the input box of ChatGPT",
    ],
)
def test_reviewed_action_builder_matches_ai_chat_field_aliases(transcript):
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(
            UIElementCandidate(
                ui_index=9,
                role="AXTextArea",
                subrole=None,
                label="Message",
                description=None,
                placeholder=None,
                source_class="page_content",
            ),
            app_name="Google Chrome",
            bundle_id="com.google.Chrome",
        )),
    )

    result = builder.build(
        transcript=transcript,
        context={
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
            "url_host": "chatgpt.com",
        },
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "focus_primary_chat_input"
    assert result.auto_action.ui_index == 0


def test_reviewed_action_builder_creates_auto_press_action_for_named_button():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(
            UIElementCandidate(ui_index=8, role="AXButton", subrole=None, label="Send", description=None, placeholder=None),
        )),
    )

    result = builder.build(
        transcript="click send button",
        context={"app_name": "Mail"},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "press_button"
    assert result.auto_action.target_label == "Send"


def test_reviewed_action_builder_routes_ai_chat_send_requests_to_deterministic_send_action():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(
            app_name="Google Chrome",
            bundle_id="com.google.Chrome",
        )),
    )

    result = builder.build(
        transcript="click send button",
        context={
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
            "url_host": "chatgpt.com",
        },
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "press_primary_chat_send"
    assert result.auto_action.target_label == "Send"


def test_reviewed_action_builder_infers_ai_chat_site_from_titles_when_host_is_missing():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(
            app_name="Google Chrome",
            bundle_id="com.google.Chrome",
        )),
    )

    result = builder.build(
        transcript="focus chat input",
        context={
            "app_name": "Google Chrome",
            "bundle_id": "com.google.Chrome",
            "page_title": "Gemini",
            "window_title": "Ask Gemini",
        },
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.pending_review is None
    assert result.auto_action is not None
    assert result.auto_action.action_type == "focus_primary_chat_input"
    assert result.auto_action.summary == "Focus the main chat input in Gemini."


def test_reviewed_action_builder_cleans_click_on_target_and_prefers_page_links():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(
            UIElementCandidate(
                ui_index=4,
                role="AXButton",
                subrole=None,
                label="New tab",
                description=None,
                placeholder=None,
                source_class="browser_chrome",
            ),
            UIElementCandidate(
                ui_index=12,
                role="AXLink",
                subrole=None,
                label="Pricing",
                description=None,
                placeholder=None,
                source_class="page_content",
            ),
            app_name="Google Chrome",
            bundle_id="com.google.Chrome",
        )),
    )

    result = builder.build(
        transcript="click on pricing on current page",
        context={"app_name": "Google Chrome"},
        skill=DefaultSkills.ACTION_EXECUTION,
    )

    assert result.auto_action is not None
    assert result.auto_action.action_type == "press_button"
    assert result.auto_action.target_label == "Pricing"
    assert result.auto_action.target_role == "AXLink"


def test_reviewed_action_builder_surfaces_page_control_error_when_only_browser_chrome_controls_exist():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(
            UIElementCandidate(
                ui_index=4,
                role="AXButton",
                subrole=None,
                label="New tab",
                description=None,
                placeholder=None,
                source_class="browser_chrome",
            ),
            app_name="Google Chrome",
            bundle_id="com.google.Chrome",
        )),
    )

    with pytest.raises(ActionResolutionError, match="page control matching 'pricing'"):
        builder.build(
            transcript="click on pricing on current page",
            context={"app_name": "Google Chrome"},
            skill=DefaultSkills.ACTION_EXECUTION,
        )


def test_reviewed_action_builder_surfaces_ui_suggestions_for_ambiguous_fields(monkeypatch):
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=FakeUIAutomation(_ui_snapshot(
            UIElementCandidate(ui_index=3, role="AXTextField", subrole=None, label="Billing email", description=None, placeholder=None),
            UIElementCandidate(ui_index=5, role="AXTextField", subrole=None, label="Shipping email", description=None, placeholder=None),
        )),
    )
    monkeypatch.setattr(builder, "_choose_candidate_with_llm", lambda **_kwargs: None)

    with pytest.raises(ActionResolutionError, match="Try: Billing email, Shipping email"):
        builder.build(
            transcript="focus email field",
            context={"app_name": "Slack"},
            skill=DefaultSkills.ACTION_EXECUTION,
        )


def test_validate_reviewed_action_rejects_disallowed_mail_automation():
    review = PendingActionReview(
        run_id="review-1",
        action_type="mail_draft",
        title="Draft Email",
        summary="Draft an email.",
        script='tell application "Mail"\nsend\nend tell',
    )

    assert "blocked automation token" in (validate_reviewed_action(review) or "").lower()


def test_execute_reviewed_action_runs_osascript_for_allowlisted_reviews(monkeypatch):
    calls = {}

    def fake_run(args, check, capture_output, text):
        calls["args"] = args
        calls["check"] = check
        calls["capture_output"] = capture_output
        calls["text"] = text
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("action_execution.subprocess.run", fake_run)

    review = PendingActionReview(
        run_id="review-1",
        action_type="open_app",
        title="Open App",
        summary="Open Mail.",
        script='tell application id "com.apple.mail"\nreopen\nactivate\nend tell',
    )

    execute_reviewed_action(review)

    assert calls["args"] == ["osascript", "-e", 'tell application id "com.apple.mail"\nreopen\nactivate\nend tell']
    assert calls["check"] is True
    assert calls["capture_output"] is True
    assert calls["text"] is True


def test_reviewed_action_builder_compiles_structured_youtube_browser_steps():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        app_catalog=FakeAppCatalog([]),
    )

    open_url_step = type(
        "PlannedStep",
        (),
        {
            "action_type": "open_url",
            "request": "open YouTube results",
            "title": "Open YouTube search",
            "summary": "Open YouTube search results for indie songs in Google Chrome.",
            "app_name": "Google Chrome",
            "browser_app_name": "Google Chrome",
            "url": "https://www.youtube.com/results?search_query=indie+songs",
            "site": "youtube",
            "query": "indie songs",
        },
    )()
    open_url_result = builder.build_planned_step(
        planned_step=open_url_step,
        context={"app_name": "Codex"},
        skill=DefaultSkills.COMPUTER_USE,
    )
    assert open_url_result.pending_review is not None
    assert open_url_result.pending_review.action_type == "open_url"
    assert "youtube.com/results" in open_url_result.pending_review.script.lower()

    playback_step = type(
        "PlannedStep",
        (),
        {
            "action_type": "youtube_ensure_playing",
            "request": "start playback if paused",
            "title": "Ensure playback",
            "summary": "Start playback only if the current YouTube video is paused.",
            "app_name": "Google Chrome",
            "browser_app_name": "Google Chrome",
            "site": "youtube",
            "query": "indie songs",
        },
    )()
    playback_result = builder.build_planned_step(
        planned_step=playback_step,
        context={"app_name": "Codex"},
        skill=DefaultSkills.COMPUTER_USE,
    )
    assert playback_result.pending_review is not None
    assert playback_result.pending_review.action_type == "youtube_ensure_playing"
    assert "execute front window's active tab javascript" in playback_result.pending_review.script.lower()


def test_reviewed_youtube_actions_reject_unsupported_browser():
    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        app_catalog=FakeAppCatalog([]),
    )

    planned_step = type(
        "PlannedStep",
        (),
        {
            "action_type": "youtube_open_first_result",
            "request": "open the first YouTube result",
            "title": "Open first result",
            "summary": "Open the first YouTube result.",
            "app_name": "Arc",
            "browser_app_name": "Arc",
            "site": "youtube",
            "query": "indie songs",
        },
    )()

    with pytest.raises(ActionResolutionError, match="not supported yet"):
        builder.build_planned_step(
            planned_step=planned_step,
            context={"app_name": "Codex"},
            skill=DefaultSkills.COMPUTER_USE,
        )


def test_validate_reviewed_youtube_action_accepts_allowlisted_script():
    review = PendingActionReview(
        run_id="review-youtube-1",
        action_type="youtube_open_first_result",
        title="Open first result",
        summary="Open the first YouTube result.",
        script=(
            'tell application "Google Chrome"\n'
            'activate\n'
            'if (count of windows) = 0 then error "Google Chrome does not have an open browser window."\n'
            'execute front window\'s active tab javascript "(() => { if (!location.hostname.includes(\'youtube.com\')) { throw new Error(\'Not on YouTube.\'); } const firstResult = document.querySelector(\'ytd-video-renderer a#video-title\'); if (!firstResult) { throw new Error(\'No YouTube search result available.\'); } firstResult.click(); return \'opened-first-result\'; })();"\n'
            'end tell'
        ),
    )

    assert validate_reviewed_action(review) is None


def test_normalize_app_match_text_strips_hidden_format_characters():
    assert normalize_app_match_text("\u200eWhatsApp") == "whatsapp"


def test_reviewed_action_builder_surfaces_clear_timeout_message_for_ui_snapshots():
    class TimeoutUIAutomation:
        def capture_frontmost_ui_snapshot(self):
            raise subprocess.TimeoutExpired(["osascript"], 2.5)

    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=TimeoutUIAutomation(),
    )

    with pytest.raises(ActionResolutionError, match="took too long to expose usable UI controls"):
        builder.build(
            transcript="click sign in button",
            context={"app_name": "Google Chrome"},
            skill=DefaultSkills.ACTION_EXECUTION,
        )


def test_reviewed_action_builder_surfaces_clear_compile_error_for_ui_snapshots():
    class BrokenScriptUIAutomation:
        def capture_frontmost_ui_snapshot(self):
            raise subprocess.CalledProcessError(1, ["osascript"], stderr='1032:1033: syntax error: Expected end of line but found “"”. (-2741)')

    builder = ReviewedActionBuilder(
        provider="lmstudio",
        model="demo",
        temperature=0.0,
        ui_automation=BrokenScriptUIAutomation(),
    )

    with pytest.raises(ActionResolutionError, match="failed to compile"):
        builder.build(
            transcript="focus search field",
            context={"app_name": "Google Chrome"},
            skill=DefaultSkills.ACTION_EXECUTION,
        )


def test_execute_auto_action_uses_ui_automation_service(monkeypatch):
    fake_ui = FakeUIAutomation(_ui_snapshot())
    monkeypatch.setattr("action_execution.UIAutomationService", lambda: fake_ui)

    execute_auto_action(AutoActionPayload(
        action_type="focus_field",
        title="Focus Field",
        summary="Focus Search in Slack.",
        app_name="Slack",
        bundle_id="com.tinyspeck.slackmacgap",
        target_label="Search",
        target_role="AXSearchField",
        ui_index=3,
    ))

    assert fake_ui.calls == [{
        "action_type": "focus_field",
        "ui_index": 3,
        "expected_app_name": "Slack",
        "expected_bundle_id": "com.tinyspeck.slackmacgap",
        "expected_role": "AXSearchField",
    }]


def test_execute_auto_action_routes_browser_address_bar_to_ui_automation(monkeypatch):
    fake_ui = FakeUIAutomation(_ui_snapshot())
    monkeypatch.setattr("action_execution.UIAutomationService", lambda: fake_ui)

    execute_auto_action(AutoActionPayload(
        action_type="focus_browser_address_bar",
        title="Focus Address Bar",
        summary="Focus the address bar in Google Chrome.",
        app_name="Google Chrome",
        bundle_id="com.google.Chrome",
        target_label="Address bar",
        target_role="browser_chrome",
        ui_index=0,
    ))

    assert fake_ui.calls == [{
        "action_type": "focus_browser_address_bar",
        "ui_index": 0,
        "expected_app_name": "Google Chrome",
        "expected_bundle_id": "com.google.Chrome",
        "expected_role": "browser_chrome",
    }]


def test_execute_auto_action_routes_primary_chat_input_to_ui_automation(monkeypatch):
    fake_ui = FakeUIAutomation(_ui_snapshot())
    monkeypatch.setattr("action_execution.UIAutomationService", lambda: fake_ui)

    execute_auto_action(AutoActionPayload(
        action_type="focus_primary_chat_input",
        title="Focus Chat Input",
        summary="Focus the main chat input in Gemini.",
        app_name="Google Chrome",
        bundle_id="com.google.Chrome",
        target_label="Chat input",
        target_role="page_content",
        ui_index=0,
    ))

    assert fake_ui.calls == [{
        "action_type": "focus_primary_chat_input",
        "ui_index": 0,
        "expected_app_name": "Google Chrome",
        "expected_bundle_id": "com.google.Chrome",
        "expected_role": "page_content",
    }]


def test_execute_auto_action_routes_primary_chat_send_to_ui_automation(monkeypatch):
    fake_ui = FakeUIAutomation(_ui_snapshot())
    monkeypatch.setattr("action_execution.UIAutomationService", lambda: fake_ui)

    execute_auto_action(AutoActionPayload(
        action_type="press_primary_chat_send",
        title="Press Send",
        summary="Press the main send button in ChatGPT.",
        app_name="Google Chrome",
        bundle_id="com.google.Chrome",
        target_label="Send",
        target_role="page_content",
        ui_index=0,
    ))

    assert fake_ui.calls == [{
        "action_type": "press_primary_chat_send",
        "ui_index": 0,
        "expected_app_name": "Google Chrome",
        "expected_bundle_id": "com.google.Chrome",
        "expected_role": "page_content",
    }]


def test_execute_auto_action_routes_browser_reload_to_applescript(monkeypatch):
    calls = {}

    def fake_run(args, check, capture_output, text):
        calls["args"] = args
        calls["check"] = check
        calls["capture_output"] = capture_output
        calls["text"] = text
        return SimpleNamespace(returncode=0, stdout="ok\n", stderr="")

    monkeypatch.setattr("action_execution.subprocess.run", fake_run)

    execute_auto_action(AutoActionPayload(
        action_type="browser_reload",
        title="Reload Page",
        summary="Reload the current page in Safari.",
        app_name="Safari",
        bundle_id="com.apple.Safari",
    ))

    joined = " ".join(calls["args"])
    assert "osascript" in calls["args"][0]
    assert "do JavaScript" in joined
    assert "location.reload()" in joined
    assert calls["check"] is False
    assert calls["capture_output"] is True
    assert calls["text"] is True


def test_execute_auto_action_routes_pause_playback_to_media_pause_handler(monkeypatch):
    calls = {}

    def fake_run(args, check, capture_output, text):
        calls["args"] = args
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("action_execution.subprocess.run", fake_run)

    execute_auto_action(AutoActionPayload(
        action_type="pause_playback",
        title="Pause Playback",
        summary="Pause playback in Music.",
        app_name="Music",
        bundle_id="com.apple.Music",
    ))

    joined = " ".join(calls["args"])
    assert "Music" in joined
    assert "player state is not playing" in joined
    assert "pause" in joined


def test_execute_auto_action_falls_back_to_global_pause_for_unsupported_apps(monkeypatch):
    calls = []

    class FakeSystemControlService:
        def pause_playback(self):
            calls.append("pause_playback")

    monkeypatch.setattr("action_execution._experimental_media_controls_enabled", lambda: True)
    monkeypatch.setattr("action_execution.SystemControlService", lambda: FakeSystemControlService())

    execute_auto_action(AutoActionPayload(
        action_type="pause_playback",
        title="Pause Playback",
        summary="Pause playback using the current app when possible, otherwise use the global system pause control.",
        app_name="Notes",
        bundle_id="com.apple.Notes",
    ))

    assert calls == ["pause_playback"]


def test_execute_auto_action_does_not_use_global_pause_fallback_when_experimental_media_controls_are_off(monkeypatch):
    calls = []

    class FakeSystemControlService:
        def pause_playback(self):
            calls.append("pause_playback")

    monkeypatch.setattr("action_execution._experimental_media_controls_enabled", lambda: False)
    monkeypatch.setattr("action_execution.SystemControlService", lambda: FakeSystemControlService())

    with pytest.raises(
        RuntimeError,
        match="Pause fallback is limited to app-aware media handling while experimental media controls are off.",
    ):
        execute_auto_action(AutoActionPayload(
            action_type="pause_playback",
            title="Pause Playback",
            summary="Pause playback.",
            app_name="Notes",
            bundle_id="com.apple.Notes",
        ))

    assert calls == []


def test_execute_auto_action_falls_back_to_global_pause_when_browser_media_is_missing(monkeypatch):
    calls = []

    class FakeSystemControlService:
        def pause_playback(self):
            calls.append("pause_playback")

    monkeypatch.setattr("action_execution._experimental_media_controls_enabled", lambda: True)
    monkeypatch.setattr("action_execution.SystemControlService", lambda: FakeSystemControlService())
    monkeypatch.setattr("action_execution._execute_browser_javascript", lambda *_args, **_kwargs: "0")

    execute_auto_action(AutoActionPayload(
        action_type="pause_playback",
        title="Pause Playback",
        summary="Pause playback using the current app when possible, otherwise use the global system pause control.",
        app_name="Safari",
        bundle_id="com.apple.Safari",
    ))

    assert calls == ["pause_playback"]


def test_execute_auto_action_routes_global_play_pause_to_system_control_helper(monkeypatch):
    calls = []

    class FakeSystemControlService:
        def media_transport(self, action_type):
            calls.append(action_type)

    monkeypatch.setattr("action_execution._experimental_media_controls_enabled", lambda: True)
    monkeypatch.setattr("action_execution.SystemControlService", lambda: FakeSystemControlService())

    execute_auto_action(AutoActionPayload(
        action_type="play_pause",
        title="Play or Pause",
        summary="Play or pause the current system playback.",
        app_name="Notes",
        bundle_id="com.apple.Notes",
    ))

    assert calls == ["play_pause"]


def test_execute_auto_action_blocks_global_media_transport_when_experimental_controls_are_off(monkeypatch):
    calls = []

    class FakeSystemControlService:
        def media_transport(self, action_type):
            calls.append(action_type)

    monkeypatch.setattr("action_execution._experimental_media_controls_enabled", lambda: False)
    monkeypatch.setattr("action_execution.SystemControlService", lambda: FakeSystemControlService())

    with pytest.raises(
        RuntimeError,
        match="Experimental media controls are turned off in Advanced settings.",
    ):
        execute_auto_action(AutoActionPayload(
            action_type="play_pause",
            title="Play or Pause",
            summary="Play or pause the current system playback.",
            app_name="System",
            bundle_id=None,
        ))

    assert calls == []


def test_execute_auto_action_falls_back_to_music_when_global_media_helper_fails(monkeypatch):
    calls = {}

    class FakeSystemControlService:
        def media_transport(self, _action_type):
            raise SystemControlError("helper unavailable")

    def fake_run(args, check, capture_output, text):
        calls["args"] = args
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("action_execution._experimental_media_controls_enabled", lambda: True)
    monkeypatch.setattr("action_execution.SystemControlService", lambda: FakeSystemControlService())
    monkeypatch.setattr("action_execution.subprocess.run", fake_run)

    execute_auto_action(AutoActionPayload(
        action_type="play_pause",
        title="Play or Pause",
        summary="Play or pause the current system playback.",
        app_name="Music",
        bundle_id="com.apple.Music",
    ))

    joined = " ".join(calls["args"])
    assert "Music" in joined
    assert "playpause" in joined


def test_execute_auto_action_sets_exact_volume_and_clears_mute(monkeypatch):
    calls = {}

    def fake_run(args, check, capture_output, text):
        calls["args"] = args
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("action_execution.subprocess.run", fake_run)

    execute_auto_action(AutoActionPayload(
        action_type="set_volume_percent",
        title="Set Volume",
        summary="Set the system output volume to 55%.",
        app_name="System",
        value_percent=55,
    ))

    joined = " ".join(calls["args"])
    assert "set volume without output muted" in joined
    assert "set volume output volume targetVolume" in joined
    assert "set targetVolume to 55" in joined


def test_execute_auto_action_routes_set_brightness_to_system_control_helper(monkeypatch):
    calls = []

    class FakeSystemControlService:
        def set_brightness_percent(self, value_percent):
            calls.append(value_percent)

    monkeypatch.setattr("action_execution.SystemControlService", lambda: FakeSystemControlService())

    execute_auto_action(AutoActionPayload(
        action_type="set_brightness_percent",
        title="Set Brightness",
        summary="Set the main display brightness to 70%.",
        app_name="System",
        value_percent=70,
    ))

    assert calls == [70]


def test_execute_auto_action_unmutes_audio(monkeypatch):
    calls = {}

    def fake_run(args, check, capture_output, text):
        calls["args"] = args
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("action_execution.subprocess.run", fake_run)

    execute_auto_action(AutoActionPayload(
        action_type="unmute_audio",
        title="Unmute Audio",
        summary="Unmute system audio output.",
        app_name="System",
    ))

    assert "set volume without output muted" in " ".join(calls["args"])


def test_reviewed_action_builder_raises_when_no_safe_action_can_be_built(monkeypatch):
    builder = ReviewedActionBuilder(provider="lmstudio", model="demo", temperature=0.0)
    monkeypatch.setattr(builder, "_build_llm_plan", lambda *_args, **_kwargs: None)

    with pytest.raises(RuntimeError, match="safe desktop action"):
        builder.build(
            transcript="turn on do not disturb",
            context={},
            skill=DefaultSkills.ACTION_EXECUTION,
        )
