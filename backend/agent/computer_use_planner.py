from __future__ import annotations

import json
import re
import shlex
from typing import Any, Literal, Optional
from urllib.parse import quote_plus

from pydantic import BaseModel

try:
    from langchain_core.prompts import ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate
    COMPUTER_USE_PROMPT_IMPORT_ERROR: Optional[Exception] = None
except Exception as exc:  # pragma: no cover - exercised indirectly when prompt deps are absent
    ChatPromptTemplate = None
    HumanMessagePromptTemplate = None
    SystemMessagePromptTemplate = None
    COMPUTER_USE_PROMPT_IMPORT_ERROR = exc

from local_task_shell.policy import (
    ALLOWED_EXECUTABLES,
    BLOCKED_GIT_SUBCOMMANDS,
    BLOCKED_PACKAGE_MANAGER_SUBCOMMANDS,
    DISALLOWED_EXECUTABLES,
    DISALLOWED_SHELL_OPERATORS,
)
from imperative_phrases import normalize_imperative_phrase
from providers.llm_factory import LLMFactory
from utils.logger import get_logger


logger = get_logger()

ComputerUseTrigger = Literal["explicit_mode", "action_phrase"]
ComputerUsePlanKind = Literal["desktop_action", "local_task", "multi_step", "refusal"]
ComputerUsePlanMode = Literal["single_step", "multi_step"]
ComputerUseStepKind = Literal["desktop_action", "shell_command"]

DESKTOP_ACTION_PATTERN = re.compile(
    r"^(?:open(?: up)?|launch|switch to|bring up|focus(?: on)?|go to|visit|navigate to|click|press|tap|choose|hit|"
    r"play(?:\s*/\s*pause|\s+pause)?|pause|next(?: track| song)?|previous(?: track| song)?|skip(?: track| song)?|"
    r"mute|unmute|volume(?: up| down)?|brightness(?: up| down)?|reload|refresh|go back|go forward)\b",
    re.IGNORECASE,
)
URL_OR_APP_HINT_PATTERN = re.compile(
    r"\b(?:https?://|[A-Za-z0-9.-]+\.[A-Za-z]{2,}|dot\s+[A-Za-z0-9-]+|address bar|send button|chat input|browser|safari|chrome|finder|mail)\b",
    re.IGNORECASE,
)
REPO_TASK_PATTERN = re.compile(
    r"^(?:find|search(?: for)?|look for|grep(?: for)?|browse(?: through)?|inspect|scan|list|show|read|display|check|run|diff)\b",
    re.IGNORECASE,
)
REPO_TASK_HINT_PATTERN = re.compile(
    r"\b(?:repo|repository|workspace|project|codebase|folder|directory|file|files|symbol|reference|references|test|tests|diff|status|log|source)\b",
    re.IGNORECASE,
)
QUOTED_TEXT_PATTERN = re.compile(r"['\"]([^'\"]+)['\"]")
FILE_NAME_PATTERN = re.compile(
    r"\b[A-Za-z0-9._-]+\.(?:py|ts|tsx|js|jsx|java|go|rb|rs|php|swift|kt|json|ya?ml|toml|md|sql|sh|zsh|html|css|scss|c|cc|cpp|h|hpp)\b",
    re.IGNORECASE,
)
SEARCH_FOR_PATTERN = re.compile(
    r"\b(?:search(?: the)?(?: repo| repository| workspace| project| codebase| file| files)?(?: for)?|"
    r"find(?: in (?:the )?(?:repo|repository|workspace|project|codebase|file|files))?(?: me)?|"
    r"look for|grep(?: for)?|browse(?: through)?(?: the)?(?: repo|repository|workspace|project|codebase|file|files)?(?: and)? find(?: me)?)\s+(.+)$",
    re.IGNORECASE,
)
LIST_FILES_PATTERN = re.compile(r"^(?:list|show)\s+(?:the\s+)?files\b", re.IGNORECASE)
READ_FILE_PATTERN = re.compile(
    r"^(?:show|read|display|open|cat)\s+(?:me\s+)?(?:(?:the\s+)?contents?\s+of\s+)?(.+)$",
    re.IGNORECASE,
)
TESTS_PATTERN = re.compile(r"^(?:run|execute|check)\s+(?:the\s+)?tests?\b(?:\s+for\s+(.+))?$", re.IGNORECASE)
GIT_DIFF_PATTERN = re.compile(r"^(?:show|check|open)?\s*(?:me\s+)?(?:the\s+)?git diff(?:\s+for\s+(.+))?$", re.IGNORECASE)
GIT_STATUS_PATTERN = re.compile(r"^(?:show|check|open)?\s*(?:me\s+)?(?:the\s+)?git status$", re.IGNORECASE)
FIND_FILE_PATTERN = re.compile(r"^(?:find|search for|look for)\s+(?:the\s+)?file\s+(?:named|called)?\s*(.+)$", re.IGNORECASE)
STOPWORDS = {
    "the",
    "a",
    "an",
    "this",
    "that",
    "it",
    "me",
    "through",
    "and",
    "inside",
    "in",
    "from",
    "of",
}
MULTISPACE_PATTERN = re.compile(r"\s+")
FILLER_PATTERN = re.compile(r"\b(?:uh|um|erm|hmm|mm)\b", re.IGNORECASE)
MULTI_STEP_CONNECTOR_PATTERN = re.compile(
    r"\b(?:and then|then|after that|afterwards|next|and)\b",
    re.IGNORECASE,
)
MODEL_MULTI_STEP_CONNECTOR_PATTERN = re.compile(
    r"\b(?:and then|then|after that|afterwards|next)\b",
    re.IGNORECASE,
)
YOUTUBE_PLAY_PATTERN = re.compile(
    r"^(?:(?:open|launch)\s+(?P<browser>google chrome|chrome|brave(?: browser)?|microsoft edge|edge|arc)\s+(?:and(?: then)?|then)\s+)?play\s+(?P<query>.+?)\s+on\s+youtube\b",
    re.IGNORECASE,
)
YOUTUBE_QUERY_CLEANUP_PATTERN = re.compile(r"\s+(?:on|in)\s+youtube\b.*$", re.IGNORECASE)
CLAUSE_SPLIT_PATTERN = re.compile(
    r"\s*(?:,?\s+(?:and then|then|after that|afterwards|next)\s+|,\s*then\s+|\s+and\s+)\s*",
    re.IGNORECASE,
)
COMPUTER_USE_MODEL_STEP_KINDS = '"desktop_action", "shell_command"'
COMPUTER_USE_MODEL_TIMEOUT_SECONDS = 3.0


