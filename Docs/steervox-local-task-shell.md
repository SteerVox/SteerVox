# SteerVox Native Local Task Shell

This document explains what SteerVox gained from the recent local-task-shell integration, what is usable now, what developer-facing foundations now exist inside the product, and which follow-on features are the highest-value next steps.

It is intentionally written from a SteerVox-first perspective.

If you want the end-user operating guide for the new execution lane, see [SteerVox Computer Use Guide](./steervox-computer-use-guide.md).

- SteerVox did not absorb a full donor terminal app.
- The useful local orchestration patterns were adapted into SteerVox-owned backend, UI, and runtime contracts.

## Why This Exists

Before this work, SteerVox had strong voice capture, dictation, rewrite, template, and reviewed desktop-action flows, but it did not have a native execution lane for SteerVox itself to perform reviewed local tasks.

That meant SteerVox could:

- rewrite spoken input
- transform selected or clipboard text
- generate prompts for coding agents
- run a limited set of reviewed desktop actions

But it could not yet act as a local task runner for commands like:

- inspect a repo
- run a safe local test command
- perform local search or diff work
- keep task progress inside the SteerVox runtime model

The local task shell closes that gap.

## What SteerVox Users Can Do Right Now

This section describes the user-facing powers available from the current implementation.

### 1. Run Reviewed Local Tasks Through SteerVox

SteerVox now has an explicit `Local Task Shell` lane.

The purpose of this lane is straightforward:

- the user asks SteerVox to perform a local shell task
- SteerVox converts that into a vetted local command
- SteerVox requires review before running it
- SteerVox executes it only if it passes the local-only safety policy

This is different from the older terminal-related behavior.

Previously:

- `system_terminal` mainly formatted speech into a command string
- the result was something to paste elsewhere
- SteerVox was not the thing actually executing the shell task

Now:

- SteerVox itself can own the task run
- SteerVox shows a review item before execution
- SteerVox tracks the active run in runtime state
- SteerVox stores the outcome in SteerVox history and inbox flows

### 2. Get Review Before a Local Command Runs

The local task shell is deliberately review-first.

When the task is created, SteerVox generates a review item containing:

- the command that will run
- the working directory
- a short summary of what the command does
- the command language and preview text
- the risk level derived from policy classification

The user can then:

- approve the task
- reject the task

This keeps the product aligned with SteerVox’s existing review model instead of introducing an invisible automation lane.

### 3. Stay Inside a Local-Only Safety Boundary

The current task shell is intentionally not an arbitrary shell escape hatch.

It only permits a bounded set of local operations and blocks network-capable flows.

Examples of commands that are intended to be allowed in the current implementation:

- `git status`
- `git diff`
- `git show`
- `rg ...`
- `cat ...`
- `find ...`
- `pytest ...`
- `ruff ...`
- `mypy ...`

Examples of commands that are intentionally blocked:

- `curl ...`
- `wget ...`
- `ssh ...`
- `scp ...`
- `git fetch`
- `git pull`
- `git push`
- `npm install`
- `pnpm add`
- `brew install`
- shell chaining or redirection like `&&`, `|`, `;`, `>`, `<`

This matters because “fully local” is not just about removing built-in Anthropic or web clients. A product is still not meaningfully local if a free-form shell lane can immediately reintroduce unrestricted network access.

### 4. See Task State in the Existing SteerVox Runtime

The task shell is not implemented as a separate terminal app.

It is wired into the same SteerVox runtime path that already handles:

- widget state
- review state
- progress state
- status payloads
- SSE events
- history and invalidation flows

The current runtime status model now includes task-native fields such as:

- `pending_review`
- `active_task_run`
- `task_result_summary`

From the user’s perspective, this means task activity can appear in the same SteerVox experience as other runtime events instead of being hidden behind a different IPC stack or a separate terminal renderer.

### 5. Approve Local Tasks in the Floating Widget

The floating widget now understands the generic review model, not just desktop action review.

That means the widget can now show:

- a reviewed desktop action
- a reviewed local shell task

