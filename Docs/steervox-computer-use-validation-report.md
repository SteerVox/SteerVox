# SteerVox Computer Use Validation Report

This document records the engineering review performed after implementing the SteerVox-owned `Computer Use` route.

It answers a narrow question:

Did the new route land as a real product feature, or is it only partially wired in?

Current conclusion: the feature is integrated and test-clean across backend routing, execution plumbing, frontend exposure, history labeling, and repo documentation. No blocking implementation issue was found in this review pass.

## Scope Reviewed

The review focused on the exact areas that could break the plan.

### Backend routing and planning

- `COMPUTER_USE` intent exists
- the route can be entered by explicit mode
- the route can be entered by short imperative action phrases
- active editor or Cloud Code context alone does not trigger computer use
- the planner returns a structured decision:
  - `desktop_action`
  - `local_task`
  - `refusal`

### Execution and runtime integration

- desktop actions reuse the existing action-execution stack
- repo and file work reuse the existing local task shell
- local-task-shell runs preserve review behavior
- computer-use task runs are recorded distinctly in history and runtime telemetry

### Frontend exposure

- `Computer Use` is visible in the widget template set
- history and library views label computer-use runs distinctly
- no app-specific automatic selection of `Computer Use` was introduced

### Product-boundary review

- `Cloud Code` remains a prompt-only starter rule
- the route does not bind execution to editor app IDs
- local-only shell policy still blocks network-capable commands

## Code Surfaces Reviewed

The following active files were checked as part of the implementation review.

### Intent and telemetry

- [backend/agent/smart_models.py](/Users/abhishekrai/Desktop/SteerVox/backend/agent/smart_models.py)

### Planner, router, and processor

- [backend/agent/computer_use_planner.py](/Users/abhishekrai/Desktop/SteerVox/backend/agent/computer_use_planner.py)
- [backend/agent/router.py](/Users/abhishekrai/Desktop/SteerVox/backend/agent/router.py)
- [backend/agent/processor.py](/Users/abhishekrai/Desktop/SteerVox/backend/agent/processor.py)

### Skill registry and app-skill selection

- [backend/agent/skills/system_registry.yaml](/Users/abhishekrai/Desktop/SteerVox/backend/agent/skills/system_registry.yaml)
- [backend/agent/skills/defaults.py](/Users/abhishekrai/Desktop/SteerVox/backend/agent/skills/defaults.py)
- [backend/skill_selection.py](/Users/abhishekrai/Desktop/SteerVox/backend/skill_selection.py)

### Local task shell and engine integration

- [backend/local_task_shell/models.py](/Users/abhishekrai/Desktop/SteerVox/backend/local_task_shell/models.py)
- [backend/local_task_shell/service.py](/Users/abhishekrai/Desktop/SteerVox/backend/local_task_shell/service.py)
- [backend/engine.py](/Users/abhishekrai/Desktop/SteerVox/backend/engine.py)

### Frontend exposure

- [frontend/src/hooks/useFloatingWidgetController.ts](/Users/abhishekrai/Desktop/SteerVox/frontend/src/hooks/useFloatingWidgetController.ts)
- [frontend/src/lib/library.ts](/Users/abhishekrai/Desktop/SteerVox/frontend/src/lib/library.ts)
- [frontend/src/LibraryView.tsx](/Users/abhishekrai/Desktop/SteerVox/frontend/src/LibraryView.tsx)
- [frontend/src/types.ts](/Users/abhishekrai/Desktop/SteerVox/frontend/src/types.ts)

## Verification Performed

The review used both code inspection and automated checks.

### 1. Focused backend route tests

Executed:

```bash
./backend/.venv/bin/pytest \
  backend/tests/test_computer_use_planner.py \
  backend/tests/test_router.py \
  backend/tests/test_processor.py \
  backend/tests/test_skills.py -q
```

Result:

- `102 passed`

What this proves:

- explicit `Computer Use` mode routes correctly
- imperative repo/file requests route correctly
- desktop-action requests route through the SteerVox-owned lane
- planner telemetry is attached
- the new skill is registered