class ComputerUsePlannedStep(BaseModel):
    kind: ComputerUseStepKind
    request: str
    title: Optional[str] = None
    summary: Optional[str] = None
    action_type: Optional[str] = None
    app_name: Optional[str] = None
    url: Optional[str] = None
    browser_app_name: Optional[str] = None
    site: Optional[str] = None
    query: Optional[str] = None


class ComputerUsePlan(BaseModel):
    kind: ComputerUsePlanKind
    trigger: ComputerUseTrigger
    reason: str
    mode: ComputerUsePlanMode = "single_step"
    command: Optional[str] = None
    plan_summary: Optional[str] = None
    steps: list[ComputerUsePlannedStep] = []
    refusal_message: Optional[str] = None
    model_attempted: bool = False
    model_error: Optional[str] = None


def normalize_whitespace(text: str) -> str:
    return MULTISPACE_PATTERN.sub(" ", str(text or "")).strip()


def normalize_command_text(text: str) -> str:
    working = str(text or "").strip()
    working = working.replace("\u2018", "'").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    working = normalize_whitespace(FILLER_PATTERN.sub(" ", working))
    return working.rstrip(".,;:")


def is_desktop_action_phrase(transcript: str) -> bool:
    normalized = normalize_imperative_phrase(transcript)
    if not normalized:
        return False
    if not DESKTOP_ACTION_PATTERN.match(normalized):
        return False
    if REPO_TASK_HINT_PATTERN.search(normalized) and not URL_OR_APP_HINT_PATTERN.search(normalized):
        return False
    return True


def is_repo_task_phrase(transcript: str) -> bool:
    normalized = normalize_whitespace(transcript)
    if not normalized:
        return False
    if len(normalized) > 160 or len(normalized.split()) > 20:
        return False
    return bool(REPO_TASK_PATTERN.match(normalized) and REPO_TASK_HINT_PATTERN.search(normalized))


