from local_task_shell.models import (
    CommandPolicyDecision,
    LocalTaskCancelRequest,
    LocalTaskCreateRequest,
    LocalTaskResultSummary,
    LocalTaskReviewDecision,
    LocalTaskRun,
    ReviewItem,
)
from local_task_shell.policy import evaluate_local_command_policy, normalize_task_command_request

__all__ = [
    "CommandPolicyDecision",
    "LocalTaskCancelRequest",
    "LocalTaskCreateRequest",
    "LocalTaskResultSummary",
    "LocalTaskReviewDecision",
    "LocalTaskRun",
    "ReviewItem",
    "LocalTaskShellService",
    "evaluate_local_command_policy",
    "normalize_task_command_request",
]


def __getattr__(name: str):
    if name == "LocalTaskShellService":
        from local_task_shell.service import LocalTaskShellService

        return LocalTaskShellService
    raise AttributeError(f"module 'local_task_shell' has no attribute {name!r}")
