import os
import shutil
import subprocess
import sys
import tempfile

import pytest

from ui_automation import UIAutomationService, classify_ui_automation_error


def _compile_applescript(lines: list[str]) -> subprocess.CompletedProcess[str]:
    fd, path = tempfile.mkstemp(suffix=".applescript")
    os.close(fd)
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines))
        return subprocess.run(
            ["osacompile", "-o", f"{path}.scpt", path],
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        if os.path.exists(path):
            os.unlink(path)
        if os.path.exists(f"{path}.scpt"):
            os.unlink(f"{path}.scpt")


def test_ui_automation_service_parses_frontmost_snapshot(monkeypatch):
    service = UIAutomationService()
    monkeypatch.setattr(
        service,
        "_run_applescript",
        lambda _lines: "Slack\x1ecom.tinyspeck.slackmacgap\x1e3\x1eAXSearchField\x1e\x1eSearch\x1e\x1eSearch\x1e\x1eSearch field\x1egeneric\x1e12,24\x1e220,40\x1f6\x1eAXButton\x1e\x1eSend\x1e\x1e\x1e\x1eButton\x1egeneric\x1e48,360\x1e28,28",
    )

    snapshot = service.capture_frontmost_ui_snapshot()

    assert snapshot.app_name == "Slack"
    assert snapshot.bundle_id == "com.tinyspeck.slackmacgap"
    assert len(snapshot.elements) == 2
    assert snapshot.elements[0].display_label == "Search"
    assert snapshot.elements[0].x == 12
    assert snapshot.elements[0].width == 220
    assert snapshot.elements[1].display_label == "Send"
    assert snapshot.elements[1].height == 28


def test_ui_automation_service_parses_focused_element_state(monkeypatch):
    service = UIAutomationService()
    monkeypatch.setattr(
        service,
        "_run_applescript",
        lambda _lines: "AXTextArea\x1e\x1eMessage\x1eAsk Gemini\x1eType something\x1etext area\x1epage_content",
    )

    focused = service.capture_focused_ui_element()

    assert focused.role == "AXTextArea"
    assert focused.label == "Message"
    assert focused.placeholder == "Type something"
    assert focused.source_class == "page_content"


def test_ui_automation_service_marks_browser_elements_as_page_content_or_browser_chrome(monkeypatch):
    service = UIAutomationService()
    monkeypatch.setattr(
        service,
        "_run_applescript",
        lambda _lines: "Google Chrome\x1ecom.google.Chrome\x1e3\x1eAXLink\x1e\x1ePricing\x1e\x1e\x1e\x1elink\x1epage_content\x1f6\x1eAXButton\x1e\x1eNew tab\x1e\x1e\x1e\x1ebutton\x1egeneric",
    )

    snapshot = service.capture_frontmost_ui_snapshot()

    assert snapshot.elements[0].role == "AXLink"
    assert snapshot.elements[0].source_class == "page_content"
    assert snapshot.elements[1].source_class == "browser_chrome"


def test_ui_automation_service_executes_press_without_coordinates(monkeypatch):
    service = UIAutomationService()
    captured = {}

    def fake_run(lines):
        captured["lines"] = lines
        return ""

    monkeypatch.setattr(service, "_run_applescript", fake_run)

    service.execute_auto_ui_action(
        action_type="press_button",
        ui_index=8,
        expected_app_name="Mail",
        expected_bundle_id="com.apple.mail",
        expected_role="AXButton",
    )

    joined = "\n".join(captured["lines"])
    assert 'perform action "AXPress" of targetElement' in joined
    assert "click at" not in joined.lower()
    assert "mouse" not in joined.lower()


def test_ui_automation_service_routes_primary_chat_send_without_coordinates(monkeypatch):
    service = UIAutomationService()
    captured = {}

    def fake_run(lines):
        captured["lines"] = lines
        return ""

    monkeypatch.setattr(service, "_run_applescript", fake_run)

    service.execute_auto_ui_action(
        action_type="press_primary_chat_send",
        ui_index=0,
        expected_app_name="Google Chrome",
        expected_bundle_id="com.google.Chrome",
        expected_role="page_content",
    )

    joined = "\n".join(captured["lines"])
    assert 'perform action "AXPress" of targetElement' in joined
    assert "click at" not in joined.lower()
    assert "mouse" not in joined.lower()


def test_ui_automation_service_verifies_chat_input_focus_stays_on_page(monkeypatch):
    service = UIAutomationService()
    responses = iter([
        "",
        "AXSearchField\x1e\x1eAddress and search bar\x1e\x1eSearch Google or type a URL\x1esearch field\x1ebrowser_chrome",
    ])

    monkeypatch.setattr(service, "_run_applescript", lambda _lines: next(responses))

    with pytest.raises(RuntimeError, match="browser chrome instead of the page chat input"):
        service.execute_auto_ui_action(
            action_type="focus_primary_chat_input",
            ui_index=0,
            expected_app_name="Google Chrome",
            expected_bundle_id="com.google.Chrome",
            expected_role="page_content",
        )


@pytest.mark.skipif(sys.platform != "darwin" or shutil.which("osacompile") is None, reason="macOS AppleScript compiler required")
def test_ui_automation_snapshot_script_compiles():
    service = UIAutomationService()

    result = _compile_applescript(service._build_snapshot_applescript())

    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(sys.platform != "darwin" or shutil.which("osacompile") is None, reason="macOS AppleScript compiler required")
def test_ui_automation_execute_script_compiles():
    service = UIAutomationService()

    result = _compile_applescript(service._build_execute_action_applescript(
        action_type="focus_field",
        ui_index=3,
        expected_app_name="Slack",
        expected_bundle_id="com.tinyspeck.slackmacgap",
        expected_role="AXSearchField",
    ))

    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(sys.platform != "darwin" or shutil.which("osacompile") is None, reason="macOS AppleScript compiler required")
def test_ui_automation_browser_address_bar_script_compiles():
    service = UIAutomationService()

    result = _compile_applescript(service._build_focus_browser_address_bar_applescript(
        expected_app_name="Google Chrome",
        expected_bundle_id="com.google.Chrome",
    ))

    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(sys.platform != "darwin" or shutil.which("osacompile") is None, reason="macOS AppleScript compiler required")
def test_ui_automation_primary_chat_input_script_compiles():
    service = UIAutomationService()

    result = _compile_applescript(service._build_focus_primary_chat_input_applescript(
        expected_app_name="Google Chrome",
        expected_bundle_id="com.google.Chrome",
    ))

    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(sys.platform != "darwin" or shutil.which("osacompile") is None, reason="macOS AppleScript compiler required")
def test_ui_automation_focused_element_script_compiles():
    service = UIAutomationService()

    result = _compile_applescript(service._build_focused_element_applescript())

    assert result.returncode == 0, result.stderr


def test_ui_automation_primary_chat_input_script_does_not_fallback_to_root_items():
    service = UIAutomationService()

    joined = "\n".join(service._build_focus_primary_chat_input_applescript(
        expected_app_name="Google Chrome",
        expected_bundle_id="com.google.Chrome",
    ))

    assert "findFirstTextInput(rootItems" not in joined


@pytest.mark.skipif(sys.platform != "darwin" or shutil.which("osacompile") is None, reason="macOS AppleScript compiler required")
def test_ui_automation_primary_chat_send_script_compiles():
    service = UIAutomationService()

    result = _compile_applescript(service._build_press_primary_chat_send_applescript(
        expected_app_name="Google Chrome",
        expected_bundle_id="com.google.Chrome",
    ))

    assert result.returncode == 0, result.stderr


def test_classify_ui_automation_error_detects_permission_failures():
    assert classify_ui_automation_error("System Events got an error: Not permitted") == "permission"


def test_classify_ui_automation_error_detects_timeouts():
    assert classify_ui_automation_error("Command timed out after 2.5 seconds") == "timeout"


def test_classify_ui_automation_error_detects_compile_failures():
    assert classify_ui_automation_error('1032:1033: syntax error: Expected end of line but found “"”. (-2741)') == "script_compile"
