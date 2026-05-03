from __future__ import annotations

import shlex
from pathlib import Path
from typing import Iterable, Sequence

from local_task_shell.models import CommandPolicyDecision
from utils.paths import get_app_home


DISALLOWED_EXECUTABLES = {
    "curl",
    "wget",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "nc",
    "ncat",
    "netcat",
    "telnet",
    "ftp",
    "ping",
    "traceroute",
    "dig",
    "nslookup",
    "host",
    "ifconfig",
    "ipconfig",
    "brew",
    "apt",
    "apt-get",
    "yum",
    "dnf",
    "pip",
    "pip3",
    "uvx",
    "osascript",
    "bash",
    "sh",
    "zsh",
    "fish",
}
ALLOWED_EXECUTABLES = {
    "pwd",
    "ls",
    "find",
    "rg",
    "grep",
    "sed",
    "awk",
    "cat",
    "head",
    "tail",
    "wc",
    "cut",
    "sort",
    "uniq",
    "tr",
    "git",
    "pytest",
    "python",
    "python3",
    "ruff",
    "mypy",
    "npm",
    "pnpm",
    "yarn",
    "uv",
}
DISALLOWED_SHELL_OPERATORS = ("&&", "||", "|", ";", ">", ">>", "<", "<<", "$(", "`")
BLOCKED_GIT_SUBCOMMANDS = {
    "push",
    "pull",
    "fetch",
    "clone",
    "remote",
    "submodule",
    "ls-remote",
    "request-pull",
}
BLOCKED_PACKAGE_MANAGER_SUBCOMMANDS = {
    "install",
    "add",
    "update",
    "upgrade",
    "publish",
    "link",
    "unlink",
    "login",
    "logout",
    "cache",
    "create",
    "dlx",
    "exec",
    "x",
}
ALLOWED_PACKAGE_MANAGER_SCRIPTS = {
    "check",
    "lint",
    "test",
    "typecheck",
    "verify",
    "validate",
}
BLOCKED_WRITE_FLAGS = {
    "--fix",
    "--fix-type",
    "--write",
    "--watch",
}
READ_ONLY_EXECUTABLES = {
    "pwd",
    "ls",
    "find",
    "rg",
    "grep",
    "sed",
    "awk",
    "cat",
    "head",
    "tail",
    "wc",
    "cut",
    "sort",
    "uniq",
    "tr",
}
READ_ONLY_GIT_SUBCOMMANDS = {
    "status",
    "diff",
    "show",
    "log",
    "branch",
    "rev-parse",
}


def default_allowed_roots(extra_roots: Sequence[str] | None = None) -> list[Path]:
    roots = {
        Path.cwd().resolve(),
        get_app_home().resolve(),
    }
    for raw_root in extra_roots or []:
        if not raw_root:
            continue
        roots.add(Path(raw_root).expanduser().resolve())
    return sorted(roots, key=lambda path: str(path))


def _normalize_cwd(cwd: str | None, allowed_roots: Sequence[Path]) -> tuple[Path, str | None]:
    raw_cwd = cwd.strip() if cwd else ""
    candidate = Path(raw_cwd).expanduser().resolve() if raw_cwd else Path.cwd().resolve()
    for root in allowed_roots:
        try:
            candidate.relative_to(root)
            return candidate, None
        except ValueError:
            continue
    return candidate, "The requested working directory is outside the allowed local task roots."


def _contains_disallowed_shell_operators(command: str) -> bool:
    return any(operator in command for operator in DISALLOWED_SHELL_OPERATORS)


def _resolve_risk_level(executable: str, argv: Sequence[str]) -> tuple[str, bool]:
    if executable in READ_ONLY_EXECUTABLES:
        return "low", True
    if executable == "git" and len(argv) > 1 and argv[1] in READ_ONLY_GIT_SUBCOMMANDS:
        return "low", True
    if executable in {"pytest", "ruff", "mypy"}:
        return "low", True
    if executable in {"python", "python3"} and list(argv[:3]) in (["python", "-m", "pytest"], ["python3", "-m", "pytest"]):
        return "low", True
    if executable == "uv" and _blocked_uv(argv) is None:
        return "low", True
    if executable in {"npm", "pnpm", "yarn"} and _blocked_package_runner(executable, argv) is None:
        return "low", True
    return "medium", False