For local tasks, the widget displays:

- the task summary
- the command preview
- the working directory when present
- approval and rejection actions

This is important because the widget remains the primary approval surface for transient work. The local task shell fits into that existing product pattern instead of introducing an embedded donor terminal UI.

### 6. Track Task Progress and Results

The current implementation supports a first-pass task lifecycle:

- `pending_review`
- `running`
- `completed`
- `failed`
- `cancelled`
- `blocked`

SteerVox can now keep a live active run in runtime state and capture:

- the current command
- task step metadata
- stdout/stderr/summary output blocks
- final result summary
- exit code when available

This is not yet a fully generalized multi-step planner, but it is already enough to give SteerVox a real reviewed local command lane instead of a pure text-generation lane.

### 7. Persist Task Outcomes in SteerVox-Owned Stores

Task runs are now persisted through SteerVox-owned data flows instead of donor transcript formats.

Current behavior:

- task results can be recorded into SteerVox history
- task summaries can be stored into SteerVox inbox/note flows
- runtime invalidation events notify the UI that task data changed

This keeps the feature aligned with existing SteerVox product objects and avoids a second memory or transcript system.

### 8. Configure the Feature in Settings

The Settings UI now includes a `Local task shell` section.

Current controls include:

- enable or disable the local task shell
- visibility into the current strict safety mode
- explicit extra allowed directories

These settings are intentionally narrow in V1. The product currently exposes only a strict mode because the implementation is designed around a deny-by-default local-only policy.

## What Developer-Facing Primitives Now Exist

This section explains what new foundations were added for future SteerVox features.

These are more important than any one initial command demo because they determine what the product can grow into next.

### 1. A SteerVox-Owned Local Task Service

The new backend package lives under:

- [backend/local_task_shell/service.py](/Users/abhishekrai/Desktop/SteerVox/backend/local_task_shell/service.py)
- [backend/local_task_shell/policy.py](/Users/abhishekrai/Desktop/SteerVox/backend/local_task_shell/policy.py)
- [backend/local_task_shell/models.py](/Users/abhishekrai/Desktop/SteerVox/backend/local_task_shell/models.py)

This package is now the main backend primitive for:

- creating a task run
- classifying whether a command is allowed
- generating a review item
- approving or rejecting a run
- executing a vetted command
- capturing output blocks
- publishing result summaries

This is a meaningful architectural shift because SteerVox now has a reusable backend task engine that is product-owned rather than donor-owned.

### 2. A Formal Local-Only Command Policy

One of the most important pieces of this work is the policy layer.

The policy is not incidental. It is the thing that makes the local task shell usable in a real product.

Current policy responsibilities:

- parse and normalize shell commands
- reject shell chaining and redirection
- allow only known executables
- distinguish read-only versus riskier commands
- block network-capable executables
- block remote git operations
- block install/update package-manager operations
- restrict working directories to approved roots

This gives SteerVox a real enforcement boundary instead of relying on best-effort prompt instructions.

### 3. Generic Review Items

Before this work, review was mostly modeled around reviewed desktop actions.

The new runtime path introduces a more general review concept that can represent:

- desktop actions
- local shell commands
- future file-edit reviews
- future retry or task-step approvals

Current runtime fields now support that generalization even while preserving compatibility with the older `pending_action_review` shape.

This is a major enabling primitive because many future SteerVox capabilities will need the same review loop but for different action types.

### 4. Task-Native Runtime State

SteerVox now has a first-class task runtime contract across backend and frontend.

The shared types and runtime store now understand:

- `pending_review`
- `active_task_run`
- `task_result_summary`
- `task_runs_invalidated`

That means future backend capabilities do not need to invent a new transport or ad hoc frontend state model. They can plug into the task-native runtime contract that already exists.

### 5. Native Task Endpoints

The backend now exposes SteerVox-native task endpoints for the local shell path.

These cover:

- create a local task run
- approve a pending local task review
- reject a pending local task review
- cancel a local task run
- list task runs
- fetch a specific task run