def is_compound_imperative_phrase(transcript: str, *, trigger: ComputerUseTrigger) -> bool:
    normalized = normalize_imperative_phrase(transcript)
    if not normalized or not MULTI_STEP_CONNECTOR_PATTERN.search(normalized):
        return False

    word_count = len(normalized.split())
    if trigger == "action_phrase":
        if len(normalized) > 180 or word_count > 24:
            return False
    elif len(normalized) > 260 or word_count > 40:
        return False

    first_clause = CLAUSE_SPLIT_PATTERN.split(normalized, maxsplit=1)[0].strip()
    if not first_clause:
        return False
    return bool(is_desktop_action_phrase(first_clause) or is_repo_task_phrase(first_clause) or REPO_TASK_PATTERN.match(first_clause))


def detect_computer_use_trigger(
    *,
    transcript: str,
    requested_skill_id: str,
    effective_skill_id: str,
) -> ComputerUseTrigger | None:
    if requested_skill_id == "system_computer_use" or effective_skill_id == "system_computer_use":
        return "explicit_mode"
    if effective_skill_id in {"system_action_execution", "system_local_task"}:
        return None

    normalized = normalize_whitespace(transcript)
    normalized_imperative = normalize_imperative_phrase(normalized)
    if not normalized:
        return None

    word_count = len(normalized_imperative.split())
    if (
        len(normalized_imperative) <= 120
        and word_count <= 16
        and (is_desktop_action_phrase(normalized_imperative) or is_repo_task_phrase(normalized))
    ):
        return "action_phrase"

    if is_compound_imperative_phrase(normalized_imperative, trigger="action_phrase"):
        return "action_phrase"

    return None


