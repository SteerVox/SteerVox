import time
from pathlib import Path

from config.manager import ConfigManager
from local_task_shell import evaluate_local_command_policy
from local_task_shell.models import LocalTaskCreateRequest, LocalTaskStep
from local_task_shell.service import LocalTaskShellService


def test_local_task_policy_allows_repo_local_git_status(tmp_path):
    decision = evaluate_local_command_policy(
        "git status",
        cwd=str(tmp_path),
        allowed_roots=[tmp_path.resolve()],
    )

    assert decision.allowed is True
    assert decision.argv == ["git", "status"]
    assert decision.read_only is True
    assert decision.risk_level == "low"


def test_local_task_policy_blocks_network_commands(tmp_path):
    decision = evaluate_local_command_policy(
        "curl https://example.com",
        cwd=str(tmp_path),
        allowed_roots=[tmp_path.resolve()],
    )

    assert decision.allowed is False
    assert "blocked" in (decision.reason or "").lower()


def test_local_task_policy_blocks_remote_git_subcommands(tmp_path):
    decision = evaluate_local_command_policy(
        "git fetch origin",
        cwd=str(tmp_path),
        allowed_roots=[tmp_path.resolve()],
    )

    assert decision.allowed is False
    assert "contact a remote" in (decision.reason or "").lower()


def test_local_task_service_creates_reviewed_run_and_approves_it(tmp_path):
    config_manager = ConfigManager()
    config_manager.update_config({
        "actions": {
            "local_task_shell": {
                "allowed_directories": [str(tmp_path)],
            }
        }
    })
    service = LocalTaskShellService(config_manager=config_manager)
    tmp_path.joinpath("example.txt").write_text("hello\n", encoding="utf-8")

    created = service.create_run(
        LocalTaskCreateRequest(
            request_text="run cat example.txt",
            command="cat example.txt",
            cwd=str(tmp_path),
            title="Inspect file",
        )
    )

    assert created["status"] == "pending_review"
    assert service.pending_review is not None

    review = service.pending_review
    assert review is not None
    approved = service.approve_review(run_id=created["run_id"], review_id=review["id"])
    assert approved["status"] == "approved"

    # The worker thread runs in the background. Poll the in-memory archive.
    for _ in range(100):
        run = service.get_run(created["run_id"])
        if run and run.get("status") == "completed":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("Expected the approved local task to complete.")

    run = service.get_run(created["run_id"])
    assert run is not None
    assert run["result_summary"]["status"] == "completed"
    assert "hello" in (run["result_summary"]["output_excerpt"] or "")