This matters for future product work because other UI surfaces can reuse the same backend contract without talking directly to donor code or terminal-specific infrastructure.

### 6. A New Explicit Skill Lane

The system skill registry now includes `system_local_task`.

This gives routing a clean way to express:

- “format a command for the user” versus
- “SteerVox itself should execute this as a reviewed local task”

That separation is important. Prompt-crafting skills remain useful, but they are no longer the only option for task-shaped requests.

### 7. Task-Safe Storage Integration

The engine now records task results using SteerVox’s own persistence model.

That means developers can build additional task features on top of:

- existing history
- existing inbox
- existing runtime invalidation
- existing library views

instead of creating a second parallel data model.

### 8. UI Surfaces Already Prepared for Expansion

The work on:

- [frontend/src/types.ts](/Users/abhishekrai/Desktop/SteerVox/frontend/src/types.ts)
- [frontend/src/lib/runtimeStore.ts](/Users/abhishekrai/Desktop/SteerVox/frontend/src/lib/runtimeStore.ts)
- [frontend/src/hooks/useFloatingWidgetController.ts](/Users/abhishekrai/Desktop/SteerVox/frontend/src/hooks/useFloatingWidgetController.ts)
- [frontend/src/FloatingWidget.tsx](/Users/abhishekrai/Desktop/SteerVox/frontend/src/FloatingWidget.tsx)

means the frontend is no longer locked into “text paste” and “desktop action review” as its only transient operation types.

It now has the beginnings of a broader task surface that can show:

- progress
- review
- result summaries
- task-driven states

### 9. Test Coverage for the New Lane

The local task shell is not just an ad hoc feature. It now has targeted tests covering:

- command policy allow and deny behavior
- router support for the explicit local task lane
- processor behavior for local-task requests
- engine exposure of task review state
- API exposure of task state and task endpoints
- frontend runtime-store handling of task events
- widget handling of reviewed local tasks

That test coverage is an important developer-facing gain because it lowers the cost of continuing this work safely.

## Highest-Value Next Features To Build On Top Of This Base

This section focuses on the next features that are worth building now that the local task shell exists.

The priority order here is based on architectural leverage and product usefulness, not on novelty.

### 1. Multi-Step Local Task Plans

Current state:

- the shell executes reviewed single commands

Next step:

- allow a task run to contain multiple steps, each with its own status and optional review gate

Why this matters:

- most real task work is not one command
- repo inspection often requires search, then diff, then tests
- a multi-step plan turns the shell from “reviewed command runner” into “reviewed task executor”

What this would likely include:

- step sequencing
- per-step status
- retry support
- failure handling and resume logic
- richer result summaries

### 2. Reviewed File Edit Actions

Current state:

- the shell can run local commands
- it does not yet expose SteerVox-owned file edit operations as first-class task actions

Next step:

- add file read, diff, and edit operations as structured task actions

Why this matters:

- local coding or document tasks usually need file changes, not only shell output
- reviewed file edits are a more product-safe abstraction than unrestricted shell mutation

What this unlocks:

- repo-local code modifications
- controlled text replacement tasks
- structured patch previews in review UI
- future “apply this fix” flows inside SteerVox

### 3. Better Voice Routing Into the Task Lane

Current state:

- the explicit `system_local_task` lane exists
- this is a clean starting point, but not yet the end of routing work

Next step:

- improve voice and Smart routing so SteerVox can more confidently detect when a request is meant to be executed as a local task rather than only formatted as text

Examples:

- “run tests for this project”
- “search this repo for local task shell references”
- “show me the git diff for engine.py”

Why this matters:

- the feature becomes much more useful when the user can speak naturally instead of explicitly selecting a special lane every time

### 4. Richer Task Result Surfaces Beyond the Widget

Current state:

- the widget can show task review and in-progress state
- the library and inbox now understand local-task labels

Next step:

- create dedicated task result views in Home, Library, or Inbox

Why this matters:

