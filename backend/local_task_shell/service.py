from __future__ import annotations

import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional
from uuid import uuid4

from action_execution import execute_planned_desktop_step, validate_planned_desktop_step
from config.manager import ConfigManager
from local_task_shell.models import (
    LocalTaskCreateRequest,
    LocalTaskOutputBlock,
    LocalTaskResultSummary,
    LocalTaskRun,
    LocalTaskStep,
    ReviewItem,
    TaskRetryMode,
    TaskRunStatus,
    TaskStepStatus,
)
from local_task_shell.policy import default_allowed_roots, evaluate_local_command_policy
from utils.logger import get_logger


logger = get_logger()
MAX_ARCHIVED_RUNS = 100
MAX_OUTPUT_BLOCKS = 120
OUTPUT_EXCERPT_CHARS = 3000


@dataclass
class _StepExecutionOutcome:
    status: TaskStepStatus
    exit_code: Optional[int] = None
    error: Optional[str] = None


class LocalTaskShellService:
    def __init__(
        self,
        *,
        config_manager: Optional[ConfigManager] = None,
        runtime_event_emitter: Optional[Callable[[str, Optional[dict[str, object]]], None]] = None,
        on_run_finished: Optional[Callable[[LocalTaskRun, LocalTaskResultSummary], None]] = None,
    ) -> None:
        self.config_manager = config_manager or ConfigManager()
        self.runtime_event_emitter = runtime_event_emitter
        self.on_run_finished = on_run_finished

        self._lock = threading.RLock()
        self._runs: dict[str, LocalTaskRun] = {}
        self._run_order: list[str] = []
        self._active_run_id: Optional[str] = None
        self._pending_review: Optional[ReviewItem] = None
        self._last_result_summary: Optional[LocalTaskResultSummary] = None
        self._worker_thread: Optional[threading.Thread] = None
        self._cancel_event: Optional[threading.Event] = None
        self._active_process: Optional[subprocess.Popen[str]] = None

    @property
    def active_run(self) -> Optional[dict[str, object]]:
        with self._lock:
            if not self._active_run_id:
                return None
            run = self._runs.get(self._active_run_id)
            if run is None:
                return None
            return run.model_dump(mode="json")

    @property
    def pending_review(self) -> Optional[dict[str, object]]:
        with self._lock:
            if self._pending_review is None:
                return None
            return self._pending_review.model_dump(mode="json")

    @property
    def last_result_summary(self) -> Optional[dict[str, object]]:
        with self._lock:
            if self._last_result_summary is None:
                return None
            return self._last_result_summary.model_dump(mode="json")

    def create_run(self, request: LocalTaskCreateRequest) -> dict[str, object]:
        task_config = self.config_manager.get_config().actions.local_task_shell
        if not task_config.enabled:
            return self._create_immediate_terminal_run(
                request=request,
                status="blocked",
                error="The local task shell is disabled in Settings.",
            )

        with self._lock:
            if self._active_run_id:
                active = self._runs.get(self._active_run_id)
                if active and active.status in {"pending_review", "running"}:
                    raise RuntimeError("A local task is already active. Finish it before starting another task.")

        allowed_roots = default_allowed_roots(task_config.allowed_directories)
        title = (request.title or "Local task").strip() or "Local task"
        request_cwd = self._normalize_requested_cwd(request.cwd, allowed_roots)
        if request_cwd is None:
            return self._create_immediate_terminal_run(
                request=request,
                status="blocked",
                error="The requested working directory is outside the allowed local task roots.",
                title=title,
                cwd=request.cwd,
            )

        if request.run_kind == "multi_step" or request.steps:
            prepared = self._prepare_multi_step_run(
                request=request,
                title=title,
                run_cwd=request_cwd,
                allowed_roots=allowed_roots,
            )
            if isinstance(prepared, dict):
                return prepared
            run, review = prepared
        else:
            prepared = self._prepare_single_step_run(
                request=request,
                title=title,
                run_cwd=request_cwd,
                allowed_roots=allowed_roots,
            )
            if isinstance(prepared, dict):
                return prepared
            run, review = prepared

        with self._lock:
            self._store_run(run)
            self._active_run_id = run.run_id
            self._pending_review = review
            self._emit_locked("active_task_run")
            self._emit_locked("pending_review")
            self._emit_locked("status")
            self._emit_locked("task_runs_invalidated")
            return run.model_dump(mode="json")

    def approve_review(
        self,
        *,
        run_id: str,
        review_id: str,
        retry_mode: Optional[TaskRetryMode] = None,
    ) -> dict[str, object]:
        with self._lock:
            run = self._runs.get(run_id)
            review = self._pending_review
            if run is None or review is None or review.run_id != run_id or review.id != review_id:
                raise RuntimeError("The local task review no longer matches the current backend state.")
            if review.status != "pending":
                raise RuntimeError("The local task review is no longer pending.")

            review.status = "approved"
            self._pending_review = None

            start_index = 0
            if review.kind == "task_retry":
                start_index = self._prepare_retry_execution_locked(run, retry_mode=retry_mode)

            self._emit_locked("pending_review")
            self._emit_locked("active_task_run")
            self._emit_locked("status")
            self._start_worker_locked(run_id=run.run_id, start_index=start_index)

        return {
            "status": "approved",
            "run_id": run_id,
            "review_id": review_id,
        }

    def reject_review(self, *, run_id: str, review_id: str) -> dict[str, object]:
        with self._lock:
            run = self._runs.get(run_id)
            review = self._pending_review
            if run is None or review is None or review.run_id != run_id or review.id != review_id:
                raise RuntimeError("The local task review no longer matches the current backend state.")
            if review.status not in {"pending", "error"}:
                raise RuntimeError("The local task review is no longer actionable.")

            review.status = "rejected"
            self._pending_review = None

        if review.kind == "task_retry":
            summary_text = "Task retry was rejected after a failed step."
            self._finalize_run(
                run_id=run_id,
                status="failed",
                summary_text=summary_text,
                error=run.error or summary_text,
                failed_step_id=review.step_id,
            )
        else:
            summary_text = "Local task was not approved."
            self._finalize_run(
                run_id=run_id,
                status="cancelled",
                summary_text=summary_text,
                error=summary_text,
            )

        return {
            "status": "rejected",
            "run_id": run_id,
            "review_id": review_id,
        }

    def cancel_run(self, *, run_id: str) -> dict[str, object]:
        finalize_now = False
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                raise RuntimeError("The requested local task run could not be found.")

            if run.status == "pending_review":
                finalize_now = True
                self._pending_review = None
            elif run.status == "running":
                if self._cancel_event is None:
                    self._cancel_event = threading.Event()
                self._cancel_event.set()
                process = self._active_process
                if process is not None and process.poll() is None:
                    try:
                        process.terminate()
                    except Exception:
                        logger.warning("[LocalTaskShell] Failed to terminate subprocess for run %s.", run_id)

            self._emit_locked("pending_review")
            self._emit_locked("status")

        if finalize_now:
            self._finalize_run(
                run_id=run_id,
                status="cancelled",
                summary_text="Local task was cancelled.",
                error="Local task was cancelled.",
            )

        return {
            "status": "cancel_requested",
            "run_id": run_id,
        }

    def get_run(self, run_id: str) -> Optional[dict[str, object]]:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return None
            return run.model_dump(mode="json")

    def list_runs(self, *, limit: int = 20) -> list[dict[str, object]]:
        with self._lock:
            selected = list(reversed(self._run_order[-max(limit, 0):]))
            return [self._runs[run_id].model_dump(mode="json") for run_id in selected if run_id in self._runs]

    def shutdown(self) -> None:
        worker: Optional[threading.Thread]
        with self._lock:
            if self._cancel_event is None:
                self._cancel_event = threading.Event()
            self._cancel_event.set()
            process = self._active_process
            worker = self._worker_thread
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except Exception:
                logger.warning("[LocalTaskShell] Failed to terminate subprocess during shutdown.")
        if worker is not None and worker.is_alive():
            worker.join(timeout=1.5)

    def _prepare_single_step_run(
        self,
        *,
        request: LocalTaskCreateRequest,
        title: str,
        run_cwd: str,
        allowed_roots: list[Path],
    ) -> tuple[LocalTaskRun, ReviewItem] | dict[str, object]:
        decision = evaluate_local_command_policy(
            request.command or "",
            cwd=run_cwd,
            allowed_roots=allowed_roots,
        )
        if not decision.allowed:
            return self._create_immediate_terminal_run(
                request=request,
                status="blocked",
                error=decision.reason or "The requested local command is blocked.",
                title=title,
                command=decision.normalized_command or request.command,
                cwd=decision.cwd or run_cwd,
            )

        now = self._now_iso()
        run_id = str(uuid4())
        step = LocalTaskStep(
            id=f"{run_id}:step-1",
            kind="shell_command",
            title=title,
            summary=f"Run {decision.normalized_command}",
            status="pending",
            command=decision.normalized_command,
            cwd=decision.cwd,
            language="shell",
            script=decision.normalized_command,
            review_required=True,
        )
        review = ReviewItem(
            id=f"{run_id}:review",
            run_id=run_id,
            scope="local_task",
            kind="shell_command",
            title=title,
            summary=step.summary,
            command=decision.normalized_command,
            cwd=decision.cwd,
            risk_level=decision.risk_level,
            language="shell",
            script=decision.normalized_command,
        )
        run = LocalTaskRun(
            run_id=run_id,
            request_text=request.request_text,
            source_intent=request.source_intent,
            run_kind="single_step",
            title=title,
            status="pending_review",
            command=decision.normalized_command,
            cwd=decision.cwd or run_cwd,
            created_at=now,
            updated_at=now,
            current_step_id=step.id,
            review_required=True,
            steps=[step],
            output_blocks=[],
            result_summary=None,
            error=None,
        )
        return run, review

    def _prepare_multi_step_run(
        self,
        *,
        request: LocalTaskCreateRequest,
        title: str,
        run_cwd: str,
        allowed_roots: list[Path],
    ) -> tuple[LocalTaskRun, ReviewItem] | dict[str, object]:
        if not request.steps:
            return self._create_immediate_terminal_run(
                request=request,
                status="blocked",
                error="A multi-step local task requires at least one executable step.",
                title=title,
                cwd=run_cwd,
            )

        normalized_steps: list[LocalTaskStep] = []
        highest_risk = "low"
        for index, raw_step in enumerate(request.steps, start=1):
            step_title = raw_step.title or f"Step {index}"
            if raw_step.kind == "desktop_action":
                validation_error = validate_planned_desktop_step(raw_step)
                if validation_error:
                    return self._create_immediate_terminal_run(
                        request=request,
                        status="blocked",
                        error=validation_error,
                        title=title,
                        cwd=run_cwd,
                        steps=request.steps,
                    )
                if raw_step.execution_mode == "reviewed":
                    highest_risk = "high"
                elif highest_risk != "high":
                    highest_risk = "medium"
                normalized_steps.append(
                    raw_step.model_copy(update={
                        "status": "pending",
                        "title": step_title,
                    })
                )
                continue

            if raw_step.kind not in {"command", "shell_command"} or not raw_step.command:
                return self._create_immediate_terminal_run(
                    request=request,
                    status="blocked",
                    error=f"Unsupported local task step kind '{raw_step.kind}'.",
                    title=title,
                    cwd=run_cwd,
                    steps=request.steps,
                )

            decision = evaluate_local_command_policy(
                raw_step.command,
                cwd=raw_step.cwd or run_cwd,
                allowed_roots=allowed_roots,
            )
            if not decision.allowed:
                return self._create_immediate_terminal_run(
                    request=request,
                    status="blocked",
                    error=decision.reason or "The task plan contains a blocked shell step.",
                    title=title,
                    cwd=decision.cwd or run_cwd,
                    steps=request.steps,
                )

            if highest_risk != "high" and decision.risk_level == "medium":
                highest_risk = "medium"
            normalized_steps.append(
                raw_step.model_copy(update={
                    "kind": "shell_command",
                    "title": step_title,
                    "status": "pending",
                    "command": decision.normalized_command,
                    "cwd": decision.cwd,
                    "language": "shell",
                    "script": raw_step.script or decision.normalized_command,
                    "review_required": True,
                })
            )

        now = self._now_iso()
        run_id = str(uuid4())
        normalized_steps = [
            step if step.id else step.model_copy(update={"id": f"{run_id}:step-{index}"})
            for index, step in enumerate(normalized_steps, start=1)
        ]
        plan_summary = (request.plan_summary or f"Execute {len(normalized_steps)} reviewed steps.").strip()
        for index, step in enumerate(normalized_steps, start=1):
            if not step.id:
                normalized_steps[index - 1] = step.model_copy(update={"id": f"{run_id}:step-{index}"})

        run = LocalTaskRun(
            run_id=run_id,
            request_text=request.request_text,
            source_intent=request.source_intent,
            run_kind="multi_step",
            title=title,
            plan_summary=plan_summary,
            status="pending_review",
            command=None,
            cwd=run_cwd,
            created_at=now,
            updated_at=now,
            current_step_id=normalized_steps[0].id,
            review_required=True,
            steps=normalized_steps,
            output_blocks=[],
            result_summary=None,
            error=None,
        )
        preview = self._build_plan_preview(normalized_steps)
        review = ReviewItem(
            id=f"{run_id}:plan-review",
            run_id=run_id,
            scope="local_task",
            kind="task_plan",
            title=title,
            summary=plan_summary,
            detail=preview,
            cwd=run_cwd,
            risk_level=highest_risk,  # type: ignore[arg-type]
            language=None,
            script=preview,
        )
        return run, review

    def _create_immediate_terminal_run(
        self,
        *,
        request: LocalTaskCreateRequest,
        status: TaskRunStatus,
        error: str,
        title: Optional[str] = None,
        command: Optional[str] = None,
        cwd: Optional[str] = None,
        steps: Optional[list[LocalTaskStep]] = None,
    ) -> dict[str, object]:
        now = self._now_iso()
        callback: Optional[Callable[[LocalTaskRun, LocalTaskResultSummary], None]] = None
        run_snapshot: Optional[LocalTaskRun] = None
        summary_snapshot: Optional[LocalTaskResultSummary] = None
        run = LocalTaskRun(
            run_id=str(uuid4()),
            request_text=request.request_text,
            source_intent=request.source_intent,
            run_kind=request.run_kind,
            title=(title or request.title or "Local task").strip() or "Local task",
            plan_summary=request.plan_summary,
            status=status,
            command=command if command is not None else request.command,
            cwd=(cwd or request.cwd or str(Path.cwd().resolve())),
            created_at=now,
            updated_at=now,
            current_step_id=None,
            review_required=False,
            steps=list(steps or request.steps),
            output_blocks=[],
            result_summary=None,
            error=error,
        )
        summary = LocalTaskResultSummary(
            run_id=run.run_id,
            title=run.title,
            summary=error,
            status=status,
            command=run.command,
            cwd=run.cwd,
            plan_summary=run.plan_summary,
            exit_code=None,
            output_excerpt=error,
            step_count=len(run.steps),
            completed_steps=self._completed_step_count(run),
            failed_step_id=None,
            failed_step_title=None,
            created_at=run.created_at,
            completed_at=now,
        )
        run.result_summary = summary
        with self._lock:
            self._store_run(run)
            self._finish_terminal_run(run, summary)
            callback = self.on_run_finished
            run_snapshot = run.model_copy(deep=True)
            summary_snapshot = summary.model_copy(deep=True)
        if callback is not None and run_snapshot is not None and summary_snapshot is not None:
            try:
                callback(run_snapshot, summary_snapshot)
            except Exception as exc:
                logger.warning("[LocalTaskShell] Failed to notify engine about immediate task completion for %s: %s", run.run_id, exc)
        return run.model_dump(mode="json")

    def _prepare_retry_execution_locked(self, run: LocalTaskRun, *, retry_mode: Optional[TaskRetryMode]) -> int:
        selected_mode: TaskRetryMode = retry_mode or "retry_failed_step"
        if selected_mode == "rerun_all":
            run.output_blocks = []
            run.result_summary = None
            run.error = None
            for index, step in enumerate(run.steps, start=1):
                run.steps[index - 1] = step.model_copy(update={
                    "status": "pending",
                    "started_at": None,
                    "completed_at": None,
                    "exit_code": None,
                    "error": None,
                })
            run.current_step_id = run.steps[0].id if run.steps else None
            run.status = "pending_review"
            run.updated_at = self._now_iso()
            return 0

        failed_index = 0
        for index, step in enumerate(run.steps):
            if step.status in {"failed", "blocked"}:
                failed_index = index
                break
        for index in range(failed_index, len(run.steps)):
            step = run.steps[index]
            run.steps[index] = step.model_copy(update={
                "status": "pending",
                "started_at": None,
                "completed_at": None,
                "exit_code": None,
                "error": None,
            })
        run.result_summary = None
        run.error = None
        run.current_step_id = run.steps[failed_index].id if run.steps else None
        run.status = "pending_review"
        run.updated_at = self._now_iso()
        return failed_index

    def _run_execution_loop(self, run_id: str, start_index: int, cancel_event: threading.Event) -> None:
        while True:
            with self._lock:
                run = self._runs.get(run_id)
                if run is None:
                    return
                if cancel_event.is_set():
                    self._mark_remaining_cancelled_locked(run)
                    break
                next_index = self._next_pending_index(run, start_index)
                if next_index is None:
                    break
                step = run.steps[next_index]
                run.status = "running"
                run.current_step_id = step.id
                run.updated_at = self._now_iso()
                run.steps[next_index] = step.model_copy(update={
                    "status": "running",
                    "started_at": self._now_iso(),
                    "completed_at": None,
                    "error": None,
                })
                self._emit_locked("active_task_run")
                self._emit_locked("status")

            outcome = self._execute_step(run_id=run_id, step_index=next_index, cancel_event=cancel_event)
            if outcome.status == "completed":
                start_index = next_index + 1
                continue

            if outcome.status == "cancelled":
                with self._lock:
                    run = self._runs.get(run_id)
                    if run is not None:
                        self._mark_remaining_cancelled_locked(run)
                break

            if not self._handle_step_failure(run_id=run_id, step_index=next_index, outcome=outcome):
                return
            return

        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            completed_steps = self._completed_step_count(run)
            final_status: TaskRunStatus = "cancelled" if cancel_event.is_set() else "completed"
            summary_text = (
                "Local task was cancelled."
                if final_status == "cancelled"
                else run.plan_summary or f"Completed {completed_steps} reviewed step(s)."
            )

        self._finalize_run(
            run_id=run_id,
            status=final_status,
            summary_text=summary_text,
            error=summary_text if final_status == "cancelled" else None,
        )

    def _execute_step(
        self,
        *,
        run_id: str,
        step_index: int,
        cancel_event: threading.Event,
    ) -> _StepExecutionOutcome:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return _StepExecutionOutcome(status="failed", error="The local task run no longer exists.")
            step = run.steps[step_index]

        if step.kind == "desktop_action":
            return self._execute_desktop_step(run_id=run_id, step_index=step_index, step=step, cancel_event=cancel_event)
        return self._execute_shell_step(run_id=run_id, step_index=step_index, step=step, cancel_event=cancel_event)

    def _execute_desktop_step(
        self,
        *,
        run_id: str,
        step_index: int,
        step: LocalTaskStep,
        cancel_event: threading.Event,
    ) -> _StepExecutionOutcome:
        if cancel_event.is_set():
            return _StepExecutionOutcome(status="cancelled")
        validation_error = validate_planned_desktop_step(step)
        if validation_error:
            self._complete_step(
                run_id=run_id,
                step_index=step_index,
                status="blocked",
                error=validation_error,
            )
            return _StepExecutionOutcome(status="blocked", error=validation_error)

        try:
            execute_planned_desktop_step(step)
        except Exception as exc:
            detail = str(exc).strip() or "The desktop action failed during execution."
            self._append_output(run_id, "stderr", detail)
            self._complete_step(
                run_id=run_id,
                step_index=step_index,
                status="failed",
                error=detail,
            )
            return _StepExecutionOutcome(status="failed", error=detail)

        self._append_output(run_id, "summary", step.summary)
        self._complete_step(run_id=run_id, step_index=step_index, status="completed", exit_code=0)
        return _StepExecutionOutcome(status="completed", exit_code=0)

    def _execute_shell_step(
        self,
        *,
        run_id: str,
        step_index: int,
        step: LocalTaskStep,
        cancel_event: threading.Event,
    ) -> _StepExecutionOutcome:
        task_config = self.config_manager.get_config().actions.local_task_shell
        decision = evaluate_local_command_policy(
            step.command or "",
            cwd=step.cwd,
            allowed_roots=default_allowed_roots(task_config.allowed_directories),
        )
        if not decision.allowed:
            detail = decision.reason or "The shell step is blocked by local task policy."
            self._append_output(run_id, "stderr", detail)
            self._complete_step(
                run_id=run_id,
                step_index=step_index,
                status="blocked",
                error=detail,
            )
            return _StepExecutionOutcome(status="blocked", error=detail)

        try:
            process = subprocess.Popen(
                decision.argv,
                cwd=decision.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except Exception as exc:
            detail = str(exc).strip() or "Unable to start the local shell command."
            self._append_output(run_id, "stderr", detail)
            self._complete_step(
                run_id=run_id,
                step_index=step_index,
                status="failed",
                error=detail,
            )
            return _StepExecutionOutcome(status="failed", error=detail)

        with self._lock:
            self._active_process = process

        stdout_thread = threading.Thread(
            target=self._stream_pipe,
            args=(run_id, process.stdout, "stdout", cancel_event),
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=self._stream_pipe,
            args=(run_id, process.stderr, "stderr", cancel_event),
            daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()

        try:
            exit_code = process.wait()
        finally:
            stdout_thread.join(timeout=1.0)
            stderr_thread.join(timeout=1.0)
            with self._lock:
                if self._active_process is process:
                    self._active_process = None

        if cancel_event.is_set():
            self._complete_step(
                run_id=run_id,
                step_index=step_index,
                status="cancelled",
                exit_code=exit_code,
                error="Local task was cancelled.",
            )
            return _StepExecutionOutcome(status="cancelled", exit_code=exit_code, error="Local task was cancelled.")

        if exit_code != 0:
            detail = f"Command exited with code {exit_code}."
            self._append_output(run_id, "stderr", detail)
            self._complete_step(
                run_id=run_id,
                step_index=step_index,
                status="failed",
                exit_code=exit_code,
                error=detail,
            )
            return _StepExecutionOutcome(status="failed", exit_code=exit_code, error=detail)

        self._complete_step(run_id=run_id, step_index=step_index, status="completed", exit_code=exit_code)
        return _StepExecutionOutcome(status="completed", exit_code=exit_code)

    def _handle_step_failure(
        self,
        *,
        run_id: str,
        step_index: int,
        outcome: _StepExecutionOutcome,
    ) -> bool:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return False
            failed_step = run.steps[step_index]
            message = outcome.error or f"Step '{failed_step.title}' failed."
            run.error = message
            run.updated_at = self._now_iso()

            if run.run_kind != "multi_step":
                pass
            else:
                review = ReviewItem(
                    id=f"{run.run_id}:retry:{failed_step.id}",
                    run_id=run.run_id,
                    scope="local_task",
                    kind="task_retry",
                    title="Retry task",
                    summary=f"{failed_step.title} failed. Retry from that step or rerun the full plan.",
                    detail=message,
                    cwd=run.cwd,
                    risk_level="medium",
                    status="pending",
                    error=message if outcome.status == "blocked" else None,
                    step_id=failed_step.id,
                )
                run.status = "pending_review"
                run.current_step_id = failed_step.id
                self._pending_review = review
                self._emit_locked("active_task_run")
                self._emit_locked("pending_review")
                self._emit_locked("status")
                return False

        self._finalize_run(
            run_id=run_id,
            status="blocked" if outcome.status == "blocked" else "failed",
            summary_text=message,
            error=message,
            failed_step_id=failed_step.id,
        )
        return False

    def _complete_step(
        self,
        *,
        run_id: str,
        step_index: int,
        status: TaskStepStatus,
        exit_code: Optional[int] = None,
        error: Optional[str] = None,
    ) -> None:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            step = run.steps[step_index]
            run.steps[step_index] = step.model_copy(update={
                "status": status,
                "completed_at": self._now_iso(),
                "exit_code": exit_code,
                "error": error,
            })
            run.updated_at = self._now_iso()
            self._emit_locked("active_task_run")

    def _append_output(
        self,
        run_id: str,
        stream: str,
        text: str,
        *,
        truncated: bool = False,
    ) -> None:
        cleaned = str(text or "")
        if not cleaned:
            return
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            block = LocalTaskOutputBlock(
                id=str(uuid4()),
                stream=stream,  # type: ignore[arg-type]
                text=cleaned,
                truncated=truncated,
                updated_at=self._now_iso(),
            )
            run.output_blocks.append(block)
            if len(run.output_blocks) > MAX_OUTPUT_BLOCKS:
                run.output_blocks = run.output_blocks[-MAX_OUTPUT_BLOCKS:]
            run.updated_at = self._now_iso()
            self._emit_locked("active_task_run")

    def _stream_pipe(
        self,
        run_id: str,
        pipe: Optional[object],
        stream: str,
        cancel_event: threading.Event,
    ) -> None:
        if pipe is None:
            return
        try:
            while not cancel_event.is_set():
                chunk = pipe.readline()
                if chunk == "":
                    break
                self._append_output(run_id, stream, chunk.rstrip("\n"))
        finally:
            close = getattr(pipe, "close", None)
            if callable(close):
                close()

    def _finalize_run(
        self,
        *,
        run_id: str,
        status: TaskRunStatus,
        summary_text: str,
        error: Optional[str],
        failed_step_id: Optional[str] = None,
    ) -> None:
        callback: Optional[Callable[[LocalTaskRun, LocalTaskResultSummary], None]] = None
        run_snapshot: Optional[LocalTaskRun] = None
        summary_snapshot: Optional[LocalTaskResultSummary] = None
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            if status == "cancelled":
                self._mark_remaining_cancelled_locked(run)
            failed_step = next((step for step in run.steps if step.id == failed_step_id), None)
            summary = LocalTaskResultSummary(
                run_id=run.run_id,
                title=run.title,
                summary=summary_text,
                status=status,
                command=run.command,
                cwd=run.cwd,
                plan_summary=run.plan_summary,
                exit_code=self._resolve_exit_code(run),
                output_excerpt=self._build_output_excerpt(run),
                step_count=len(run.steps),
                completed_steps=self._completed_step_count(run),
                failed_step_id=failed_step.id if failed_step else None,
                failed_step_title=failed_step.title if failed_step else None,
                created_at=run.created_at,
                completed_at=self._now_iso(),
            )
            run.status = status
            run.error = error
            run.current_step_id = None
            run.updated_at = summary.completed_at
            run.result_summary = summary
            self._finish_terminal_run(run, summary)
            callback = self.on_run_finished
            run_snapshot = run.model_copy(deep=True)
            summary_snapshot = summary.model_copy(deep=True)

        if callback is not None and run_snapshot is not None and summary_snapshot is not None:
            try:
                callback(run_snapshot, summary_snapshot)
            except Exception as exc:
                logger.warning("[LocalTaskShell] Failed to notify engine about task completion for %s: %s", run_id, exc)

    def _finish_terminal_run(self, run: LocalTaskRun, summary: LocalTaskResultSummary) -> None:
        self._pending_review = None
        if self._active_run_id == run.run_id:
            self._active_run_id = None
        self._last_result_summary = summary
        self._emit_locked("pending_review")
        self._emit_locked("active_task_run")
        self._emit_locked("task_result_summary")
        self._emit_locked("status")
        self._emit_locked("task_runs_invalidated")

    def _store_run(self, run: LocalTaskRun) -> None:
        self._runs[run.run_id] = run
        self._run_order.append(run.run_id)
        if len(self._run_order) > MAX_ARCHIVED_RUNS:
            expired_id = self._run_order.pop(0)
            if expired_id != self._active_run_id:
                self._runs.pop(expired_id, None)

    def _start_worker_locked(self, *, run_id: str, start_index: int) -> None:
        self._cancel_event = threading.Event()
        worker = threading.Thread(
            target=self._run_execution_loop,
            args=(run_id, start_index, self._cancel_event),
            daemon=True,
        )
        self._worker_thread = worker
        worker.start()

    def _emit_locked(self, event_type: str) -> None:
        if self.runtime_event_emitter is None:
            return
        try:
            self.runtime_event_emitter(event_type, None)
        except Exception as exc:
            logger.warning("[LocalTaskShell] Failed to emit runtime event %s: %s", event_type, exc)

    def _build_plan_preview(self, steps: list[LocalTaskStep]) -> str:
        sections: list[str] = []
        for index, step in enumerate(steps, start=1):
            label = "Desktop" if step.kind == "desktop_action" else "Shell"
            preview = step.script or step.command or step.summary
            sections.append(f"{index}. [{label}] {step.summary}\n{preview}")
        return "\n\n".join(sections)

    def _build_output_excerpt(self, run: LocalTaskRun) -> Optional[str]:
        chunks = [block.text for block in run.output_blocks if block.text]
        if not chunks:
            return run.error
        joined = "\n".join(chunks).strip()
        if len(joined) <= OUTPUT_EXCERPT_CHARS:
            return joined or None
        return joined[-OUTPUT_EXCERPT_CHARS:]

    def _resolve_exit_code(self, run: LocalTaskRun) -> Optional[int]:
        exit_codes = [step.exit_code for step in run.steps if step.exit_code is not None]
        return exit_codes[-1] if exit_codes else None

    def _completed_step_count(self, run: LocalTaskRun) -> int:
        return sum(1 for step in run.steps if step.status == "completed")

    def _normalize_requested_cwd(self, cwd: Optional[str], allowed_roots: list[Path]) -> Optional[str]:
        probe = evaluate_local_command_policy("pwd", cwd=cwd, allowed_roots=allowed_roots)
        if not probe.allowed:
            return None
        return probe.cwd or str(Path.cwd().resolve())

    def _next_pending_index(self, run: LocalTaskRun, start_index: int) -> Optional[int]:
        for index in range(start_index, len(run.steps)):
            if run.steps[index].status == "pending":
                return index
        return None

    def _mark_remaining_cancelled_locked(self, run: LocalTaskRun) -> None:
        changed = False
        for index, step in enumerate(run.steps):
            if step.status in {"pending", "running"}:
                run.steps[index] = step.model_copy(update={
                    "status": "cancelled",
                    "completed_at": self._now_iso(),
                    "error": "Local task was cancelled.",
                })
                changed = True
        if changed:
            run.updated_at = self._now_iso()
            self._emit_locked("active_task_run")

    def _now_iso(self) -> str:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
