from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

from agent.skills.models import SkillDefinition
from agent.smart_models import SmartIntent, SmartLane


LOCAL_SMART_PROFILE_ID = "local_compact"
LOCAL_SMART_PROFILE_LABEL = "Local Smart profile"
LOCAL_SMART_REFUSAL_MESSAGE = (
    "Local Smart is optimized for short rewrites, replies, bullets, prompt cleanup, and simple desktop actions. "
    "This request needs a larger model."
)
LOCAL_INSTRUCTION_MAX_WORDS = 32
LOCAL_REPLY_MAX_WORDS = 100
LOCAL_SOURCE_MATERIAL_MAX_CHARS = 2400

EMAIL_CONTEXT_KEYWORDS = ("mail", "gmail", "outlook", "superhuman", "hey.com")
CHAT_CONTEXT_KEYWORDS = ("slack", "discord", "messages", "signal", "telegram", "teams")
TERMINAL_CONTEXT_KEYWORDS = ("terminal", "iterm", "warp", "hyper")
CODE_CONTEXT_KEYWORDS = (
    "antigravity",
    "cloud code",
    "cloudcode",
    "codex",
    "cursor",
    "visual studio code",
    "vscode",
    "windsurf",
    "code",
    "pycharm",
    "intellij",
    "webstorm",
)
WORKFLOW_HOST_KEYWORDS = ("make.com", "n8n.io", "n8n.cloud", "flowiseai.com")