def _contains_blocked_write_flags(argv: Sequence[str]) -> bool:
    return any(arg in BLOCKED_WRITE_FLAGS or any(arg.startswith(f"{flag}=") for flag in BLOCKED_WRITE_FLAGS) for arg in argv)


def _blocked_python(argv: Sequence[str]) -> str | None:
    if len(argv) < 3 or argv[1] != "-m":
        return "Only module-based Python test invocations are allowed in the local task shell."
    module_name = argv[2]
    if module_name not in {"pytest", "unittest", "compileall"}:
        return f"Python module '{module_name}' is not allowlisted for local task execution."
    return None


def _blocked_git(argv: Sequence[str]) -> str | None:
    if len(argv) < 2:
        return "Only explicit read-only git subcommands are allowed in the local task shell."
    subcommand = argv[1].lower()
    if subcommand in BLOCKED_GIT_SUBCOMMANDS:
        return f"Git subcommand '{subcommand}' is blocked because it may contact a remote."
    if subcommand not in READ_ONLY_GIT_SUBCOMMANDS:
        return f"Git subcommand '{subcommand}' is not allowlisted for local task execution."
    if _contains_blocked_write_flags(argv[2:]):
        return f"Git subcommand '{subcommand}' includes write-oriented flags that are blocked."
    if subcommand == "branch":
        branch_args = list(argv[2:])
        if not branch_args:
            return None
        if branch_args == ["--show-current"]:
            return None
        if branch_args[0] == "--list":
            return None
        return "Only read-only 'git branch', 'git branch --list', and 'git branch --show-current' are allowed."
    return None


def _blocked_package_runner(executable: str, argv: Sequence[str]) -> str | None:
    if len(argv) < 2:
        return f"{executable} requires an explicit allowlisted test or verification command."

    subcommand = argv[1].lower()
    if subcommand in BLOCKED_PACKAGE_MANAGER_SUBCOMMANDS:
        return f"{executable} subcommand '{argv[1]}' is blocked in the local task shell."
    if _contains_blocked_write_flags(argv[2:]):
        return f"{executable} command includes write-oriented flags that are blocked."

    if executable == "npm":
        if subcommand == "run":
            if len(argv) < 3:
                return "npm run requires an allowlisted script name in the local task shell."
            script_name = argv[2].lower()
        elif subcommand == "test":
            script_name = "test"
        else:
            return f"npm subcommand '{argv[1]}' is not allowlisted for local task execution."
    elif executable == "pnpm":
        if subcommand == "run":
            if len(argv) < 3:
                return "pnpm run requires an allowlisted script name in the local task shell."
            script_name = argv[2].lower()
        else:
            script_name = subcommand
    else:
        if subcommand == "run":
            if len(argv) < 3:
                return "yarn run requires an allowlisted script name in the local task shell."
            script_name = argv[2].lower()
        else:
            script_name = subcommand

    if script_name not in ALLOWED_PACKAGE_MANAGER_SCRIPTS:
        return f"{executable} script '{script_name}' is not allowlisted for local task execution."
    return None


def _blocked_uv(argv: Sequence[str]) -> str | None:
    if list(argv[:2]) != ["uv", "run"]:
        return "Only 'uv run ...' commands are allowed in the local task shell."
    if len(argv) < 3:
        return "uv run requires an allowlisted test or verification command."
    if _contains_blocked_write_flags(argv[3:]):
        return "uv run command includes write-oriented flags that are blocked."

    runner = Path(argv[2]).name
    if runner in {"pytest", "mypy"}:
        return None
    if runner == "ruff" and (len(argv) == 3 or argv[3] == "check"):
        return None
    if runner in {"python", "python3"} and list(argv[2:5]) in (["python", "-m", "pytest"], ["python3", "-m", "pytest"]):
        return None
    return f"uv run target '{argv[2]}' is not allowlisted for local task execution."