def test_local_task_service_blocks_paths_outside_allowed_roots(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()

    config_manager = ConfigManager()
    config_manager.update_config({
        "actions": {
            "local_task_shell": {
                "allowed_directories": [str(workspace)],
            }
        }
    })
    service = LocalTaskShellService(config_manager=config_manager)
    created = service.create_run(
        LocalTaskCreateRequest(
            request_text="run pwd",
            command="pwd",
            cwd=str(outside),
            title="Outside root",
        )
    )

    assert created["status"] == "blocked"
    assert "outside the allowed local task roots" in (created["error"] or "").lower()


def test_local_task_shell_source_has_no_external_urls_or_network_imports():
    package_root = Path(__file__).resolve().parents[1] / "local_task_shell"
    disallowed_literals = ("http://", "https://", "ws://", "wss://", "axios", "@anthropic-ai/sdk", "import ws")

    for path in package_root.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for literal in disallowed_literals:
            assert literal not in text, f"{path} unexpectedly references {literal!r}"


def test_local_task_service_executes_multi_step_plan_after_full_review(tmp_path, monkeypatch):
    config_manager = ConfigManager()
    config_manager.update_config({
        "actions": {
            "local_task_shell": {
                "allowed_directories": [str(tmp_path)],
            }
        }
    })
    service = LocalTaskShellService(config_manager=config_manager)
    tmp_path.joinpath("example.txt").write_text("hello\n", encoding="utf-8")

    monkeypatch.setattr("local_task_shell.service.execute_planned_desktop_step", lambda _step: None)

    created = service.create_run(
        LocalTaskCreateRequest(
            request_text="open Finder and inspect the file",
            title="Computer Use",
            run_kind="multi_step",
            plan_summary="Execute 2 reviewed steps.",
            cwd=str(tmp_path),
            steps=[
                LocalTaskStep(
                    id="step-1",
                    kind="desktop_action",
                    title="Open Finder",
                    summary="Open Finder.",
                    language="applescript",
                    script='tell application id "com.apple.finder"\nreopen\nactivate\nend tell',
                    execution_mode="reviewed",
                    action_type="open_app",
                ),
                LocalTaskStep(
                    id="step-2",
                    kind="shell_command",
                    title="Read file",
                    summary="Run cat example.txt",
                    command="cat example.txt",
                    cwd=str(tmp_path),
                ),
            ],
        )
    )

    assert created["status"] == "pending_review"
    assert service.pending_review is not None
    assert service.pending_review["kind"] == "task_plan"

    approved = service.approve_review(run_id=created["run_id"], review_id=service.pending_review["id"])
    assert approved["status"] == "approved"

    for _ in range(100):
        run = service.get_run(created["run_id"])
        if run and run.get("status") == "completed":
            break
        time.sleep(0.02)
    else:
        raise AssertionError("Expected the approved multi-step task to complete.")

    run = service.get_run(created["run_id"])
    assert run is not None
    assert run["result_summary"]["status"] == "completed"
    assert run["steps"][0]["status"] == "completed"
    assert run["steps"][1]["status"] == "completed"


def test_local_task_service_creates_retry_review_for_failed_multi_step_step(tmp_path, monkeypatch):
    config_manager = ConfigManager()
    config_manager.update_config({
        "actions": {
            "local_task_shell": {
                "allowed_directories": [str(tmp_path)],
            }
        }
    })
    service = LocalTaskShellService(config_manager=config_manager)

    monkeypatch.setattr("local_task_shell.service.execute_planned_desktop_step", lambda _step: None)

    created = service.create_run(
        LocalTaskCreateRequest(
            request_text="open Finder and inspect the file",
            title="Computer Use",
            run_kind="multi_step",
            plan_summary="Execute 2 reviewed steps.",
            cwd=str(tmp_path),
            steps=[
                LocalTaskStep(
                    id="step-1",
                    kind="desktop_action",
                    title="Open Finder",
                    summary="Open Finder.",
                    language="applescript",
                    script='tell application id "com.apple.finder"\nreopen\nactivate\nend tell',
                    execution_mode="reviewed",
                    action_type="open_app",
                ),
                LocalTaskStep(
                    id="step-2",
                    kind="shell_command",
                    title="Read file",
                    summary="Run cat missing.txt",
                    command="cat missing.txt",
                    cwd=str(tmp_path),
                ),
            ],
        )
    )

    service.approve_review(run_id=created["run_id"], review_id=service.pending_review["id"])

    for _ in range(100):
        review = service.pending_review
        if review and review.get("kind") == "task_retry":
            break
        time.sleep(0.02)
    else:
        raise AssertionError("Expected a retry review for the failed multi-step task.")

    run = service.get_run(created["run_id"])
    assert run is not None
    assert run["steps"][0]["status"] == "completed"
    assert run["steps"][1]["status"] == "failed"

    tmp_path.joinpath("missing.txt").write_text("fixed\n", encoding="utf-8")
    retry_review = service.pending_review
    assert retry_review is not None
    approved = service.approve_review(
        run_id=created["run_id"],
        review_id=retry_review["id"],
        retry_mode="retry_failed_step",
    )
    assert approved["status"] == "approved"

    for _ in range(100):
        run = service.get_run(created["run_id"])
        if run and run.get("status") == "completed":
            break
        time.sleep(0.02)
    else:
        raise AssertionError("Expected the retried multi-step task to complete.")

    run = service.get_run(created["run_id"])
    assert run is not None
    assert run["steps"][0]["status"] == "completed"
    assert run["steps"][1]["status"] == "completed"