EMAIL_WRITE_PATTERN = re.compile(
    r"\b(?:write|draft|compose|rewrite|reply(?: to)?|respond(?: to)?)\b.*\b(?:email|mail|message)\b|\b(?:subject|email body)\b",
    re.IGNORECASE,
)
CHAT_REPLY_PATTERN = re.compile(
    r"\b(?:reply|respond|answer|message back|send a reply)\b",
    re.IGNORECASE,
)
BULLETIZE_PATTERN = re.compile(
    r"\b(?:bullets?|bullet points?|checklist|action items?|key points?)\b",
    re.IGNORECASE,
)
SPOKEN_LIST_PATTERN = re.compile(
    r"\b(?:point|bullet|item|step)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b",
    re.IGNORECASE,
)
CHECKLIST_PATTERN = re.compile(r"\b(?:checklist|todo|to-do)\b", re.IGNORECASE)
PROMPT_POLISH_PATTERN = re.compile(
    r"\b(?:prompt)\b.*\b(?:polish|rewrite|clean up|improve|tighten|shorten|refine)\b|\b(?:polish|rewrite|clean up|improve|tighten|shorten|refine)\b.*\bprompt\b",
    re.IGNORECASE,
)
SOURCE_MATERIAL_REWRITE_PATTERN = re.compile(
    r"^(?:rewrite this|rephrase this|polish this|clean this up|fix grammar|make this(?: sound)?(?: more)?(?: professional|polite|clear(?:er)?|concise|short(?:er)?|better)?|turn this into (?:bullets?|a checklist|bullet points?|action items?))\b",
    re.IGNORECASE,
)
INLINE_SOURCE_REQUEST_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(make this(?: sound)?(?: more)? professional)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? polite)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? clear(?:er)?)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? concise)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(make this(?: sound)?(?: more)? short(?:er)?)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(rewrite this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(rephrase this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(polish this)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(polish this prompt)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(clean this up)\s+(.+)$", re.IGNORECASE),
    re.compile(r"^(turn this into (?:bullets?|a checklist|bullet points?|action items?))\s+(.+)$", re.IGNORECASE),
)
DEICTIC_SOURCE_PATTERN = re.compile(
    r"\b(?:this|that|it|selection|selected text|selected code|highlighted text|highlighted code|clipboard|clipboard text|this prompt|this draft|these notes)\b",
    re.IGNORECASE,
)
DEEP_WORK_PATTERN = re.compile(
    r"\b(?:deep research|research|detailed(?: analysis)?|thorough|comprehensive|analy[sz]e|comparison|compare|explain why|trade[- ]?offs?|"
    r"acceptance criteria|verify|verification|edge cases?|failure modes?|workflow|agent(?:ic)?|schema|json schema|yaml|jira|ticket|"
    r"bug report|code|repo|repository|refactor|migration|test plan|system prompt|prompt architect|open-ended|generic)\b",
    re.IGNORECASE,
)
TRANSLATION_PATTERN = re.compile(
    r"\btranslate\b|\bin (?:spanish|french|german|italian|hindi|english|japanese|korean|chinese|arabic)\b",
    re.IGNORECASE,
)
ACTION_PATTERN = re.compile(
    r"^(?:open|launch|switch to|bring up|focus(?: on)?|go to|visit|navigate to|click|press|tap|choose|hit|"
    r"play(?:\s*/\s*pause|\s+pause)?|pause|next(?: track| song)?|previous(?: track| song)?|skip(?: track| song)?|"
    r"mute|unmute|volume(?: up| down)?|brightness(?: up| down)?|reload|refresh|go back|go forward)\b",
    re.IGNORECASE,
)
SHELL_STARTERS = (
    "git ",
    "cd ",
    "ls",
    "pwd",
    "mkdir ",
    "rm ",
    "cp ",
    "mv ",
    "cat ",
    "grep ",
    "rg ",
    "npm ",
    "pnpm ",
    "yarn ",
    "python ",
    "python3 ",
    "pip ",
    "pytest",
    "uv ",
    "docker ",
    "kubectl ",
)


def normalize_whitespace(text: str) -> str:
    return " ".join(str(text or "").split()).strip()


def extract_inline_source_request(transcript: str) -> tuple[str, str] | None:
    normalized = normalize_whitespace(transcript)
    if not normalized:
        return None
    for pattern in INLINE_SOURCE_REQUEST_PATTERNS:
        match = pattern.match(normalized)
        if not match:
            continue
        instruction = normalize_whitespace(match.group(1))
        source_text = normalize_whitespace(match.group(2))
        if instruction and source_text:
            return instruction, source_text
    return None


def _combined_context_text(context: dict[str, Any]) -> str:
    return " ".join(
        part.lower()
        for part in (
            context.get("app_name"),
            context.get("bundle_id"),
            context.get("window_title"),
            context.get("page_title"),
            context.get("url_host"),
            context.get("url_path"),
            context.get("target_type"),
            context.get("surface_kind"),
        )
        if part
    )


def _word_count(text: str) -> int:
    normalized = normalize_whitespace(text)
    if not normalized:
        return 0
    return len(normalized.split())


def _resolve_source_text(
    *,
    transcript: str,
    context: dict[str, Any],
    selection_text: Optional[str],
    clipboard_text: Optional[str],
) -> tuple[str, Optional[str]]:
    inline_source = extract_inline_source_request(transcript)
    if inline_source:
        return inline_source[0], inline_source[1]

    external_text = str(context.get("external_text") or "").strip()
    if external_text:
        return normalize_whitespace(transcript), external_text

    selection = str(selection_text or "").strip()
    if selection:
        return normalize_whitespace(transcript), selection

    clipboard = str(clipboard_text or "").strip()
    if clipboard:
        return normalize_whitespace(transcript), clipboard

    return normalize_whitespace(transcript), None


def _source_material_required(transcript: str) -> bool:
    normalized = normalize_whitespace(transcript)
    if not normalized:
        return False
    return bool(SOURCE_MATERIAL_REWRITE_PATTERN.match(normalized) or (DEICTIC_SOURCE_PATTERN.search(normalized) and PROMPT_POLISH_PATTERN.search(normalized)))


def _is_email_context(context: dict[str, Any], requested_skill: SkillDefinition, effective_skill: SkillDefinition) -> bool:
    if str(context.get("surface_kind") or "").strip().lower() in {"email_subject", "email_body"}:
        return True
    if requested_skill.id in {"system_email_draft", "system_domain_email"} or effective_skill.id in {"system_email_draft", "system_domain_email"}:
        return True
    combined = _combined_context_text(context)
    return any(keyword in combined for keyword in EMAIL_CONTEXT_KEYWORDS)


def _is_chat_context(context: dict[str, Any], requested_skill: SkillDefinition, effective_skill: SkillDefinition) -> bool:
    if requested_skill.id == "system_chat_reply" or effective_skill.id == "system_chat_reply":
        return True
    combined = _combined_context_text(context)
    return context.get("target_type") == "chat" or any(keyword in combined for keyword in CHAT_CONTEXT_KEYWORDS)


def _is_terminal_context(context: dict[str, Any], requested_skill: SkillDefinition, effective_skill: SkillDefinition) -> bool:
    if requested_skill.output_mode == "command" or effective_skill.output_mode == "command":
        return True
    combined = _combined_context_text(context)
    return any(keyword in combined for keyword in TERMINAL_CONTEXT_KEYWORDS)


def _looks_like_shell_command(transcript: str) -> bool:
    lowered = normalize_whitespace(transcript).lower()
    if not lowered:
        return False
    return any(lowered.startswith(prefix) for prefix in SHELL_STARTERS)


def _is_prompt_heavy_request(transcript: str, requested_skill: SkillDefinition, effective_skill: SkillDefinition) -> bool:
    if requested_skill.id in {
        "system_codex_prompt",
        "system_antigravity_prompt",
        "system_cloud_code_prompt",
        "system_ai_chat_prompt",
        "system_prompt_architect",
        "system_agent_action_builder",
    }:
        return True
    return bool(DEEP_WORK_PATTERN.search(transcript))


def _is_code_context(context: dict[str, Any]) -> bool:
    combined = _combined_context_text(context)
    return any(keyword in combined for keyword in CODE_CONTEXT_KEYWORDS)


def _is_workflow_context(context: dict[str, Any]) -> bool:
    combined = _combined_context_text(context)
    return any(keyword in combined for keyword in WORKFLOW_HOST_KEYWORDS)


def _local_email_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "local_email_output",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "subject": {
                        "type": ["string", "null"],
                    },
                    "body": {
                        "type": "string",
                    },
                },
                "required": ["subject", "body"],
            },
        },
    }


