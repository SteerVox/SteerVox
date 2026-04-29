import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRuntimeStore } from './runtimeStore'

const { apiGetMock, isApiHttpErrorMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  isApiHttpErrorMock: vi.fn().mockReturnValue(false),
}))

vi.mock('./api', () => ({
  apiGet: apiGetMock,
  isApiHttpError: isApiHttpErrorMock,
}))

class MockRuntimeEventStream {
  static instances: MockRuntimeEventStream[] = []

  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()

  constructor() {
    MockRuntimeEventStream.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener) {
    const bucket = this.listeners.get(type) ?? new Set<(event: MessageEvent<string>) => void>()
    bucket.add(listener as (event: MessageEvent<string>) => void)
    this.listeners.set(type, bucket)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener as (event: MessageEvent<string>) => void)
  }

  emit(type: string, payload: unknown, seq = 1) {
    const event = {
      data: JSON.stringify({
        seq,
        type,
        data: payload,
        emitted_at: seq * 1000,
      }),
    } as MessageEvent<string>
    this.listeners.get(type)?.forEach((listener) => listener(event))
  }

  open() {
    this.onopen?.(new Event('open'))
  }

  fail() {
    this.onerror?.(new Event('error'))
  }
}

async function createMockRuntimeEventStream() {
  return new MockRuntimeEventStream()
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('runtime store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockRuntimeEventStream.instances = []
    apiGetMock.mockReset()
    isApiHttpErrorMock.mockReset()
    isApiHttpErrorMock.mockReturnValue(false)
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/providers/models') {
        return Promise.resolve({
          data: {
            llm: { groq: [] },
            stt: { groq: [] },
            vision: { lmstudio: [] },
          },
        })
      }

      if (path === '/status') {
        return Promise.resolve({
          data: {
            backend_ready: true,
            is_recording: false,
            is_processing: false,
            active_mode: null,
            active_skill: 'system_grammar',
            audio_amplitude: 0,
            last_error: null,
            pending_paste_text: null,
            pending_paste: null,
            pending_notification: null,
            pending_action_review: null,
            missing_api_keys: false,
            recording_cues_enabled: false,
            restore_clipboard_after_paste: true,
            phase: 'ready',
            phase_label: 'Ready',
            captured_context: null,
            context_warning: null,
            last_smart_run: null,
            pipeline_timings: {
              record_start: null,
              stt_done: null,
              route_done: null,
              transform_done: null,
              paste_ack_done: null,
            },
          },
        })
      }

      throw new Error(`Unexpected apiGet path: ${path}`)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ingests runtime snapshots and refreshes provider models once', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    await flushMicrotasks()

    expect(MockRuntimeEventStream.instances).toHaveLength(1)
    const source = MockRuntimeEventStream.instances[0]
    source.open()
    source.emit('snapshot', {
        status: {
          backend_ready: true,
          phase: 'ready',
          phase_label: 'Ready',
          is_recording: false,
          is_processing: false,
          active_mode: null,
          active_skill: 'system_grammar',
          audio_amplitude: 0,
          pending_paste_text: null,
          pending_paste: null,
          pending_notification: null,
          last_error: null,
          captured_context: null,
          missing_api_keys: false,
          context_warning: null,
          last_smart_run: null,
          recording_cues_enabled: false,
          restore_clipboard_after_paste: true,
          pipeline_timings: {
            record_start: null,
            stt_done: null,
            route_done: null,
            transform_done: null,
            paste_ack_done: null,
          },
        },
        usage: {
          tracking_started_at: '2026-03-26T00:00:00.000Z',
          dictation_runs: 2,
          smart_runs: 1,
          fastest_dictation_stt_ms: null,
          fastest_smart_stt_ms: null,
          time_saved_seconds_total: 14,
        },
        config: {
          stt: {
            provider: 'groq',
            model: 'whisper-large-v3-turbo',
            language: 'en',
            language_mode: 'fixed',
            preferred_languages: ['en'],
          },
          llm: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            temperature: 0,
            routing: {
              enabled: true,
              provider: 'groq',
              model: 'groq/compound-mini',
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
            default_skill_id: 'system_grammar',
            app_skill_defaults: [],
          },
          audio: {
            input_device: null,
            input_device_id: null,
            input_device_label: null,
            enable_recording_cues: false,
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
          domains: {
            mode: 'off',
            app_domain_defaults: [],
          },
          privacy: {
            restore_clipboard_after_paste: true,
            minimize_sensitive_context: false,
            sensitive_targets: [],
          },
        },
        keys_set: {
          groq: true,
        },
        revisions: {
          config: 1,
          providers: 0,
          history: 2,
          inbox: 3,
          skills: 4,
          domains: 0,
          writing_tools: 0,
          usage: 5,
        },
    }, 1)

    await flushMicrotasks()

    const state = store.getSnapshot()
    expect(state.connectionState).toBe('connected')
    expect(state.hasSnapshot).toBe(true)
    expect(state.lastAppliedSeq).toBe(1)
    expect(state.snapshot.config?.stt.provider).toBe('groq')
    expect(state.snapshot.usageStats?.dictation_runs).toBe(2)
    expect(state.snapshot.keysSet.groq).toBe(true)
    expect(state.snapshot.providerModels?.llm).toEqual({ groq: [] })
    expect(state.snapshot.providerModels?.vision).toEqual({ lmstudio: [] })
    expect(['checking', 'ready']).toContain(state.localEnvironment.status)
    expect(apiGetMock).toHaveBeenCalledWith('/providers/models', expect.objectContaining({ timeout: 10000 }))

    unsubscribe()
    store.dispose()
    expect(source.close).toHaveBeenCalledTimes(1)
  })

  it('applies smart preview runtime events without waiting for a full status refresh', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    await flushMicrotasks()

    const source = MockRuntimeEventStream.instances[0]
    source.open()
    source.emit('snapshot', {
      status: {
        backend_ready: true,
        phase: 'transforming',
        phase_label: 'Smart',
        is_recording: false,
        is_processing: true,
        active_mode: 'smart_transform',
        active_skill: 'system_grammar',
        audio_amplitude: 0,
        pending_paste_text: null,
        pending_paste: null,
        pending_notification: null,
        last_error: null,
        captured_context: null,
        missing_api_keys: false,
        context_warning: null,
        last_smart_run: null,
        smart_preview: null,
        recording_cues_enabled: false,
        restore_clipboard_after_paste: true,
        pipeline_timings: {
          record_start: null,
          stt_done: null,
          route_done: null,
          transform_done: null,
          paste_ack_done: null,
        },
      },
      usage: null,
      config: null,
      keys_set: {},
      revisions: {
        config: 0,
        providers: 0,
        history: 0,
        inbox: 0,
        skills: 0,
        domains: 0,
        writing_tools: 0,
        usage: 0,
      },
    }, 1)

    source.emit('smart_preview', {
      run_id: 'preview-1',
      mode: 'smart_transform',
      state: 'streaming',
      text: 'Please ship this once QA',
      final_text: null,
      error: null,
      updated_at: '2026-03-28T00:00:00.000Z',
    }, 2)

    await flushMicrotasks()

    expect(store.getSnapshot().snapshot.status?.smart_preview).toEqual({
      run_id: 'preview-1',
      mode: 'smart_transform',
      state: 'streaming',
      text: 'Please ship this once QA',
      final_text: null,
      error: null,
      updated_at: '2026-03-28T00:00:00.000Z',
    })

    unsubscribe()
    store.dispose()
  })

  it('applies live transcription runtime events without waiting for a full status refresh', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    await flushMicrotasks()

    const source = MockRuntimeEventStream.instances[0]
    source.open()
    source.emit('snapshot', {
      status: {
        backend_ready: true,
        phase: 'ready',
        phase_label: 'Ready',
        is_recording: false,
        is_processing: false,
        active_mode: null,
        active_skill: 'system_grammar',
        audio_amplitude: 0,
        pending_paste_text: null,
        pending_paste: null,
        pending_notification: null,
        pending_action_review: null,
        last_error: null,
        captured_context: null,
        missing_api_keys: false,
        context_warning: null,
        last_smart_run: null,
        smart_preview: null,
        live_transcription: null,
        recording_cues_enabled: false,
        restore_clipboard_after_paste: true,
        pipeline_timings: {
          record_start: null,
          stt_done: null,
          route_done: null,
          transform_done: null,
          paste_ack_done: null,
        },
      },
      usage: null,
      config: null,
      keys_set: {},
      revisions: {
        config: 0,
        providers: 0,
        history: 0,
        inbox: 0,
        skills: 0,
        domains: 0,
        writing_tools: 0,
        usage: 0,
      },
    }, 1)

    source.emit('live_transcription', {
      session_id: 'live-1',
      mode: 'dictation',
      state: 'streaming',
      text: 'hello from live mode',
      source: 'local',
      is_final: false,
      updated_at: '2026-04-02T12:00:00.000Z',
      error: null,
    }, 2)

    await flushMicrotasks()

    expect(store.getSnapshot().snapshot.status?.live_transcription).toEqual({
      session_id: 'live-1',
      mode: 'dictation',
      state: 'streaming',
      text: 'hello from live mode',
      source: 'local',
      is_final: false,
      updated_at: '2026-04-02T12:00:00.000Z',
      error: null,
    })

    unsubscribe()
    store.dispose()
  })

  it('applies pending action review runtime events without a full status refresh', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    await flushMicrotasks()

    const source = MockRuntimeEventStream.instances[0]
    source.open()
    source.emit('snapshot', {
      status: {
        backend_ready: true,
        phase: 'transforming',
        phase_label: 'Smart',
        is_recording: false,
        is_processing: true,
        active_mode: 'smart_transform',
        active_skill: 'system_grammar',
        audio_amplitude: 0,
        pending_paste_text: null,
        pending_paste: null,
        pending_notification: null,
        pending_action_review: null,
        last_error: null,
        captured_context: null,
        missing_api_keys: false,
        context_warning: null,
        last_smart_run: null,
        smart_preview: null,
        recording_cues_enabled: false,
        restore_clipboard_after_paste: true,
        pipeline_timings: {
          record_start: null,
          stt_done: null,
          route_done: null,
          transform_done: null,
          paste_ack_done: null,
        },
      },
      usage: null,
      config: null,
      keys_set: {},
      revisions: {
        config: 0,
        providers: 0,
        history: 0,
        inbox: 0,
        skills: 0,
        domains: 0,
        writing_tools: 0,
        usage: 0,
      },
    }, 1)

    source.emit('pending_action_review', {
      run_id: 'review-1',
      action_type: 'open_url',
      title: 'Open URL',
      summary: 'Open https://example.com in the default browser.',
      script: 'open location "https://example.com"',
      language: 'applescript',
      status: 'pending',
      error: null,
    }, 2)

    await flushMicrotasks()

    expect(store.getSnapshot().snapshot.status?.pending_action_review).toEqual({
      run_id: 'review-1',
      action_type: 'open_url',
      title: 'Open URL',
      summary: 'Open https://example.com in the default browser.',
      script: 'open location "https://example.com"',
      language: 'applescript',
      status: 'pending',
      error: null,
    })

    unsubscribe()
    store.dispose()
  })

  it('applies local task review and progress runtime events without a full status refresh', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    await flushMicrotasks()

    const source = MockRuntimeEventStream.instances[0]
    source.open()
    source.emit('snapshot', {
      status: {
        backend_ready: true,
        phase: 'ready',
        phase_label: 'Ready',
        is_recording: false,
        is_processing: false,
        active_mode: null,
        active_skill: 'system_local_task',
        audio_amplitude: 0,
        pending_paste_text: null,
        pending_paste: null,
        pending_notification: null,
        pending_action_review: null,
        pending_review: null,
        active_task_run: null,
        task_result_summary: null,
        last_error: null,
        captured_context: null,
        missing_api_keys: false,
        context_warning: null,
        last_smart_run: null,
        smart_preview: null,
        recording_cues_enabled: false,
        restore_clipboard_after_paste: true,
        pipeline_timings: {
          record_start: null,
          stt_done: null,
          route_done: null,
          transform_done: null,
          paste_ack_done: null,
        },
      },
      usage: null,
      config: null,
      keys_set: {},
      revisions: {
        config: 0,
        providers: 0,
        history: 0,
        tasks: 0,
        inbox: 0,
        skills: 0,
        domains: 0,
        writing_tools: 0,
        usage: 0,
      },
    }, 1)

    source.emit('pending_review', {
      id: 'review-1',
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
    }, 2)
    source.emit('active_task_run', {
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
    }, 3)

    await flushMicrotasks()

    expect(store.getSnapshot().snapshot.status?.pending_review?.scope).toBe('local_task')
    expect(store.getSnapshot().snapshot.status?.active_task_run?.command).toBe('git status')

    unsubscribe()
    store.dispose()
  })

  it('ignores out-of-order status events', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    await flushMicrotasks()

    const source = MockRuntimeEventStream.instances[0]
    source.open()
    source.emit('snapshot', {
        status: null,
        usage: null,
        config: null,
        keys_set: {},
        revisions: {
          config: 0,
          providers: 0,
          history: 0,
          inbox: 0,
          skills: 0,
          domains: 0,
          writing_tools: 0,
          usage: 0,
        },
    }, 1)
    source.emit('status', {
      backend_ready: true,
      is_recording: false,
      is_processing: false,
      active_mode: null,
      active_skill: 'system_grammar',
      audio_amplitude: 0,
      last_error: null,
      pending_paste_text: null,
      pending_paste: null,
      pending_notification: null,
      missing_api_keys: false,
      recording_cues_enabled: false,
      restore_clipboard_after_paste: true,
      phase: 'ready',
      phase_label: 'Ready',
      captured_context: null,
      context_warning: null,
      last_smart_run: null,
      pipeline_timings: {
        record_start: null,
        stt_done: null,
        route_done: null,
        transform_done: null,
        paste_ack_done: null,
      },
    }, 3)
    source.emit('status', {
      backend_ready: true,
      is_recording: false,
      is_processing: false,
      active_mode: null,
      active_skill: 'system_grammar',
      audio_amplitude: 0,
      last_error: null,
      pending_paste_text: null,
      pending_paste: null,
      pending_notification: null,
      missing_api_keys: false,
      recording_cues_enabled: false,
      restore_clipboard_after_paste: true,
      phase: 'preparing_paste',
      phase_label: 'Preparing paste',
      captured_context: null,
      context_warning: null,
      last_smart_run: null,
      pipeline_timings: {
        record_start: null,
        stt_done: null,
        route_done: null,
        transform_done: null,
        paste_ack_done: null,
      },
    }, 2)

    await flushMicrotasks()

    expect(store.getSnapshot().snapshot.status?.phase).toBe('ready')
    expect(store.getSnapshot().lastAppliedSeq).toBe(3)

    unsubscribe()
    store.dispose()
  })

  it('repairs impossible preparing-paste state with a targeted status refresh', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    await flushMicrotasks()

    const source = MockRuntimeEventStream.instances[0]
    source.open()
    source.emit('status', {
      backend_ready: true,
      is_recording: false,
      is_processing: false,
      active_mode: null,
      active_skill: 'system_grammar',
      audio_amplitude: 0,
      last_error: null,
      pending_paste_text: null,
      pending_paste: null,
      pending_notification: null,
      missing_api_keys: false,
      recording_cues_enabled: false,
      restore_clipboard_after_paste: true,
      phase: 'preparing_paste',
      phase_label: 'Preparing paste',
      captured_context: null,
      context_warning: null,
      last_smart_run: null,
      pipeline_timings: {
        record_start: null,
        stt_done: null,
        route_done: null,
        transform_done: null,
        paste_ack_done: null,
      },
    }, 5)

    await flushMicrotasks()

    expect(apiGetMock).toHaveBeenCalledWith('/status', expect.objectContaining({ timeout: 10000 }))
    expect(store.getSnapshot().snapshot.status?.phase).toBe('ready')

    unsubscribe()
    store.dispose()
  })

  it('merges pending paste events so delivery still works if the full status update is missed', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    apiGetMock.mockImplementation((path: string) => {
      if (path === '/providers/models') {
        return Promise.resolve({
          data: {
            llm: { groq: [] },
            stt: { groq: [] },
            vision: { lmstudio: [] },
          },
        })
      }

      if (path === '/status') {
        return Promise.resolve({
          data: {
            backend_ready: true,
            is_recording: false,
            is_processing: false,
            active_mode: null,
            active_skill: 'system_dictation',
            audio_amplitude: 0,
            last_error: null,
            pending_paste_text: 'dictated text',
            pending_paste: {
              id: 'paste-1',
              text: 'dictated text',
              restore_clipboard_after_paste: true,
            },
            pending_notification: null,
            pending_action_review: null,
            missing_api_keys: false,
            recording_cues_enabled: false,
            restore_clipboard_after_paste: true,
            phase: 'preparing_paste',
            phase_label: 'Preparing paste',
            captured_context: null,
            context_warning: null,
            last_smart_run: null,
            pipeline_timings: {
              record_start: null,
              stt_done: null,
              route_done: null,
              transform_done: null,
              paste_ack_done: null,
            },
          },
        })
      }

      throw new Error(`Unexpected apiGet path: ${path}`)
    })

    await flushMicrotasks()

    const source = MockRuntimeEventStream.instances[0]
    source.open()
    source.emit('snapshot', {
      status: {
        backend_ready: true,
        is_recording: false,
        is_processing: false,
        active_mode: null,
        active_skill: 'system_dictation',
        audio_amplitude: 0,
        last_error: null,
        pending_paste_text: null,
        pending_paste: null,
        pending_notification: null,
        pending_action_review: null,
        missing_api_keys: false,
        recording_cues_enabled: false,
        restore_clipboard_after_paste: true,
        phase: 'ready',
        phase_label: 'Ready',
        captured_context: null,
        context_warning: null,
        last_smart_run: null,
        pipeline_timings: {
          record_start: null,
          stt_done: null,
          route_done: null,
          transform_done: null,
          paste_ack_done: null,
        },
      },
      usage: null,
      config: null,
      keys_set: {},
      revisions: {
        config: 0,
        providers: 0,
        history: 0,
        inbox: 0,
        skills: 0,
        domains: 0,
        writing_tools: 0,
        usage: 0,
      },
    }, 1)

    source.emit('pending_paste', {
      pending_paste: {
        id: 'paste-1',
        text: 'dictated text',
        restore_clipboard_after_paste: true,
      },
      pending_paste_text: 'dictated text',
    }, 2)

    await flushMicrotasks()

    expect(store.getSnapshot().snapshot.status?.pending_paste).toEqual({
      id: 'paste-1',
      text: 'dictated text',
      restore_clipboard_after_paste: true,
    })
    expect(store.getSnapshot().snapshot.status?.pending_paste_text).toBe('dictated text')
    expect(store.getSnapshot().snapshot.status?.phase).toBe('preparing_paste')
    expect(apiGetMock).toHaveBeenCalledWith('/status', expect.objectContaining({ timeout: 10000 }))

    unsubscribe()
    store.dispose()
  })

  it('bumps invalidation tokens and reconnects with stale last-known-good state', async () => {
    const store = createRuntimeStore(createMockRuntimeEventStream)
    const unsubscribe = store.subscribe(() => undefined)

    await flushMicrotasks()

    const firstSource = MockRuntimeEventStream.instances[0]
    firstSource.open()
    firstSource.emit('snapshot', {
      status: null,
      usage: null,
      config: null,
      keys_set: {},
      revisions: {
        config: 0,
        providers: 0,
        history: 0,
        inbox: 0,
        skills: 0,
        domains: 0,
        writing_tools: 0,
        usage: 0,
      },
    }, 1)

    firstSource.emit('skills_invalidated', {
      revision: 2,
    }, 2)

    expect(store.getSnapshot().invalidationTokens.skills).toBe(1)
    expect(store.getSnapshot().snapshot.revisions.skills).toBe(2)

    firstSource.fail()
    expect(store.getSnapshot().connectionState).toBe('stale')

    await vi.advanceTimersByTimeAsync(250)
    await flushMicrotasks()

    expect(MockRuntimeEventStream.instances).toHaveLength(2)
    unsubscribe()
    store.dispose()
  })
})