def evaluate_local_command_policy(
    command: str,
    *,
    cwd: str | None = None,
    allowed_roots: Sequence[Path] | None = None,
) -> CommandPolicyDecision:
    normalized_command = (command or "").strip()
    roots = list(allowed_roots or default_allowed_roots())
    normalized_cwd, cwd_error = _normalize_cwd(cwd, roots)
    if cwd_error:
        return CommandPolicyDecision(allowed=False, reason=cwd_error, cwd=str(normalized_cwd))

    if not normalized_command:
        return CommandPolicyDecision(
            allowed=False,
            reason="The local task shell requires a non-empty command.",
            cwd=str(normalized_cwd),
        )

    if _contains_disallowed_shell_operators(normalized_command):
        return CommandPolicyDecision(
            allowed=False,
            reason="Shell chaining, piping, redirection, and command substitution are blocked in the local task shell.",
            cwd=str(normalized_cwd),
        )

    try:
        argv = shlex.split(normalized_command, posix=True)
    except ValueError as exc:
        return CommandPolicyDecision(
            allowed=False,
            reason=f"Command parsing failed: {exc}",
            cwd=str(normalized_cwd),
        )

    if not argv:
        return CommandPolicyDecision(
            allowed=False,
            reason="The local task shell could not parse a command to execute.",
            cwd=str(normalized_cwd),
        )

    executable = Path(argv[0]).name
    lowered_executable = executable.lower()

    if lowered_executable in DISALLOWED_EXECUTABLES:
        return CommandPolicyDecision(
            allowed=False,
            reason=f"Executable '{executable}' is blocked because it can access the network or escape the local-only policy.",
            executable=executable,
            argv=argv,
            normalized_command=normalized_command,
            cwd=str(normalized_cwd),
        )

    if lowered_executable not in ALLOWED_EXECUTABLES:
        return CommandPolicyDecision(
            allowed=False,
            reason=f"Executable '{executable}' is not allowlisted for the local task shell.",
            executable=executable,
            argv=argv,
            normalized_command=normalized_command,
            cwd=str(normalized_cwd),
        )

    if lowered_executable == "git":
        blocked_reason = _blocked_git(argv)
        if blocked_reason:
            return CommandPolicyDecision(
                allowed=False,
                reason=blocked_reason,
                executable=executable,
                argv=argv,
                normalized_command=normalized_command,
                cwd=str(normalized_cwd),
            )

    if lowered_executable in {"npm", "pnpm", "yarn"}:
        blocked_reason = _blocked_package_runner(lowered_executable, argv)
        if blocked_reason:
            return CommandPolicyDecision(
                allowed=False,
                reason=blocked_reason,
                executable=executable,
                argv=argv,
                normalized_command=normalized_command,
                cwd=str(normalized_cwd),
            )

    if lowered_executable in {"python", "python3"}:
        blocked_reason = _blocked_python(argv)
        if blocked_reason:
            return CommandPolicyDecision(
                allowed=False,
                reason=blocked_reason,
                executable=executable,
                argv=argv,
                normalized_command=normalized_command,
                cwd=str(normalized_cwd),
            )

    if lowered_executable == "uv":
        blocked_reason = _blocked_uv(argv)
        if blocked_reason:
            return CommandPolicyDecision(
                allowed=False,
                reason=blocked_reason,
                executable=executable,
                argv=argv,
                normalized_command=normalized_command,
                cwd=str(normalized_cwd),
            )

    risk_level, read_only = _resolve_risk_level(lowered_executable, argv)
    return CommandPolicyDecision(
        allowed=True,
        executable=executable,
        argv=argv,
        normalized_command=normalized_command,
        cwd=str(normalized_cwd),
        risk_level=risk_level,  # type: ignore[arg-type]
        read_only=read_only,
    )


TASK_REQUEST_PREFIXES: tuple[str, ...] = (
    "run ",
    "execute ",
    "please run ",
    "please execute ",
    "locally run ",
    "locally execute ",
)


def normalize_task_command_request(value: str) -> tuple[str, list[str]]:
    working = str(value or "").strip()
    operations: list[str] = []
    lowered = working.lower()
    for prefix in TASK_REQUEST_PREFIXES:
        if lowered.startswith(prefix):
            working = working[len(prefix):].strip()
            operations.append("strip_task_request_prefix")
            break
    return working, operations
