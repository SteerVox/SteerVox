from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


TaskReviewScope = Literal["local_task", "desktop_action"]
TaskReviewKind = Literal["shell_command", "desktop_action", "file_edit", "task_plan", "task_retry"]
TaskRiskLevel = Literal["low", "medium", "high"]
TaskRunStatus = Literal["pending_review", "running", "completed", "failed", "cancelled", "blocked"]
TaskStepStatus = Literal["pending", "running", "completed", "failed", "cancelled", "blocked"]
TaskRunKind = Literal["single_step", "multi_step"]
TaskRetryMode = Literal["retry_failed_step", "rerun_all"]


class LocalTaskOutputBlock(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=False)

    id: str
    stream: Literal["stdout", "stderr", "summary"]
    text: str
    truncated: bool = False
    updated_at: str


class LocalTaskStep(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    kind: Literal["command", "shell_command", "desktop_action", "review", "result"] = "command"
    title: str
    summary: str
    status: TaskStepStatus = "pending"
    command: Optional[str] = None
    cwd: Optional[str] = None
    language: Optional[Literal["shell", "applescript"]] = None
    script: Optional[str] = None
    review_required: bool = False
    execution_mode: Optional[Literal["auto", "reviewed"]] = None
    action_type: Optional[str] = None
    app_name: Optional[str] = None
    bundle_id: Optional[str] = None
    value_percent: Optional[int] = None
    target_label: Optional[str] = None
    target_role: Optional[str] = None
    ui_index: Optional[int] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    exit_code: Optional[int] = None
    error: Optional[str] = None


class ReviewItem(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    id: str
    run_id: str
    scope: TaskReviewScope = "local_task"
    kind: TaskReviewKind
    title: str
    summary: str
    detail: Optional[str] = None
    command: Optional[str] = None
    cwd: Optional[str] = None
    risk_level: TaskRiskLevel = "medium"
    status: Literal["pending", "approved", "rejected", "error"] = "pending"
    error: Optional[str] = None
    language: Optional[Literal["shell", "applescript"]] = None
    script: Optional[str] = None
    step_id: Optional[str] = None


class LocalTaskResultSummary(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    run_id: str
    title: str
    summary: str
    status: TaskRunStatus
    command: Optional[str] = None
    cwd: Optional[str] = None
    plan_summary: Optional[str] = None
    exit_code: Optional[int] = None
    output_excerpt: Optional[str] = None
    step_count: int = 0
    completed_steps: int = 0
    failed_step_id: Optional[str] = None
    failed_step_title: Optional[str] = None
    created_at: str
    completed_at: str
    saved_to_history: bool = False
    saved_to_inbox: bool = False


class LocalTaskRun(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    run_id: str
    request_text: str
    source_intent: Literal["local_task", "computer_use"] = "local_task"
    run_kind: TaskRunKind = "single_step"
    title: str
    plan_summary: Optional[str] = None
    status: TaskRunStatus
    command: Optional[str] = None
    cwd: str
    created_at: str
    updated_at: str
    current_step_id: Optional[str] = None
    review_required: bool = True
    steps: List[LocalTaskStep] = Field(default_factory=list)
    output_blocks: List[LocalTaskOutputBlock] = Field(default_factory=list)
    result_summary: Optional[LocalTaskResultSummary] = None
    error: Optional[str] = None


class CommandPolicyDecision(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    allowed: bool
    reason: Optional[str] = None
    executable: Optional[str] = None
    argv: List[str] = Field(default_factory=list)
    normalized_command: Optional[str] = None
    cwd: Optional[str] = None
    risk_level: TaskRiskLevel = "medium"
    read_only: bool = False


class LocalTaskCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    request_text: str
    command: Optional[str] = None
    cwd: Optional[str] = None
    title: Optional[str] = None
    source_intent: Literal["local_task", "computer_use"] = "local_task"
    run_kind: TaskRunKind = "single_step"
    plan_summary: Optional[str] = None
    steps: List[LocalTaskStep] = Field(default_factory=list)


class LocalTaskReviewDecision(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    run_id: str
    review_id: str
    retry_mode: Optional[TaskRetryMode] = None


class LocalTaskCancelRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    run_id: str
