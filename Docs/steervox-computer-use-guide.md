# SteerVox Computer Use Guide

This document explains how to use the new SteerVox-owned `Computer Use` route.

It is intentionally user-facing.

If you want the engineering verification record instead of usage guidance, see [SteerVox Computer Use Validation Report](./steervox-computer-use-validation-report.md).

## What Computer Use Is

`Computer Use` is the lane where SteerVox performs a task itself instead of only rewriting your speech into text.

In V1, that means SteerVox can do two kinds of work:

- `desktop actions`
- `reviewed local tasks`

Desktop actions cover bounded app, browser, and macOS control requests such as opening an app, focusing a supported control, or opening a reviewed URL.

Reviewed local tasks cover workspace and repo work such as:

- searching files
- reading files
- listing files
- checking `git status`
- checking `git diff`
- running reviewed local test commands

This route is SteerVox-owned. It does not delegate the work to Cloud Code, Codex, Cursor, VS Code, or another editor.

## How To Start It

You can enter `Computer Use` in either of these ways.

### 1. Explicit mode

In the SteerVox widget template picker, choose `Computer Use`.

Use this when you know in advance that you want SteerVox to act on your machine instead of formatting text.

### 2. Imperative voice command

You can also trigger the route by speaking a short, direct task request such as:

- `open Finder`
- `open Safari`
- `focus the chat input box`
- `search the repo for LocalTaskShellService`
- `show me git diff`
- `run tests for backend/tests/test_router.py`

The key pattern is that the request should sound like an instruction for SteerVox to perform.

Long freeform dictation does not automatically become computer use just because it contains action words.

## What Happens After You Speak

SteerVox runs a narrow local planner and decides between three outcomes:

- `desktop_action`
- `local_task`
- `refusal`

### Desktop action

SteerVox routes the request into the existing desktop-action stack.

Depending on the action, one of two things happens:

- the action is auto-executed if it is already classed as low-risk and auto-safe
- the action is shown as a review item first

Examples:

- `open Finder`
- `open Mail`
- `focus the search box`
- `go to github.com`

### Local task

SteerVox converts the request into a reviewed local shell command and sends it through the SteerVox local task shell.

Examples:

- `search the repo for LocalTaskShellService`
- `browse through the file and find me "LocalTaskShellService"`
- `show me git status`
- `show me git diff`
- `list the files`
- `read backend/agent/processor.py`
- `run tests for backend/tests/test_processor.py`

All local-task-shell runs remain reviewed in V1.

### Refusal

SteerVox refuses requests that would leave the local-only policy or that do not map cleanly to a supported route.

Examples:

- arbitrary browsing requests that require open-ended web navigation
- unrestricted shell requests
- network-capable shell commands
- remote git operations
- package install or update commands

## What You Will See In The UI

The route uses the existing SteerVox UI rather than a separate terminal panel.

### In the widget

You will see the existing review and progress surfaces.

Depending on the request, the widget may show:

- an action review card
- a local task review card
- live task progress
- a completion summary
- an error or refusal

### In history and library

Completed runs are labeled as SteerVox-executed computer-use work rather than as ordinary prompt output.

You should see labels such as:

- `Computer use`
- `Computer use task`
- `Computer use output`

## Recommended Usage Patterns

### Use Computer Use for direct machine actions

Good examples:

- `open Finder`
- `open Safari`
- `focus the chat input box`
- `go to github.com`

### Use Computer Use for local repo inspection

Good examples:

- `search the repo for LocalTaskShellService`
- `find the file called processor.py`
- `show me git diff`
- `read backend/engine.py`

### Use Computer Use for reviewed local tests

Good examples:

- `run tests`
- `run tests for backend/tests/test_router.py`
- `run tests for backend/tests/test_processor.py`

### Use Cloud Code for prompt crafting, not execution

Use `Cloud Code` when you want SteerVox to produce a prompt or implementation brief for an editor or coding agent.

Good examples:

- `write me a Cloud Code prompt for this refactor`
- `turn this into an implementation brief`
- `draft a prompt for the backend migration`

Do not use `Cloud Code` when you want SteerVox itself to open apps, search the repo, or run a reviewed local task.

## Safety Model

`Computer Use` is local-first and intentionally constrained.

### Allowed in V1

- opening supported apps
- bounded reviewed browser navigation
- supported focus and UI actions
- reviewed repo-local shell commands
- local file search, read, diff, and test operations

### Blocked in V1

- `curl`
- `wget`
- `ssh`
- `scp`
- `nc`
- `telnet`
- package-manager install or update commands
- remote git operations such as `git fetch`, `git pull`, or `git push`
- shell chaining or redirection
- HTTP, SSE, or WebSocket task transports

The goal is not arbitrary automation. The goal is a reviewed SteerVox execution lane that remains usable inside a local-only product boundary.

## Practical Examples

### Example 1: Open an app

1. Choose `Computer Use` in the widget, or simply say `open Finder`.
2. SteerVox routes this into a desktop action.
3. If the action requires review, approve it in the widget.
4. Finder opens.

### Example 2: Search the repo

1. Say `search the repo for LocalTaskShellService`.
2. SteerVox plans this as a local task.
3. The widget shows a reviewed command such as `rg -n -- LocalTaskShellService .`.
4. Approve the run.
5. SteerVox executes the command and stores the result summary in history.

### Example 3: Search the current file

1. Highlight a symbol or phrase in your editor.
2. Say `browse through the file and find me this`.
3. SteerVox uses the selected text as the search term and the active file as the target when context is available.
4. Approve the reviewed local task.

## Troubleshooting

### The request turned into a prompt instead of an action

Use one of these fixes:

- explicitly select `Computer Use`
- phrase the request as a short imperative command

Examples:

- better: `open Finder`
- worse: `I was thinking maybe we should open Finder and then look around`

### SteerVox refused the command

Likely reasons:

- the command would use the network
- the command is outside the allowlist
- the request was too open-ended to map safely

If you want repo inspection or tests, ask for a direct local action instead.

### The request needs review every time

That is expected for local task shell runs in V1. Reviewed local commands are not auto-approved by the new route.

## Current Limits

This route is intentionally narrower than a remote cloud agent.

It does not currently provide:

- arbitrary shell freedom
- unrestricted browser exploration
- drag-and-drop or open-ended GUI workflows
- remote shell execution
- package installation workflows
- hidden editor automation through Cloud Code or another IDE

Those limits are by design.

## Short Version

Use `Computer Use` when you want SteerVox to do something on your Mac.

- Choose `Computer Use` explicitly for machine actions.
- Use short imperative voice commands for quick entry.
- Expect review for local tasks.
- Use `Cloud Code` only for prompt generation, not execution.