class ComputerUsePlanner:
    def __init__(
        self,
        *,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        temperature: float = 0.0,
    ) -> None:
        self.provider = str(provider or "").strip().lower() or None
        self.model = str(model or "").strip() or None
        self.temperature = float(temperature)

    def plan(
        self,
        *,
        transcript: str,
        context: dict[str, Any],
        trigger: ComputerUseTrigger,
        selection_text: Optional[str] = None,
        clipboard_text: Optional[str] = None,
    ) -> ComputerUsePlan:
        normalized = normalize_imperative_phrase(transcript)
        if not normalized:
            return ComputerUsePlan(
                kind="refusal",
                trigger=trigger,
                reason="Computer Use needs a concrete task request.",
                refusal_message="Computer Use needs a specific task like opening an app, searching the repo, or running a reviewed local command.",
            )

        youtube_plan = self._plan_youtube_browser_media(normalized, trigger=trigger)
        if youtube_plan is not None:
            return youtube_plan

        shell_plan = self._plan_shell_command(normalized, trigger=trigger)
        if shell_plan is not None:
            return shell_plan

        deterministic_multi_step_plan = self._plan_multi_step_deterministically(
            normalized,
            trigger=trigger,
            context=context,
            selection_text=selection_text,
            clipboard_text=clipboard_text,
        )
        if deterministic_multi_step_plan is not None:
            return deterministic_multi_step_plan

        model_multi_step_plan = self._plan_multi_step_with_model(
            normalized,
            trigger=trigger,
            context=context,
            selection_text=selection_text,
            clipboard_text=clipboard_text,
        )
        if model_multi_step_plan is not None:
            return model_multi_step_plan

        local_task_command = self._resolve_local_task_command(
            normalized,
            context=context,
            selection_text=selection_text,
            clipboard_text=clipboard_text,
        )
        if local_task_command is not None:
            return ComputerUsePlan(
                kind="local_task",
                trigger=trigger,
                reason="Repo or file inspection request routed into the reviewed local task shell.",
                command=local_task_command,
            )

        if is_desktop_action_phrase(normalized):
            return ComputerUsePlan(
                kind="desktop_action",
                trigger=trigger,
                reason="Imperative app or UI request routed into the SteerVox desktop-action stack.",
            )

        return ComputerUsePlan(
            kind="refusal",
            trigger=trigger,
            reason="Computer Use could not resolve the request into a supported local task or desktop action.",
            refusal_message=(
                "Computer Use can currently open apps, navigate supported browser surfaces, "
                "control bounded desktop actions, and run reviewed local repo/file commands."
            ),
        )

    def _plan_youtube_browser_media(
        self,
        transcript: str,
        *,
        trigger: ComputerUseTrigger,
    ) -> ComputerUsePlan | None:
        match = YOUTUBE_PLAY_PATTERN.match(transcript)
        if not match:
            return None

        browser_name = self._normalize_browser_name(match.group("browser") or "")
        query = normalize_whitespace(YOUTUBE_QUERY_CLEANUP_PATTERN.sub("", match.group("query") or "")).rstrip(".,;:")
        if not query:
            return ComputerUsePlan(
                kind="refusal",
                trigger=trigger,
                reason="Computer Use needs a search query before it can open YouTube and start playback.",
                refusal_message="Say what to play on YouTube, for example: play indie songs on YouTube.",
            )

        if browser_name not in {"Google Chrome", "Brave Browser", "Microsoft Edge"}:
            return ComputerUsePlan(
                kind="refusal",
                trigger=trigger,
                reason=f"Bounded YouTube playback is only implemented for Google Chrome, Brave Browser, and Microsoft Edge right now. {browser_name} is not supported yet.",
                refusal_message=(
                    f"YouTube playback automation currently supports Google Chrome, Brave Browser, and Microsoft Edge. {browser_name} is not supported yet."
                ),
            )

        youtube_url = f"https://www.youtube.com/results?search_query={quote_plus(query)}"
        return ComputerUsePlan(
            kind="multi_step",
            mode="multi_step",
            trigger=trigger,
            reason="YouTube playback request resolved into a bounded reviewed browser plan.",
            plan_summary=f"Open {browser_name}, search YouTube for {query}, open the first result, and start playback if needed.",
            steps=[
                ComputerUsePlannedStep(
                    kind="desktop_action",
                    request=f"open {browser_name}",
                    title="Open browser",
                    summary=f"Open {browser_name}.",
                    action_type="open_app",
                    app_name=browser_name,
                ),
                ComputerUsePlannedStep(
                    kind="desktop_action",
                    request=f"open YouTube results for {query}",
                    title="Open YouTube search",
                    summary=f"Open YouTube search results for {query} in {browser_name}.",
                    action_type="open_url",
                    app_name=browser_name,
                    browser_app_name=browser_name,
                    url=youtube_url,
                    site="youtube",
                    query=query,
                ),
                ComputerUsePlannedStep(
                    kind="desktop_action",
                    request="open the first YouTube result",
                    title="Open first result",
                    summary="Open the first YouTube video result.",
                    action_type="youtube_open_first_result",
                    app_name=browser_name,
                    browser_app_name=browser_name,
                    site="youtube",
                    query=query,
                ),
                ComputerUsePlannedStep(
                    kind="desktop_action",
                    request="start playback if the video is paused",
                    title="Ensure playback",
                    summary="Start playback only if the current YouTube video is paused.",
                    action_type="youtube_ensure_playing",
                    app_name=browser_name,
                    browser_app_name=browser_name,
                    site="youtube",
                    query=query,
                ),
            ],
        )

    def _plan_multi_step_deterministically(
        self,
        transcript: str,
        *,
        trigger: ComputerUseTrigger,
        context: dict[str, Any],
        selection_text: Optional[str],
        clipboard_text: Optional[str],
    ) -> ComputerUsePlan | None:
        if not is_compound_imperative_phrase(transcript, trigger=trigger):
            return None
        if self._resolve_local_task_command(
            transcript,
            context=context,
            selection_text=selection_text,
            clipboard_text=clipboard_text,
        ) is not None:
            return None

        clauses = self._split_multi_step_clauses(transcript)
        if len(clauses) < 2:
            return None

        steps: list[ComputerUsePlannedStep] = []
        for clause in clauses:
            step = self._resolve_clause_to_step(
                clause,
                context=context,
                selection_text=selection_text,
                clipboard_text=clipboard_text,
            )
            if step is None:
                return None
            steps.append(step)

        return ComputerUsePlan(
            kind="multi_step",
            mode="multi_step",
            trigger=trigger,
            reason="Compound imperative request resolved into a bounded multi-step local plan.",
            plan_summary=f"Execute {len(steps)} reviewed steps for: {transcript}",
            steps=steps,
        )

    def _plan_multi_step_with_model(
        self,
        transcript: str,
        *,
        trigger: ComputerUseTrigger,
        context: dict[str, Any],
        selection_text: Optional[str],
        clipboard_text: Optional[str],
    ) -> ComputerUsePlan | None:
        if not self._should_attempt_model_multistep_planning(transcript, trigger=trigger):
            return None
        if COMPUTER_USE_PROMPT_IMPORT_ERROR is not None or not self.provider or not self.model:
            return None

        try:
            llm = LLMFactory.get_llm(
                self.provider,
                self.model,
                min(self.temperature, 0.1),
                timeout=COMPUTER_USE_MODEL_TIMEOUT_SECONDS,
                max_retries=0,
                max_tokens=320,
            )
        except Exception as exc:
            logger.warning("[ComputerUsePlanner] Multi-step planner model unavailable: %s", exc)
            return None

        prompt = ChatPromptTemplate.from_messages([
            SystemMessagePromptTemplate.from_template(
                """You decompose a bounded local computer-use request into safe SteerVox steps.

Return strict JSON only with keys:
- plan_summary: string
- steps: array of step objects

Each step object must contain:
- kind: one of {step_kinds}
- request: string
- title: short string
- summary: short string

Rules:
- Return at most 5 steps.
- Only produce step kinds from the allowlist.
- desktop_action steps must be bounded app, browser, or UI actions SteerVox can already perform.
- shell_command steps must stay local-only and must not contain network access, package installs, remote git, pipes, chaining, or redirection.
- Do not add file-edit steps.
- Do not add arbitrary browsing, drag-and-drop, or freeform typing sequences.
- If the request cannot be safely decomposed, return {"plan_summary":"","steps":[]}.
"""
            ),
            HumanMessagePromptTemplate.from_template(
                """Transcript: {transcript}

Context:
{context_json}

Selection text:
{selection_text}

Clipboard text:
{clipboard_text}
"""
            ),
        ])

        chain = prompt | llm
        try:
            response = chain.invoke({
                "transcript": transcript,
                "context_json": json.dumps(context, ensure_ascii=True, sort_keys=True),
                "selection_text": normalize_whitespace(selection_text or "") or "none",
                "clipboard_text": normalize_whitespace(clipboard_text or "") or "none",
                "step_kinds": COMPUTER_USE_MODEL_STEP_KINDS,
            })
        except Exception as exc:
            logger.warning("[ComputerUsePlanner] Multi-step planner invocation failed: %s", exc)
            return None

        try:
            raw = str(response.content or "").strip()
            if raw.startswith("```"):
                lines = raw.splitlines()
                if len(lines) >= 3:
                    raw = "\n".join(lines[1:-1]).strip()
            payload = json.loads(raw)
            raw_steps = payload.get("steps")
            if not isinstance(raw_steps, list) or not raw_steps:
                return None
            if len(raw_steps) > 5:
                return None
            steps = [ComputerUsePlannedStep.model_validate(item) for item in raw_steps]
            for step in steps:
                if not self._is_model_step_safe(step):
                    return None
            plan_summary = normalize_whitespace(payload.get("plan_summary") or "")
            if not plan_summary:
                plan_summary = f"Execute {len(steps)} reviewed steps for: {transcript}"
            return ComputerUsePlan(
                kind="multi_step",
                mode="multi_step",
                trigger=trigger,
                reason="Model-assisted planner decomposed the request into a bounded multi-step plan.",
                plan_summary=plan_summary,
                steps=steps,
                model_attempted=True,
            )
        except Exception as exc:
            logger.warning("[ComputerUsePlanner] Multi-step planner returned invalid JSON: %s", exc)
            return None

    def _plan_shell_command(self, transcript: str, *, trigger: ComputerUseTrigger) -> ComputerUsePlan | None:
        normalized_command = normalize_command_text(transcript)
        if not self._looks_like_shell_command(normalized_command):
            return None

        blocked_reason = self._blocked_shell_reason(normalized_command)
        if blocked_reason is not None:
            return ComputerUsePlan(
                kind="refusal",
                trigger=trigger,
                reason=blocked_reason,
                refusal_message=blocked_reason,
            )

        return ComputerUsePlan(
            kind="local_task",
            trigger=trigger,
            reason="Explicit shell command routed into the reviewed local task shell.",
            command=normalized_command,
        )

    def _resolve_clause_to_step(
        self,
        clause: str,
        *,
        context: dict[str, Any],
        selection_text: Optional[str],
        clipboard_text: Optional[str],
    ) -> ComputerUsePlannedStep | None:
        normalized = normalize_whitespace(clause)
        if not normalized:
            return None

        shell_plan = self._plan_shell_command(normalized, trigger="action_phrase")
        if shell_plan is not None and shell_plan.kind == "local_task" and shell_plan.command:
            return ComputerUsePlannedStep(
                kind="shell_command",
                request=shell_plan.command,
                title="Run local command",
                summary=f"Run {shell_plan.command}",
            )

        local_task_command = self._resolve_local_task_command(
            normalized,
            context=context,
            selection_text=selection_text,
            clipboard_text=clipboard_text,
        )
        if local_task_command is not None:
            return ComputerUsePlannedStep(
                kind="shell_command",
                request=local_task_command,
                title="Run local task",
                summary=f"Run {local_task_command}",
            )

        if is_desktop_action_phrase(normalized):
            return ComputerUsePlannedStep(
                kind="desktop_action",
                request=normalized,
                title="Perform desktop action",
                summary=normalized,
            )

        return None

    def _normalize_browser_name(self, browser_value: str) -> str:
        normalized = normalize_whitespace(browser_value).lower()
        if normalized in {"", "chrome", "google chrome"}:
            return "Google Chrome"
        if normalized in {"brave", "brave browser"}:
            return "Brave Browser"
        if normalized in {"edge", "microsoft edge"}:
            return "Microsoft Edge"
        if normalized == "arc":
            return "Arc"
        return "Google Chrome"

    def _should_attempt_model_multistep_planning(self, transcript: str, *, trigger: ComputerUseTrigger) -> bool:
        normalized = normalize_whitespace(transcript)
        if not normalized or not MODEL_MULTI_STEP_CONNECTOR_PATTERN.search(normalized):
            return False
        word_count = len(normalized.split())
        if trigger == "action_phrase":
            return word_count <= 28 and len(normalized) <= 220
        return word_count <= 42 and len(normalized) <= 280

    def _split_multi_step_clauses(self, transcript: str) -> list[str]:
        normalized = normalize_whitespace(transcript)
        if not normalized:
            return []
        parts = [normalize_whitespace(part) for part in CLAUSE_SPLIT_PATTERN.split(normalized) if normalize_whitespace(part)]
        if len(parts) < 2:
            return []
        return parts[:5]

    def _is_model_step_safe(self, step: ComputerUsePlannedStep) -> bool:
        if step.kind == "shell_command":
            normalized = normalize_command_text(step.request)
            if not normalized:
                return False
            return self._blocked_shell_reason(normalized) is None
        if step.kind == "desktop_action":
            normalized = normalize_whitespace(step.request)
            return bool(normalized and is_desktop_action_phrase(normalized))
        return False

    def _blocked_shell_reason(self, command: str) -> str | None:
        if any(operator in command for operator in DISALLOWED_SHELL_OPERATORS):
            return "Computer Use blocks shell chaining, piping, redirection, and command substitution."

        try:
            argv = shlex.split(command, posix=True)
        except ValueError as exc:
            return f"Computer Use could not parse that command safely: {exc}"

        if not argv:
            return "Computer Use could not parse a runnable local command."

        executable = argv[0]
        lowered = executable.lower()
        if lowered in DISALLOWED_EXECUTABLES:
            return f"Computer Use blocks '{executable}' because it can access the network or escape the local-only policy."
        if lowered not in ALLOWED_EXECUTABLES:
            return f"Computer Use does not support '{executable}' as a reviewed local command."
        if lowered == "git" and len(argv) > 1 and argv[1].lower() in BLOCKED_GIT_SUBCOMMANDS:
            return f"Computer Use blocks 'git {argv[1]}' because it may contact a remote."
        if lowered in {"npm", "pnpm", "yarn"} and len(argv) > 1 and argv[1].lower() in BLOCKED_PACKAGE_MANAGER_SUBCOMMANDS:
            return f"Computer Use blocks '{lowered} {argv[1]}' because installs and package-manager updates are out of scope."
        return None

    def _resolve_local_task_command(
        self,
        transcript: str,
        *,
        context: dict[str, Any],
        selection_text: Optional[str],
        clipboard_text: Optional[str],
    ) -> str | None:
        current_file = str(context.get("code_file_name") or "").strip() or None

        if GIT_STATUS_PATTERN.match(transcript):
            return "git status"

        diff_match = GIT_DIFF_PATTERN.match(transcript)
        if diff_match:
            target = self._extract_path(diff_match.group(1) or "", current_file=current_file)
            return f"git diff -- {self._quote(target)}" if target else "git diff"

        tests_match = TESTS_PATTERN.match(transcript)
        if tests_match:
            target = self._extract_path(tests_match.group(1) or "", current_file=current_file)
            return f"pytest {self._quote(target)}" if target else "pytest"

        file_match = FIND_FILE_PATTERN.match(transcript)
        if file_match:
            target_name = self._extract_file_name(file_match.group(1))
            if target_name:
                return f"find . -name {self._quote(target_name)}"

        if LIST_FILES_PATTERN.match(transcript):
            return "find . -type f"

        read_match = READ_FILE_PATTERN.match(transcript)
        if read_match:
            target = self._extract_path(read_match.group(1), current_file=current_file)
            if target:
                return f"cat {self._quote(target)}"

        if is_repo_task_phrase(transcript):
            query = self._extract_query(
                transcript,
                selection_text=selection_text,
                clipboard_text=clipboard_text,
            )
            if query:
                lowered = transcript.lower()
                target = current_file if current_file and ("this file" in lowered or "the file" in lowered) else "."
                return f"rg -n -- {self._quote(query)} {self._quote(target)}"

        return None

    def _extract_query(self, transcript: str, *, selection_text: Optional[str], clipboard_text: Optional[str]) -> str | None:
        quoted = QUOTED_TEXT_PATTERN.search(transcript)
        if quoted:
            return normalize_whitespace(quoted.group(1))

        for candidate in (selection_text, clipboard_text):
            normalized = normalize_whitespace(candidate or "")
            if normalized:
                return normalized

        match = SEARCH_FOR_PATTERN.match(transcript)
        if not match:
            return None
        remainder = normalize_whitespace(match.group(1))
        if not remainder:
            return None

        lowered = remainder.lower()
        if lowered in STOPWORDS:
            return None
        if lowered.startswith("this") or lowered.startswith("that"):
            return None
        return remainder

    def _extract_path(self, text: str, *, current_file: Optional[str]) -> str | None:
        normalized = normalize_whitespace(text)
        if not normalized:
            return current_file
        if "this file" in normalized.lower() and current_file:
            return current_file
        file_name = self._extract_file_name(normalized)
        if file_name:
            return file_name
        return current_file if normalized.lower() in {"the file", "this", "that"} else None

    def _extract_file_name(self, text: str) -> str | None:
        match = FILE_NAME_PATTERN.search(text or "")
        if not match:
            return None
        return match.group(0)

    def _looks_like_shell_command(self, transcript: str) -> bool:
        lowered = normalize_whitespace(transcript).lower()
        if not lowered:
            return False
        if any(lowered.startswith(f"{prefix} ") or lowered == prefix for prefix in ALLOWED_EXECUTABLES | DISALLOWED_EXECUTABLES):
            return True
        tokens = lowered.split()
        if not tokens or len(tokens) > 12:
            return False
        return any(
            token.startswith(("/", "./", "../", "~/")) or "/" in token or token.startswith("-")
            for token in tokens[1:]
        )

    def _quote(self, value: str) -> str:
        normalized = normalize_whitespace(value)
        if re.fullmatch(r"[A-Za-z0-9._/@:-]+", normalized):
            return normalized
        return shlex.quote(normalized)
