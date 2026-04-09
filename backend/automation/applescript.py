from __future__ import annotations

import subprocess
from typing import Optional


def escape_applescript_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def run_applescript_lines(
    lines: list[str],
    *,
    timeout_sec: Optional[float] = None,
    check: bool = False,
) -> str:
    command = ["osascript", *[item for line in lines for item in ("-e", line)]]
    kwargs = {
        "check": check,
        "capture_output": True,
        "text": True,
    }
    if timeout_sec is not None:
        kwargs["timeout"] = timeout_sec
    result = subprocess.run(command, **kwargs)
    if not check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "AppleScript execution failed."
        raise RuntimeError(detail)
    return result.stdout.strip()


def run_applescript_script(
    script: str,
    *,
    timeout_sec: Optional[float] = None,
    check: bool = True,
) -> str:
    return run_applescript_lines(
        [script],
        timeout_sec=timeout_sec,
        check=check,
    )