- command output can be longer and more structured than ordinary notifications
- task history becomes more useful when users can browse and reopen runs directly

Good follow-on pieces:

- expandable output blocks
- stderr versus stdout presentation
- reopen or rerun buttons
- task-specific filtering in Library

### 5. Structured Desktop and Shell Review Unification

Current state:

- generic review exists
- compatibility is still maintained with the older desktop-action-specific field

Next step:

- fully converge runtime and UI behavior on one generic review model

Why this matters:

- it reduces duplicate code paths
- it simplifies future support for file edits and multi-step reviews
- it makes the runtime model easier to reason about

### 6. Safer Mutation Classes

Current state:

- the policy differentiates read-only versus more privileged local commands

Next step:

- split mutation work into better-defined classes such as:
  - read-only repo inspection
  - approved test execution
  - approved file edits
  - approved workspace writes

Why this matters:

- it gives SteerVox a clearer safety story than “some commands are medium risk”
- it allows finer UI messaging and approval behavior

### 7. Task-Aware Memory and Summaries

Current state:

- task outcomes can be stored in history and inbox

Next step:

- selectively summarize meaningful task outcomes into SteerVox-owned memory stores

Examples:

- recurring repo locations
- preferred project test commands
- stable workspace conventions
- approved additional roots

Why this matters:

- it would let SteerVox become more helpful over time without importing donor-style session-memory files

### 8. Offline Integration and Product Hardening

Current state:

- targeted tests already cover the local task shell

Next step:

- expand offline integration tests and explicit negative tests

Priority areas:

- network-unavailable startup and task execution
- blocked commands remaining blocked
- no external transport imports in active task-shell code
- no accidental widening of allowed executables

Why this matters:

- the local-first promise is only credible if regression tests enforce it

## Can SteerVox Do Computer Use?

Short answer: yes, but only in a bounded, local macOS sense. It does not currently provide full remote-agent-style computer use.

The current computer-use surface comes from SteerVox-owned action and automation code, mainly:

- `backend/action_execution.py`
- `backend/ui_automation.py`
- `backend/system_control.py`

This means SteerVox can already perform a meaningful class of local machine actions, but those actions are deterministic, allowlisted, and much narrower than a general autonomous desktop agent.

### What computer use works today

#### 1. Reviewed desktop actions

SteerVox can build reviewed actions for:

- opening an installed app
- opening a URL or navigating the current browser tab
- drafting an email in Apple Mail without sending it

These reviewed actions are generated as minimal AppleScript and require explicit approval before execution.

#### 2. Deterministic frontmost-app UI actions

SteerVox can inspect the frontmost app's accessible UI tree and perform a small set of direct control actions such as:

- focus a named text field
- press a named button
- focus the browser address bar
- focus the main chat input on supported AI-chat/browser surfaces
- press the primary send button on supported AI-chat/browser surfaces

This is real local UI automation, but it is not arbitrary click-anywhere automation. It depends on Accessibility-visible controls and the app exposing a usable UI tree.

#### 3. Browser transport controls

On supported browsers, SteerVox can currently:

- go back
- go forward
- reload the current page

The supported browser set in the active code path is:

- Safari
- Google Chrome
- Arc
- Brave Browser
- Microsoft Edge

#### 4. Media and system controls

SteerVox can currently perform a bounded set of local device-control actions:

- play or pause playback
- go to next or previous track
- mute or unmute audio
- step volume up or down
- set exact volume percent
- step brightness up or down
- set exact brightness percent

Part of this uses AppleScript. Brightness and some media transport behavior use the local macOS helper compiled by `backend/system_control.py`.

#### 5. Reviewed local shell work

The new `Local Task Shell` is also a form of computer use, but for workspace-local shell work instead of desktop UI manipulation.

That means SteerVox itself can now:

- run reviewed repo-local commands
- inspect files
- search a repo
- run diffs
- run safe local tests

This is not browser automation, but it is still an important local execution capability.

### What SteerVox cannot do yet

The current implementation does not support:

