import type { HTMLAttributes, ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FloatingWidget } from './FloatingWidget'

const {
  apiGetMock,
  apiPostMock,
  refreshRuntimeLocalEnvironmentMock,
} = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  refreshRuntimeLocalEnvironmentMock: vi.fn(),
}))

let runtimeState: {
  connectionState: string
  invalidationTokens: Record<string, number>
  snapshot: {
    status: Record<string, unknown>
    config: Record<string, unknown>
  } & Record<string, unknown>
  localEnvironment: Record<string, unknown>
}
let captureStateListener: ((state: Record<string, unknown>) => void) | null = null

vi.mock('framer-motion', async () => {
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
    motion: {
      div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    },
  }
})

vi.mock('./lib/api', () => ({
  apiGet: apiGetMock,
  apiPost: apiPostMock,
}))

vi.mock('./lib/runtimeStore', () => ({
  useRuntimeStore: (selector: (state: unknown) => unknown) => selector(runtimeState),
  refreshRuntimeLocalEnvironment: refreshRuntimeLocalEnvironmentMock,
}))

vi.mock('./lib/runtimeSelectors', () => ({
  selectReadinessState: () => ({
    dictationReady: true,
    accessibilityReady: true,
    microphoneReady: true,
    dictationProviderReady: true,
    rewriteProviderReady: true,
    rewriteReady: true,
    completed: true,
  }),
  selectOnboardingState: () => ({
    dictationReady: true,
    completed: true,
  }),
  selectPrimaryAttentionIssue: () => null,
}))

vi.mock('./lib/sounds', () => ({
  playStartChime: vi.fn(),
  playStopChime: vi.fn(),
}))

vi.mock('./lib/pasteDelivery', () => ({
  claimPasteDeliveryAnnouncement: vi.fn(() => false),
  clearPasteDeliveryAttempt: vi.fn(),
  deliverPendingPaste: vi.fn(),
}))

vi.mock('./lib/widgetDelivery', () => ({
  getPendingNotificationKey: vi.fn(() => 'notification'),
  isPreparingPasteBusy: vi.fn(() => false),
}))

