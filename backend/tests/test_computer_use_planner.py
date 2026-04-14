from agent.computer_use_planner import ComputerUsePlanner, detect_computer_use_trigger


def test_detect_computer_use_trigger_for_explicit_mode():
    trigger = detect_computer_use_trigger(
        transcript="open Finder",
        requested_skill_id="system_computer_use",
        effective_skill_id="system_computer_use",
    )

    assert trigger == "explicit_mode"


def test_detect_computer_use_trigger_for_repo_search_phrase():
    trigger = detect_computer_use_trigger(
        transcript="search the repo for LocalTaskShellService",
        requested_skill_id="system_dictation",
        effective_skill_id="system_dictation",
    )

    assert trigger == "action_phrase"


def test_computer_use_planner_builds_repo_search_command():
    planner = ComputerUsePlanner()

    plan = planner.plan(
        transcript="search the repo for LocalTaskShellService",
        context={},
        trigger="action_phrase",
    )

    assert plan.kind == "local_task"
    assert plan.command == "rg -n -- LocalTaskShellService ."


def test_computer_use_planner_uses_selection_text_for_this_file_search():
    planner = ComputerUsePlanner()

    plan = planner.plan(
        transcript="browse through the file and find me this",
        context={"code_file_name": "engine.py"},
        trigger="action_phrase",
        selection_text="LocalTaskShellService",
    )

    assert plan.kind == "local_task"
    assert plan.command == "rg -n -- LocalTaskShellService engine.py"


def test_computer_use_planner_refuses_blocked_network_shell_commands():
    planner = ComputerUsePlanner()

    plan = planner.plan(
        transcript="curl https://example.com",
        context={},
        trigger="explicit_mode",
    )

    assert plan.kind == "refusal"
    assert "blocks" in (plan.refusal_message or "").lower()


def test_computer_use_planner_builds_deterministic_multi_step_plan():
    planner = ComputerUsePlanner()

    plan = planner.plan(
        transcript="open Finder and search the repo for LocalTaskShellService",
        context={},
        trigger="explicit_mode",
    )

    assert plan.kind == "multi_step"
    assert plan.mode == "multi_step"
    assert len(plan.steps) == 2
    assert plan.steps[0].kind == "desktop_action"
    assert plan.steps[0].request == "open Finder"
    assert plan.steps[1].kind == "shell_command"
    assert plan.steps[1].request == "rg -n -- LocalTaskShellService ."


def test_computer_use_planner_builds_structured_youtube_browser_plan():
    planner = ComputerUsePlanner()

    plan = planner.plan(
        transcript="open Chrome and play indie songs on YouTube",
        context={},
        trigger="action_phrase",
    )

    assert plan.kind == "multi_step"
    assert plan.mode == "multi_step"
    assert [step.action_type for step in plan.steps] == [
        "open_app",
        "open_url",
        "youtube_open_first_result",
        "youtube_ensure_playing",
    ]
    assert plan.steps[1].url == "https://www.youtube.com/results?search_query=indie+songs"
    assert plan.steps[2].browser_app_name == "Google Chrome"


def test_computer_use_planner_refuses_unsupported_youtube_browser():
    planner = ComputerUsePlanner()

    plan = planner.plan(
        transcript="open Arc and play indie songs on YouTube",
        context={},
        trigger="action_phrase",
    )

    assert plan.kind == "refusal"
    assert "not supported yet" in (plan.refusal_message or "").lower()