- arbitrary mouse movement or coordinate clicking
- drag and drop
- unrestricted typing into arbitrary UI surfaces
- multi-step autonomous browser workflows
- general screenshot-to-plan-to-act loops
- remote browser sessions
- unrestricted form submission across random sites
- donor-style remote computer-use stacks
- a general autonomous coding agent controlling the whole desktop

So if by "computer use" you mean "full cloud agent that can browse, inspect, decide, click, type, and recover across arbitrary software," the answer is no. If you mean "bounded local desktop and shell actions under review," the answer is yes.

### Brutal reality check on locality

There is an important distinction here:

- the new local task shell is deliberately local-only and network-restricted
- the broader desktop-action lane is still capable of opening browser URLs

That means the product now has a strong local-only task lane, but the entire app is not yet globally "network-blind" in every action path.

If the end goal is strict product-wide locality, the remaining hardening work is outside the task shell itself. In particular, `open_url` behavior and optional cloud provider paths elsewhere in the app would still need further restriction or removal.

## What Other Skills and Powers Exist Now

The most important point is that this work added more than one new command. It gave SteerVox a broader set of execution and transformation powers that now sit under one product-owned runtime.

### 1. New execution-oriented powers

The biggest gains from the integration are execution primitives, not just prompt templates.

SteerVox now has:

- an explicit `system_local_task` skill that routes into the reviewed local task shell
- a generic review model that can represent desktop actions and local shell tasks
- active task state, pending review state, result summary state, and task invalidation events
- task history and inbox persistence for local task outcomes
- a strict local-task policy layer with working-directory controls and executable allowlists

These are the foundations that matter if SteerVox is going to become more agentic over time without becoming reckless.

### 2. Existing useful built-in Smart skills

The system skill registry now contains a fairly broad set of reusable user-facing skills. They are not all "new" from the donor extraction, but they are part of the current active SteerVox capability set and matter when documenting what the app can do.

Current built-in skill families include:

- dictation and cleanup:
  - `system_dictation`
  - `system_grammar`
  - `strict_grammar`
  - `system_rewrite`
- communication:
  - `system_chat_reply`
  - `system_email_draft`
  - `system_domain_email`
  - `system_social_post`
- structured writing:
  - `system_issue_ticket`
  - `system_doc_notes`
  - `system_domain_structured_note`
  - `system_bullets`
- code and prompt preparation:
  - `system_code`
  - `system_codex_prompt`
  - `system_antigravity_prompt`
  - `system_cloud_code_prompt`
  - `system_ai_chat_prompt`
  - `system_prompt_architect`
  - `system_agent_action_builder`
- execution-oriented:
  - `system_local_task`
  - `system_terminal`
  - `system_action_execution`

### 3. What those skills let us do in practice

In practical terms, the active SteerVox tree now supports four different categories of work:

#### A. Paste-ready writing help

SteerVox can still do its original strong path very well:

- rewrite dictated text
- clean up grammar
- produce chat replies
- draft emails
- turn rough dictation into notes, bullets, or tickets
- produce social-post-ready text

#### B. Prompt and coding-request shaping

SteerVox can also help the user formulate work for other tools by turning voice into:

- a Codex task brief
- an Antigravity prompt
- a Cloud Code task request
- a general AI-chat prompt
- a system-prompt-style artifact
- a JSON or YAML-like agent action definition

These are still output-only skills. They do not mean SteerVox itself executes the whole task.

#### C. Local execution

This is the major gain from the new shell lane.

SteerVox can now:

- accept an explicit local-task request
- normalize it into a shell command
- run policy checks
- require review
- execute it locally
- publish progress and result state into the existing runtime

#### D. Desktop action automation

Separate from shell work, SteerVox can also:

- open or focus apps
- perform reviewed Mail or browser actions
- focus controls in the frontmost UI
- trigger bounded browser/media/system controls

That combination means the app now has a credible local action surface instead of only being a dictation-and-rewrite surface.

## What Works Using Only Local Models