@dataclass(frozen=True)
class LocalCompactClassification:
    mode: str
    intent: SmartIntent
    lane: SmartLane
    reason: str
    output_mode: str = "plain_text"
    contract_id: Optional[str] = None
    source_material_required: bool = False
    response_format: Optional[dict[str, Any]] = None
    response_schema_name: Optional[str] = None
    streaming_allowed: bool = True
    profile_limit_reason: Optional[str] = None
    refusal_message: Optional[str] = None

    @property
    def is_supported(self) -> bool:
        return self.mode != "unsupported_local"


@dataclass(frozen=True)
class LocalCompactPromptContract:
    contract_id: str
    system_prompt: str
    response_format: Optional[dict[str, Any]] = None
    response_schema_name: Optional[str] = None
    streaming_allowed: bool = True


def classify_local_compact_request(
    *,
    transcript: str,
    context: dict[str, Any],
    requested_skill: SkillDefinition,
    effective_skill: SkillDefinition,
    selection_text: Optional[str],
    clipboard_text: Optional[str],
) -> LocalCompactClassification:
    normalized = normalize_whitespace(transcript)
    instruction_text, source_text = _resolve_source_text(
        transcript=normalized,
        context=context,
        selection_text=selection_text,
        clipboard_text=clipboard_text,
    )
    transcript_words = _word_count(normalized)
    instruction_words = _word_count(instruction_text)
    source_chars = len(source_text or "")
    source_required = _source_material_required(normalized)

    if not normalized:
        return _unsupported("Local Smart needs a short instruction before it can run locally.")

    if TRANSLATION_PATTERN.search(normalized):
        return _unsupported("Translation is not supported by the local_compact profile.")

    if source_required:
        if not source_text:
            return _unsupported(
                "Local Smart needs selected text or clipboard text for rewrite-style requests like this one."
            )
        if instruction_words > LOCAL_INSTRUCTION_MAX_WORDS:
            return _unsupported("The local rewrite instruction is too long for the compact local profile.")
        if source_chars > LOCAL_SOURCE_MATERIAL_MAX_CHARS:
            return _unsupported("The selected source text is too large for the compact local profile.")

    if (_is_terminal_context(context, requested_skill, effective_skill) or _looks_like_shell_command(normalized)) and instruction_words <= LOCAL_INSTRUCTION_MAX_WORDS:
        return LocalCompactClassification(
            mode="deterministic_local",
            intent=SmartIntent.TERMINAL_COMMAND,
            lane=SmartLane.DETERMINISTIC,
            reason="Short terminal cleanup request matched the compact local deterministic lane.",
            output_mode="command",
            contract_id="local_cleanup",
        )

    if ACTION_PATTERN.match(normalized) and instruction_words <= LOCAL_INSTRUCTION_MAX_WORDS:
        return LocalCompactClassification(
            mode="deterministic_local",
            intent=SmartIntent.ACTION_EXECUTION,
            lane=SmartLane.DETERMINISTIC,
            reason="Short desktop action matched the compact local deterministic lane.",
            output_mode="code",
            contract_id="local_action",
        )

    if _is_prompt_heavy_request(normalized, requested_skill, effective_skill):
        return _unsupported("This request is broader than the local_compact profile.")

    if _is_code_context(context):
        return _unsupported("Coding workflows are outside the local_compact profile.")

    if _is_workflow_context(context):
        return _unsupported("Workflow and schema generation are outside the local_compact profile.")

    if PROMPT_POLISH_PATTERN.search(normalized):
        if source_required and not source_text:
            return _unsupported("Prompt polish needs source prompt text from the selection, clipboard, or spoken source.")
        if instruction_words > LOCAL_INSTRUCTION_MAX_WORDS:
            return _unsupported("Prompt polish instructions must stay short in the compact local profile.")
        return LocalCompactClassification(
            mode="freeform_local",
            intent=SmartIntent.PROMPT_CRAFTING,
            lane=SmartLane.LLM,
            reason="Prompt-polish request matched the compact local prompt cleanup contract.",
            contract_id="local_prompt_polish",
            source_material_required=source_required,
        )

    if BULLETIZE_PATTERN.search(normalized) or SPOKEN_LIST_PATTERN.search(normalized):
        if source_required and not source_text:
            return _unsupported("Bullet formatting needs source text when the instruction refers to 'this' or selected text.")
        if source_required and instruction_words > LOCAL_INSTRUCTION_MAX_WORDS:
            return _unsupported("Bullet-formatting instructions must stay short in the compact local profile.")
        if not source_required and transcript_words > LOCAL_REPLY_MAX_WORDS:
            return _unsupported("This formatting request is too long for the compact local profile.")
        return LocalCompactClassification(
            mode="freeform_local",
            intent=SmartIntent.BULLETIZE,
            lane=SmartLane.LLM,
            reason="Short formatting request matched the compact local bullets/checklist contract.",
            output_mode="bullets",
            contract_id="local_checklist" if CHECKLIST_PATTERN.search(normalized) else "local_bullets",
            source_material_required=source_required,
        )

    if _is_email_context(context, requested_skill, effective_skill) or EMAIL_WRITE_PATTERN.search(normalized):
        if transcript_words > LOCAL_REPLY_MAX_WORDS:
            return _unsupported("Email generation needs a shorter dictation to stay within the compact local profile.")
        return LocalCompactClassification(
            mode="typed_local",
            intent=SmartIntent.EMAIL_REWRITE,
            lane=SmartLane.LLM,
            reason="Short email request matched the compact local structured email contract.",
            contract_id="local_email",
            response_format=_local_email_response_format(),
            response_schema_name="local_email_output",
            streaming_allowed=False,
        )

    if _is_chat_context(context, requested_skill, effective_skill) or CHAT_REPLY_PATTERN.search(normalized):
        if transcript_words > LOCAL_REPLY_MAX_WORDS:
            return _unsupported("Chat reply dictation must stay under the local compact reply budget.")
        return LocalCompactClassification(
            mode="freeform_local",
            intent=SmartIntent.CHAT_REPLY,
            lane=SmartLane.LLM,
            reason="Short chat reply request matched the compact local reply contract.",
            contract_id="local_chat_reply",
        )

    if requested_skill.id in {"system_grammar", "strict_grammar", "system_rewrite"} or source_required:
        if source_required and not source_text:
            return _unsupported("Rewrite requests like this need selected text, clipboard text, or spoken source material.")
        if source_required and instruction_words > LOCAL_INSTRUCTION_MAX_WORDS:
            return _unsupported("Rewrite instructions must stay short in the compact local profile.")
        if not source_required and transcript_words > LOCAL_REPLY_MAX_WORDS:
            return _unsupported("This rewrite request is too long for the compact local profile.")
        lane = SmartLane.LLM if source_required else SmartLane.DETERMINISTIC
        return LocalCompactClassification(
            mode="freeform_local" if lane == SmartLane.LLM else "deterministic_local",
            intent=SmartIntent.GRAMMAR_CLEANUP,
            lane=lane,
            reason=(
                "Source-driven rewrite matched the compact local rewrite contract."
                if lane == SmartLane.LLM
                else "Short standalone cleanup matched the compact local deterministic cleanup lane."
            ),
            contract_id="local_cleanup",
            source_material_required=source_required,
        )

    return _unsupported("No compact local contract matched this request.")