### 2. Engine, runtime, and policy tests

Executed:

```bash
./backend/.venv/bin/pytest \
  backend/tests/test_local_task_shell.py \
  backend/tests/test_engine.py \
  backend/tests/test_api_contracts.py \
  backend/tests/test_action_execution.py -q
```

Result:

- all tests passed

What this proves:

- computer-use-triggered local tasks still use the reviewed local task shell
- runtime status and review payloads remain valid
- engine history and summary recording still work
- existing desktop-action execution flows were not broken

### 3. Full backend suite

Executed:

```bash
./backend/.venv/bin/pytest backend/tests -q
```

Result:

- `465 passed in 10.40s`

What this proves:

- no broad backend regression was introduced by the new route

### 4. Frontend type and test validation

Executed:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

Result:

- TypeScript check passed
- frontend tests passed: `97 passed`

What this proves:

- the new telemetry and task fields are accepted by the frontend type surface
- widget rendering remains healthy
- library/history labeling works
- the curated widget template set still renders

### 5. Additional regression checks added during review

Extra coverage was added to prevent subtle regressions in product behavior.

New assertions now cover:

- Cloud Code context continues to resolve to `system_cloud_code_prompt`
- `Computer Use` is not auto-selected just because Cloud Code is frontmost
- the widget fallback template list contains `Computer Use`

Relevant test files:

- [backend/tests/test_skill_selection.py](/Users/abhishekrai/Desktop/SteerVox/backend/tests/test_skill_selection.py)
- [frontend/src/FloatingWidget.test.tsx](/Users/abhishekrai/Desktop/SteerVox/frontend/src/FloatingWidget.test.tsx)

## Findings

### No blocking defects found

The route is not a partial stub.

It is integrated in the expected product layers:

- intent model
- router
- processor
- planner
- local task shell
- engine history/telemetry
- widget skill exposure
- library/history labeling

### The Cloud Code boundary is correct

Cloud Code remains prompt-only.

Evidence:

- `Cloud Code` still exists as a starter rule in [backend/skill_selection.py](/Users/abhishekrai/Desktop/SteerVox/backend/skill_selection.py)
- execution routing is driven by `COMPUTER_USE` in the router and processor, not by editor app identity
- tests now explicitly guard this behavior

### The local-only boundary is still intact

The planner and local task shell continue to block network-capable or unsafe shell activity.

Evidence:

- blocked executable logic exists in [backend/agent/computer_use_planner.py](/Users/abhishekrai/Desktop/SteerVox/backend/agent/computer_use_planner.py)
- policy enforcement remains in [backend/local_task_shell/policy.py](/Users/abhishekrai/Desktop/SteerVox/backend/local_task_shell/policy.py)
- policy tests remain green in [backend/tests/test_local_task_shell.py](/Users/abhishekrai/Desktop/SteerVox/backend/tests/test_local_task_shell.py)

## Residual Limits

The review did not find a blocker, but there are still deliberate V1 limits.

### This is not open-ended remote computer use

Still out of scope:

- arbitrary browsing
- remote shell activity
- package installation workflows
- IDE-specific execution backdoors
- unrestricted command composition

### Local-task-shell runs remain reviewed

This is expected behavior, not a defect.

All `local_task` computer-use executions still require review in V1.

### No live GUI session was driven in this review environment

The feature was validated by full automated coverage and code-path inspection, not by an interactive end-to-end macOS screen-driving session inside this review pass.

That means:

- routing behavior is strongly validated
- execution plumbing is strongly validated
- UI exposure is strongly validated
- real-time manual OS-permission prompts were not exercised here

## Recommendation

The feature is in a good state to document and use.

Recommended status:

- keep `Computer Use` exposed in the widget
- keep `Cloud Code` prompt-only
- keep reviewed local-task execution as the default safety posture
- use the new guide for user-facing onboarding

## Related Docs

- [SteerVox Computer Use Guide](./steervox-computer-use-guide.md)
- [SteerVox Native Local Task Shell](./steervox-local-task-shell.md)
