from __future__ import annotations

import re
from typing import Optional

from automation.applescript import run_applescript_script


def validate_reviewed_applescript(action_type: str, script: str) -> Optional[str]:
    stripped_script = script.strip()
    if action_type == "open_app":
        if not re.search(
            r'^tell application(?: id)? ".+"\n(?:reopen\n)?activate\nend tell$',
            stripped_script,
            re.DOTALL,
        ):
            return "The reviewed app-open action did not match the allowlisted AppleScript shape."
        return None

    if action_type == "open_url":
        browser_navigation_pattern = re.compile(
            r'^tell application ".+"\nactivate\nif \(count of windows\) = 0 then make new (?:document|window)\nset URL of (?:current tab|active tab) of front window to ".+"\nend tell$',
            re.DOTALL,
        )
        if not re.search(r'^open location ".+"$', stripped_script, re.DOTALL) and not browser_navigation_pattern.search(stripped_script):
            return "The reviewed URL-open action did not match the allowlisted AppleScript shape."
        return None

    if action_type == "mail_draft":
        lowered_script = stripped_script.lower()
        if 'tell application "mail"' not in lowered_script:
            return "The reviewed mail action must target Mail."
        blocked_tokens = (
            "send",
            "system events",
            "do shell script",
            "keystroke",
            'tell application "messages"',
        )
        if any(token in lowered_script for token in blocked_tokens):
            return "The reviewed mail action contained a blocked automation token."
        if "make new outgoing message" not in lowered_script:
            return "The reviewed mail action must create a visible draft only."
        return None

    if action_type in {"youtube_open_first_result", "youtube_ensure_playing"}:
        browser_script_pattern = re.compile(
            r'^tell application ".+"\nactivate\nif \(count of windows\) = 0 then error ".+"\nexecute front window\'s active tab javascript ".+"\nend tell$',
            re.DOTALL,
        )
        if not browser_script_pattern.search(stripped_script):
            return "The reviewed YouTube browser action did not match the allowlisted AppleScript shape."

        lowered_script = stripped_script.lower()
        blocked_tokens = (
            "fetch(",
            "xmlhttprequest",
            "window.location",
            "document.write",
            "set timeout",
            "setinterval",
            "do shell script",
            "system events",
            "keystroke",
        )
        if any(token in lowered_script for token in blocked_tokens):
            return "The reviewed YouTube browser action contained a blocked automation token."

        if "youtube" not in lowered_script:
            return "The reviewed YouTube browser action must stay scoped to YouTube."

        if action_type == "youtube_open_first_result":
            if "video-title" not in lowered_script or ".click()" not in lowered_script:
                return "The reviewed YouTube result action must click the first video result only."
            return None

        if "queryselector('video')" not in lowered_script and 'queryselector("video")' not in lowered_script:
            return "The reviewed YouTube playback action must target the current video element."
        if "paused" not in lowered_script:
            return "The reviewed YouTube playback action must only start playback when the video is paused."
        return None

    return "The reviewed action type is not allowlisted."


def execute_reviewed_applescript(action_type: str, script: str) -> None:
    validation_error = validate_reviewed_applescript(action_type, script)
    if validation_error:
        raise RuntimeError(validation_error)
    run_applescript_script(script)