def _unsupported(limit_reason: str) -> LocalCompactClassification:
    return LocalCompactClassification(
        mode="unsupported_local",
        intent=SmartIntent.LOCAL_UNSUPPORTED,
        lane=SmartLane.REFUSED,
        reason="Local Smart refused a request outside the compact local profile.",
        profile_limit_reason=limit_reason,
        refusal_message=LOCAL_SMART_REFUSAL_MESSAGE,
    )


def build_local_compact_prompt_contract(contract_id: str) -> LocalCompactPromptContract:
    contracts: dict[str, LocalCompactPromptContract] = {
        "local_cleanup": LocalCompactPromptContract(
            contract_id="local_cleanup",
            system_prompt=(
                "You are a rewrite engine for a compact local model.\n"
                "Return only the transformed text.\n"
                "No preamble. No quotes. No markdown fences.\n"
                "If source text is provided, transform the source text itself instead of answering the instruction.\n\n"
                "Example:\n"
                "Instruction: make this sound more professional\n"
                "Source text:\n"
                "ship this after qa signs off\n"
                "Output:\n"
                "Ship this after QA signs off."
            ),
        ),
        "local_chat_reply": LocalCompactPromptContract(
            contract_id="local_chat_reply",
            system_prompt=(
                "You are a short reply drafting engine for chat apps.\n"
                "Return only the final reply text.\n"
                "Keep the reply direct, useful, and natural.\n"
                "No conversational filler about what you are doing.\n\n"
                "Example:\n"
                "Instruction:\n"
                "reply politely and say we can do tomorrow afternoon\n"
                "Output:\n"
                "That works for me. We can do tomorrow afternoon."
            ),
        ),
        "local_bullets": LocalCompactPromptContract(
            contract_id="local_bullets",
            system_prompt=(
                "You are a formatting engine.\n"
                "Return only a bulleted list.\n"
                "No preamble. No explanation.\n"
                "If source text is provided, transform the source text itself.\n\n"
                "Example:\n"
                "Instruction: turn this into bullets\n"
                "Source text:\n"
                "buy eggs and milk\n"
                "Output:\n"
                "- Buy eggs\n"
                "- Buy milk"
            ),
        ),
        "local_checklist": LocalCompactPromptContract(
            contract_id="local_checklist",
            system_prompt=(
                "You are a formatting engine.\n"
                "Return only a checklist.\n"
                "No preamble. No explanation.\n"
                "If source text is provided, transform the source text itself.\n\n"
                "Example:\n"
                "Instruction: turn this into a checklist\n"
                "Source text:\n"
                "buy eggs and milk\n"
                "Output:\n"
                "[ ] Buy eggs\n"
                "[ ] Buy milk"
            ),
        ),
        "local_prompt_polish": LocalCompactPromptContract(
            contract_id="local_prompt_polish",
            system_prompt=(
                "You are a prompt-polishing engine for a compact local model.\n"
                "Return only the improved prompt.\n"
                "Do not expand the task into a system prompt, workflow, or agent brief.\n"
                "Keep the user's original goal intact while making the prompt clearer and tighter.\n\n"
                "Example:\n"
                "Instruction: polish this prompt\n"
                "Source text:\n"
                "write a meeting summary and include next steps\n"
                "Output:\n"
                "Write a concise meeting summary and include clear next steps."
            ),
        ),
        "local_email": LocalCompactPromptContract(
            contract_id="local_email",
            system_prompt=(
                "You are an email drafting engine for a compact local model.\n"
                "Return JSON only.\n"
                "Use the instruction to draft or rewrite a short professional email.\n"
                "If source text is provided, transform it instead of answering the instruction.\n\n"
                "Example:\n"
                "{\"subject\":\"Delivery timeline update\",\"body\":\"Hi Sam,\\n\\nThe contract looks good from our side. We need to move the delivery date to next Friday because the backend team is in the middle of a server migration.\\n\\nBest,\\nAbhishek\"}"
            ),
            response_format=_local_email_response_format(),
            response_schema_name="local_email_output",
            streaming_allowed=False,
        ),
    }
    contract = contracts.get(contract_id)
    if contract is None:
        raise KeyError(f"Unknown local compact prompt contract: {contract_id}")
    return contract