describe('FloatingWidget smart preview', () => {
  beforeEach(() => {
    captureStateListener = null
    apiPostMock.mockReset()
    apiGetMock.mockReset()
    refreshRuntimeLocalEnvironmentMock.mockReset()
    apiGetMock.mockResolvedValue({
      data: {
        skills: [
          { id: 'system_dictation', name: 'Standard Dictation' },
          { id: 'system_rewrite', name: 'Professional Rewrite' },
        ],
      },
    })
    apiPostMock.mockResolvedValue({ data: { status: 'success' } })

    runtimeState = {
      connectionState: 'connected',
      invalidationTokens: {
        config: 0,
        providers: 0,
        history: 0,
        inbox: 0,
        skills: 0,
        domains: 0,
        writing_tools: 0,
        usage: 0,
      },
      snapshot: {
        status: {
          backend_ready: true,
          is_recording: false,
          is_processing: true,
          active_mode: 'smart_transform',
          active_skill: 'system_rewrite',
          audio_amplitude: 0,
          last_error: null,
          pending_paste_text: null,
          pending_paste: null,
          pending_notification: null,
          pending_action_review: null,
          missing_api_keys: false,
          recording_cues_enabled: false,
          restore_clipboard_after_paste: true,
          phase: 'transforming',
          phase_label: 'Smart',
          captured_context: {
            app_name: 'Slack',
            bundle_id: null,
            window_title: 'eng-updates',
            page_title: null,
            url_host: null,
            url_path: null,
            focused_field_role: null,
            focused_field_subrole: null,
            focused_field_label: null,
            focused_field_placeholder: null,
          },
          captured_context_at: null,
          captured_context_quality: 'full',
          active_domain: null,
          target_type: 'chat',
          context_warning: null,
          last_smart_run: null,
          smart_preview: {
            run_id: 'preview-1',
            mode: 'smart_transform',
            state: 'streaming',
            text: 'Please ship this once QA has approved it.',
            final_text: null,
            error: null,
            updated_at: '2026-03-28T00:00:00.000Z',
          },
          pipeline_timings: {
            record_start: null,
            stt_done: null,
            route_done: null,
            transform_done: null,
            paste_ack_done: null,
          },
        },
        config: {
          stt: {
            provider: 'mlx',
            model: 'base',
            language: 'en',
            language_mode: 'fixed',
            preferred_languages: ['en'],
          },
          llm: {
            provider: 'lmstudio',
            model: 'nvidia/nemotron-3-nano-4b',
            temperature: 0,
            routing: {
              enabled: false,
              provider: 'groq',
              model: 'compound-mini',
              temperature: 0,
            },
          },
          vision: {
            enabled: true,
            model: null,
            timeout_ms: 2500,
          },
          actions: {
            enabled: true,
            auto_approve_reviewed: false,
            experimental_media_controls: false,
          },
          hotkeys: {
            default_skill_id: 'system_rewrite',
            app_skill_defaults: [],
          },
          domains: {
            mode: 'auto',
            app_domain_defaults: [],
          },
          audio: {
            input_device: null,
            input_device_id: null,
            input_device_label: null,
            enable_recording_cues: false,
          },
          privacy: {
            restore_clipboard_after_paste: true,
            minimize_sensitive_context: false,
            sensitive_targets: [],
          },
          debug: {
            log_sensitive_transcripts: false,
            persist_recordings: false,
          },
          memory: {
            enabled: true,
            auto_learn_from_history: true,
            semantic_retrieval_enabled: true,
          },
        },
      },
      localEnvironment: {
        status: 'ready',
        error: null,
        updatedAt: Date.now(),
        microphoneAccess: 'granted',
        accessibilityTrusted: true,
        contextAccess: {
          status: 'full',
          message: 'Ready',
          context: null,
        },
        verifyingTarget: null,
      },
    }

    window.windowControls = {
      minimize: vi.fn(),
      close: vi.fn(),
      quitApp: vi.fn(),
      showMainWindow: vi.fn(),
      showSettings: vi.fn(),
      getPlatform: vi.fn(),
      getBackendBaseUrl: vi.fn(),
      getLaunchContext: vi.fn(),
      setBackgroundOnly: vi.fn(),
      hideTransientWindows: vi.fn(),
      setWidgetModeMenuOpen: vi.fn(),
      setWidgetPreviewExpanded: vi.fn().mockResolvedValue({ status: 'updated', open: true }),
      setWidgetActionReviewExpanded: vi.fn().mockResolvedValue({ status: 'updated', open: true }),
      setWidgetLiveTranscriptExpanded: vi.fn().mockResolvedValue({ status: 'updated', open: true }),
      checkAccessibility: vi.fn().mockResolvedValue(true),
      promptAccessibility: vi.fn(),
      openPrivacySettings: vi.fn(),
      getCapturePermissionStatus: vi.fn().mockResolvedValue('granted'),
      requestCapturePermission: vi.fn().mockResolvedValue('granted'),
      getCaptureDevices: vi.fn(),
      getCaptureState: vi.fn().mockResolvedValue({
        is_recording: false,
        is_testing: false,
        mode: null,
        phase: 'idle',
        amplitude: 0,
        error: null,
        active_device_id: null,
        active_device_label: null,
        fallback_to_default: false,
        fallback_notice: null,
      }),
      getLocalLiveTranscriptionState: vi.fn().mockResolvedValue(null),
      startMicTest: vi.fn(),
      stopMicTest: vi.fn(),
      checkSmartContextAccess: vi.fn().mockResolvedValue({ status: 'full', message: 'Ready', context: null }),
      promptSmartContextAccess: vi.fn().mockResolvedValue({ status: 'full', message: 'Ready', context: null }),
      restartBackend: vi.fn(),
      dismissPackagedOnboarding: vi.fn(),
      completePackagedOnboarding: vi.fn(),
      revealAppInFinder: vi.fn(),
      openApplicationsFolder: vi.fn(),
      toggleRecording: vi.fn(),
      getBackendBootState: vi.fn().mockResolvedValue({
        phase: 'ready',
        label: 'Ready',
        detail: 'Ready',
        progress: null,
      }),
      getMlxInstallState: vi.fn(),
      checkMlxWhisperInstallation: vi.fn(),
      installMlxWhisper: vi.fn(),
      openLogsDirectory: vi.fn(),
      reportRendererError: vi.fn(),
      getInboxWindowState: vi.fn(),
      pasteText: vi.fn(),
      showNativeNotification: vi.fn(),
      toggleInboxWindow: vi.fn(),
      closeInboxWindow: vi.fn(),
      notifyInboxChanged: vi.fn(),
      writeClipboardText: vi.fn(),
      pickDomainPackFile: vi.fn(),
      saveDomainPackFile: vi.fn(),
      completeWidgetHide: vi.fn(),
      onPasteError: vi.fn(() => () => undefined),
      onBackendBootState: vi.fn(() => () => undefined),
      onMlxInstallState: vi.fn(() => () => undefined),
      onCaptureState: vi.fn((callback) => {
        captureStateListener = callback as (state: Record<string, unknown>) => void
        return () => {
          if (captureStateListener === callback) {
            captureStateListener = null
          }
        }
      }),
      onLocalLiveTranscription: vi.fn(() => () => undefined),
      onWidgetPresentationCommand: vi.fn((callback) => {
        callback({ visible: true, source: 'hotkey' })
        return () => undefined
      }),
      onInboxWindowState: vi.fn(() => () => undefined),
      onInboxChanged: vi.fn(() => () => undefined),
    } as unknown as typeof window.windowControls
  })

  it('renders inline smart preview text and hides secondary selectors while expanding the widget', async () => {
    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-smart-preview')).toHaveTextContent('Please ship this once QA has approved it.')
    })

    expect(screen.queryByTestId('widget-domain-status')).toBeNull()
    expect(screen.queryByTestId('widget-domain-mode-control')).toBeNull()
    expect(screen.queryByTestId('widget-mode-control')).toBeNull()
    expect(window.windowControls.setWidgetPreviewExpanded).toHaveBeenCalledWith(true)
  })

  it('renders a two-row idle layout with separate domain status, domain mode, and template controls', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      phase_label: 'Ready',
      is_processing: false,
      active_mode: null,
      smart_preview: null,
      pending_action_review: null,
      active_domain: {
        id: 'shipping',
        label: 'Shipping / Logistics',
        source: 'global_pin',
        rule_id: null,
        rule_label: null,
      },
    }

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-idle-layout')).toBeInTheDocument()
    })

    expect(screen.getByTestId('widget-secondary-controls')).toBeInTheDocument()
    expect(screen.getByTestId('widget-domain-status')).toHaveTextContent('Shipping')
    expect(screen.getByTestId('widget-domain-source')).toHaveTextContent('Pinned')
    expect(screen.getByTestId('widget-domain-mode-control')).toHaveTextContent('Domain mode')
    expect(screen.getByTestId('widget-mode-control')).toHaveTextContent('Template')
    expect(screen.getByTestId('widget-secondary-controls')).toHaveClass('grid-cols-3')
  })

  it('keeps the template selector visible when the skills request fails', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('skills unavailable'))
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      phase_label: 'Ready',
      is_processing: false,
      active_mode: null,
      smart_preview: null,
      pending_action_review: null,
      active_domain: null,
    }

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-idle-layout')).toBeInTheDocument()
    })

    expect(screen.getByTestId('widget-mode-control')).toHaveTextContent('Template')
    expect(screen.getByTestId('widget-mode-control')).toHaveTextContent('Professional Rewrite')
  })

  it('falls back to curated widget templates when the skills payload has no user-facing options', async () => {
    apiGetMock.mockResolvedValueOnce({
      data: {
        skills: [
          { id: 'system_hidden_internal_skill', name: 'Internal Hidden Skill' },
        ],
      },
    })
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      phase_label: 'Ready',
      is_processing: false,
      active_mode: null,
      smart_preview: null,
      pending_action_review: null,
      active_domain: null,
    }

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-idle-layout')).toBeInTheDocument()
    })

    expect(screen.getByTestId('widget-mode-control')).toHaveTextContent('Template')
    expect(screen.getByTestId('widget-mode-control')).toHaveTextContent('Professional Rewrite')
    expect(screen.getByRole('option', { name: 'Computer Use' })).toBeInTheDocument()
    expect(screen.queryByText('Internal Hidden Skill')).toBeNull()
  })

  it('renders reviewed desktop actions inline and posts approve decisions', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'transforming',
      smart_preview: null,
      pending_action_review: {
        run_id: 'review-1',
        action_type: 'mail_draft',
        title: 'Draft Email',
        summary: 'Open Mail with a draft to Sarah.',
        script: 'tell application "Mail"\nactivate\nend tell',
        language: 'applescript',
        status: 'pending',
        error: null,
      },
    }

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-action-review')).toHaveTextContent('Open Mail with a draft to Sarah.')
    })

    expect(screen.queryByTestId('widget-smart-preview')).toBeNull()
    expect(window.windowControls.setWidgetActionReviewExpanded).toHaveBeenCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/actions/review/approve', { run_id: 'review-1' })
    })
  })

  it('renders reviewed local task runs inline and posts approve decisions', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      smart_preview: null,
      pending_action_review: null,
      pending_review: {
        id: 'review-local-1',
        run_id: 'task-1',
        scope: 'local_task',
        kind: 'shell_command',
        title: 'Review local task',
        summary: 'Run git status',
        detail: null,
        command: 'git status',
        cwd: '/tmp/workspace',
        risk_level: 'low',
        status: 'pending',
        error: null,
        language: 'shell',
        script: 'git status',
      },
      active_task_run: {
        run_id: 'task-1',
        request_text: 'run git status',
        title: 'Review local task',
        status: 'pending_review',
        command: 'git status',
        cwd: '/tmp/workspace',
        created_at: '2026-04-10T00:00:00Z',
        updated_at: '2026-04-10T00:00:00Z',
        current_step_id: 'step-1',
        review_required: true,
        steps: [],
        output_blocks: [],
        result_summary: null,
        error: null,
      },
    }

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-action-review')).toHaveTextContent('Run git status')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/local/review/approve', {
        run_id: 'task-1',
        review_id: 'review-local-1',
      })
    })
  })

  it('renders multi-step task plans with ordered steps', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      smart_preview: null,
      pending_action_review: null,
      pending_review: {
        id: 'review-plan-1',
        run_id: 'task-plan-1',
        scope: 'local_task',
        kind: 'task_plan',
        title: 'Computer Use',
        summary: 'Execute 2 reviewed steps for: open Finder and search the repo for LocalTaskShellService',
        detail: '1. [Desktop] Open Finder.\nopen finder\n\n2. [Shell] Run rg -n -- LocalTaskShellService .\nrg -n -- LocalTaskShellService .',
        command: null,
        cwd: '/tmp/workspace',
        risk_level: 'medium',
        status: 'pending',
        error: null,
        language: null,
        script: '1. [Desktop] Open Finder.\nopen finder\n\n2. [Shell] Run rg -n -- LocalTaskShellService .\nrg -n -- LocalTaskShellService .',
        step_id: null,
      },
      active_task_run: {
        run_id: 'task-plan-1',
        request_text: 'open Finder and search the repo for LocalTaskShellService',
        source_intent: 'computer_use',
        run_kind: 'multi_step',
        title: 'Computer Use',
        plan_summary: 'Execute 2 reviewed steps for: open Finder and search the repo for LocalTaskShellService',
        status: 'pending_review',
        command: null,
        cwd: '/tmp/workspace',
        created_at: '2026-04-13T00:00:00Z',
        updated_at: '2026-04-13T00:00:00Z',
        current_step_id: 'step-1',
        review_required: true,
        steps: [
          {
            id: 'step-1',
            kind: 'desktop_action',
            title: 'Open Finder',
            summary: 'Open Finder.',
            status: 'pending',
            command: null,
            cwd: null,
            language: 'applescript',
            script: 'tell application id "com.apple.finder"\nreopen\nactivate\nend tell',
            execution_mode: 'reviewed',
            action_type: 'open_app',
            started_at: null,
            completed_at: null,
            exit_code: null,
            error: null,
          },
          {
            id: 'step-2',
            kind: 'shell_command',
            title: 'Search repo',
            summary: 'Run rg -n -- LocalTaskShellService .',
            status: 'pending',
            command: 'rg -n -- LocalTaskShellService .',
            cwd: '/tmp/workspace',
            language: 'shell',
            script: 'rg -n -- LocalTaskShellService .',
            started_at: null,
            completed_at: null,
            exit_code: null,
            error: null,
          },
        ],
        output_blocks: [],
        result_summary: null,
        error: null,
      },
    }

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-task-step-list')).toHaveTextContent('1. Open Finder')
    })

    expect(screen.getByTestId('widget-action-review')).toHaveTextContent('Review task plan')
    expect(screen.getByTestId('widget-task-step-list')).toHaveTextContent('2. Search repo')
  })

  it('renders multi-step progress with current and completed steps', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      is_processing: false,
      smart_preview: null,
      pending_action_review: null,
      pending_review: null,
      active_task_run: {
        run_id: 'task-progress-1',
        request_text: 'open Finder and search the repo for LocalTaskShellService',
        source_intent: 'computer_use',
        run_kind: 'multi_step',
        title: 'Computer Use',
        plan_summary: 'Execute 2 reviewed steps',
        status: 'running',
        command: null,
        cwd: '/tmp/workspace',
        created_at: '2026-04-13T00:00:00Z',
        updated_at: '2026-04-13T00:00:01Z',
        current_step_id: 'step-2',
        review_required: true,
        steps: [
          {
            id: 'step-1',
            kind: 'desktop_action',
            title: 'Open Finder',
            summary: 'Open Finder.',
            status: 'completed',
            command: null,
            cwd: null,
            started_at: '2026-04-13T00:00:00Z',
            completed_at: '2026-04-13T00:00:00.500Z',
            exit_code: 0,
            error: null,
          },
          {
            id: 'step-2',
            kind: 'shell_command',
            title: 'Search repo',
            summary: 'Run rg -n -- LocalTaskShellService .',
            status: 'running',
            command: 'rg -n -- LocalTaskShellService .',
            cwd: '/tmp/workspace',
            started_at: '2026-04-13T00:00:00.600Z',
            completed_at: null,
            exit_code: null,
            error: null,
          },
        ],
        output_blocks: [{ id: 'out-1', stream: 'stdout', text: 'backend/local_task_shell/service.py:1', truncated: false, updated_at: '2026-04-13T00:00:01Z' }],
        result_summary: null,
        error: null,
      },
    }

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-task-progress-steps')).toHaveTextContent('1. Open Finder')
    })

    expect(screen.getByTestId('widget-task-progress-steps')).toHaveTextContent('Done')
    expect(screen.getByTestId('widget-task-progress-steps')).toHaveTextContent('Running')
  })

  it('posts retry-mode approvals for failed multi-step tasks', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      smart_preview: null,
      pending_action_review: null,
      pending_review: {
        id: 'review-retry-1',
        run_id: 'task-retry-1',
        scope: 'local_task',
        kind: 'task_retry',
        title: 'Retry task',
        summary: 'Search repo failed. Retry from that step or rerun the full plan.',
        detail: 'Command exited with code 1.',
        command: null,
        cwd: '/tmp/workspace',
        risk_level: 'medium',
        status: 'pending',
        error: null,
        language: null,
        script: 'Command exited with code 1.',
        step_id: 'step-2',
      },
      active_task_run: {
        run_id: 'task-retry-1',
        request_text: 'open Finder and search the repo for LocalTaskShellService',
        source_intent: 'computer_use',
        run_kind: 'multi_step',
        title: 'Computer Use',
        plan_summary: 'Execute 2 reviewed steps',
        status: 'pending_review',
        command: null,
        cwd: '/tmp/workspace',
        created_at: '2026-04-13T00:00:00Z',
        updated_at: '2026-04-13T00:00:02Z',
        current_step_id: 'step-2',
        review_required: true,
        steps: [
          {
            id: 'step-1',
            kind: 'desktop_action',
            title: 'Open Finder',
            summary: 'Open Finder.',
            status: 'completed',
            command: null,
            cwd: null,
            started_at: '2026-04-13T00:00:00Z',
            completed_at: '2026-04-13T00:00:00.500Z',
            exit_code: 0,
            error: null,
          },
          {
            id: 'step-2',
            kind: 'shell_command',
            title: 'Search repo',
            summary: 'Run rg -n -- LocalTaskShellService .',
            status: 'failed',
            command: 'rg -n -- LocalTaskShellService .',
            cwd: '/tmp/workspace',
            started_at: '2026-04-13T00:00:00.600Z',
            completed_at: '2026-04-13T00:00:01Z',
            exit_code: 1,
            error: 'Command exited with code 1.',
          },
        ],
        output_blocks: [],
        result_summary: null,
        error: 'Command exited with code 1.',
      },
    }

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-action-review')).toHaveTextContent('Retry local task')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Retry step' }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/local/review/approve', {
        run_id: 'task-retry-1',
        review_id: 'review-retry-1',
        retry_mode: 'retry_failed_step',
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run from start' }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/local/review/approve', {
        run_id: 'task-retry-1',
        review_id: 'review-retry-1',
        retry_mode: 'rerun_all',
      })
    })
  })

  it('renders live transcript text and expands the widget while capture is active', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      phase_label: 'Ready',
      is_processing: false,
      active_mode: null,
      smart_preview: null,
      pending_action_review: null,
      live_transcription: null,
    }

    window.windowControls.getLocalLiveTranscriptionState = vi.fn().mockResolvedValue({
        session_id: 'live-1',
        mode: 'dictation',
        state: 'streaming',
        text: 'hello from the live transcript',
        source: 'native_local',
        is_final: false,
        updated_at: '2026-04-02T12:00:00.000Z',
        error: null,
      })

    window.windowControls.getCaptureState = vi.fn().mockResolvedValue({
      is_recording: true,
      is_testing: false,
      mode: 'dictation',
      phase: 'recording',
      amplitude: 0.2,
      error: null,
      active_device_id: null,
      active_device_label: null,
      fallback_to_default: false,
      fallback_notice: null,
    })

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-live-transcript')).toHaveTextContent('hello from the live transcript')
    })

    expect(screen.getByText('Will paste exactly what you say.')).toBeInTheDocument()
    expect(window.windowControls.setWidgetLiveTranscriptExpanded).toHaveBeenCalledWith(true)
  })

  it('clears the live listening state once capture returns to idle', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'ready',
      phase_label: 'Ready',
      is_processing: false,
      active_mode: null,
      smart_preview: null,
      pending_action_review: null,
      live_transcription: null,
    }

    window.windowControls.getLocalLiveTranscriptionState = vi.fn().mockResolvedValue({
      session_id: 'live-2',
      mode: 'dictation',
      state: 'streaming',
      text: 'still visible while recording',
      source: 'native_local',
      is_final: false,
      updated_at: '2026-04-03T12:00:00.000Z',
      error: null,
    })

    window.windowControls.getCaptureState = vi.fn().mockResolvedValue({
      is_recording: true,
      is_testing: false,
      mode: 'dictation',
      phase: 'recording',
      amplitude: 0.2,
      error: null,
      active_device_id: null,
      active_device_label: null,
      fallback_to_default: false,
      fallback_notice: null,
    })

    render(<FloatingWidget />)

    await waitFor(() => {
      expect(screen.getByTestId('widget-live-transcript')).toHaveTextContent('still visible while recording')
    })

    await act(async () => {
      captureStateListener?.({
        is_recording: false,
        is_testing: false,
        mode: null,
        phase: 'idle',
        amplitude: 0,
        error: null,
        active_device_id: null,
        active_device_label: null,
        fallback_to_default: false,
        fallback_notice: null,
      })
      await Promise.resolve()
    })

    expect(screen.queryByTestId('widget-live-transcript')).toBeNull()
    expect(screen.getByTestId('widget-idle-layout')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeInTheDocument()
  })

  it('renders error-state action reviews with darker styling and dismisses them', async () => {
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'error',
      smart_preview: null,
      last_error: 'Can’t get application "CamoCam".',
      pending_action_review: {
        run_id: 'review-2',
        action_type: 'open_app',
        title: 'Open App',
        summary: 'Bring Camo Studio to the front.',
        script: 'tell application id "com.reincubate.macos.camo"\nactivate\nend tell',
        language: 'applescript',
        status: 'error',
        error: 'Can’t get application "CamoCam".',
      },
    }

    render(<FloatingWidget />)

    const review = await screen.findByTestId('widget-action-review')
    expect(review.innerHTML).toContain('rgba(9,14,20,0.97)')
    expect(review).toHaveTextContent('Action review error')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/actions/review/reject', { run_id: 'review-2' })
    })
  })

  it('auto-dismisses stale action review errors and clears them before recording again', async () => {
    vi.useFakeTimers()
    runtimeState.snapshot.status = {
      ...runtimeState.snapshot.status,
      phase: 'error',
      smart_preview: null,
      last_error: 'Can’t get application "CamoCam".',
      pending_action_review: {
        run_id: 'review-3',
        action_type: 'open_app',
        title: 'Open App',
        summary: 'Bring Camo Studio to the front.',
        script: 'tell application id "com.reincubate.macos.camo"\nreopen\nactivate\nend tell',
        language: 'applescript',
        status: 'error',
        error: 'Can’t get application "CamoCam".',
      },
    }

    render(<FloatingWidget />)

    expect(screen.getByTestId('widget-action-review')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8500)
    })
    expect(apiPostMock).toHaveBeenCalledWith('/actions/review/reject', { run_id: 'review-3' })

    apiPostMock.mockClear()
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Smart' }))
      await Promise.resolve()
    })
    expect(apiPostMock).toHaveBeenCalledWith('/actions/review/reject', { run_id: 'review-3' })
    expect(window.windowControls.toggleRecording).toHaveBeenCalledWith('smart_transform')

    vi.useRealTimers()
  }, 10000)
})