This section is important because "local-only" in the repo does not mean one thing. Some capabilities are fully local and model-driven, some are fully local and deterministic, and some are local only when the app is configured that way.

### 1. The realistic local-only stack

Today, a practical local-only SteerVox setup looks like this:

- speech-to-text: `MLX Whisper`
- Smart text generation: `LM Studio`
- optional screen understanding: local LM Studio vision model
- local command execution: SteerVox `Local Task Shell`
- local UI/system actions: AppleScript, Accessibility APIs, and the macOS helper

That means a large useful slice of SteerVox can run without calling a remote LLM or remote STT provider, assuming the local runtimes are installed and available.

### 2. What is fully local and deterministic even without a local LLM

Some of the new powers do not depend on a local model at all.

These include:

- local task-shell command normalization for explicit task requests
- local task policy evaluation
- reviewed local command execution
- app-opening actions
- bounded URL/mail desktop actions
- frontmost UI focus and button-press actions
- browser back/forward/reload
- volume and brightness controls

So even if the local model is weak, unavailable, or not used for a given request, SteerVox still retains a meaningful local action layer.

### 3. What the `local_compact` LM Studio profile supports well

When Smart Mode uses `LM Studio`, SteerVox routes many requests through the fail-closed `local_compact` profile rather than treating the local model like a full remote planner.

The current local profile is intentionally optimized for short, bounded tasks such as:

- short grammar cleanup
- short rewrite requests
- short chat replies
- short email drafting or email rewriting
- bullet or checklist formatting
- prompt polishing
- short terminal-command cleanup
- explicit desktop action requests

The important design choice is that the local profile is contract-based. It expects small instructions, bounded source material, and specific output shapes.

### 4. What local models can help with beyond plain text

With the current local stack, SteerVox can also use local models for:

- short structured email generation with JSON-shaped output
- limited screen-context summarization through a local LM Studio vision model
- compact Smart previews and profile badging for local runs
- local-first routing behavior that avoids broad remote planning paths when `LM Studio` is the active provider

That gives SteerVox a legitimate "local Smart" story rather than only a local transcription story.

### 5. What local-only mode intentionally refuses

The local profile is not pretending to be a general-purpose frontier model. It deliberately refuses or limits request classes that are too broad.

Current examples include:

- translation
- deep research
- long comparative analysis
- broad coding or repo-refactor requests
- workflow or schema-generation requests
- open-ended system-prompt architecture work
- oversized source-material rewrites

This is a strength, not a weakness. The local path fails closed instead of hallucinating competence.

### 6. Practical examples of what you can do locally today

With only local models and local execution enabled, SteerVox is already useful for workflows like:

- "make this sound professional" on selected text
- "reply politely and say we can do tomorrow afternoon"
- "write an email saying the contract looks good but we need next Friday"
- "turn this into bullets"
- "polish this prompt"
- "run git status"
- "run pytest backend/tests/test_local_task_shell.py"
- "focus the chat input"
- "press send"
- "open Safari"
- "set brightness to 70 percent"

That is already a meaningful local assistant surface for writing, local task execution, and bounded desktop control.

## Current Limits and Non-Goals

To document the system honestly, the current limits should be explicit.

The present implementation does not aim to provide:

- arbitrary Bash execution
- unrestricted terminal access
- remote MCP transport support
- web browsing
- donor Bun/Ink terminal UI inside Electron
- Anthropic or Claude runtime features
- a fully autonomous multi-step coding agent

Those are either explicitly out of scope or intentionally deferred until SteerVox has stronger native safety, review, and state models.

## Practical Summary

If you want the shortest accurate summary of what this integration achieved, it is this:

- SteerVox now has a native, reviewed, local-only task execution lane.
- That lane is wired into the existing backend runtime, SSE stream, widget, settings, history, and inbox flows.
- The product now has the core primitives needed to expand into richer local repo, file, and task workflows without inheriting donor network coupling or donor UI architecture.

That foundation is more valuable than embedding a foreign terminal app, because it gives SteerVox a path to grow its own local task product model cleanly.
