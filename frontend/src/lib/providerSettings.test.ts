import { describe, expect, it } from 'vitest'

import { applyApiKeyProviderSelection, applyModelSelection, applyProviderSelection } from './providerSettings'
import type { AppConfig, ProviderModels } from '../types'

const baseConfig: AppConfig = {
  stt: {
    provider: 'mlx-whisper',
    model: 'mlx-community/whisper-large-v3-turbo',
    language: 'en',
    language_mode: 'fixed',
    preferred_languages: ['en'],
  },
  llm: {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    temperature: 0,
    routing: {
      enabled: true,
      provider: 'lmstudio',
      model: 'local-model',
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
    default_skill_id: 'system_dictation',
    app_skill_defaults: [],
  },
  domains: {
    mode: 'off',
    app_domain_defaults: [],
  },
  audio: {
    input_device: null,
    input_device_id: null,
    input_device_label: null,
    enable_recording_cues: false,
    live_transcription_mode: 'off',
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
}

const providerModels: ProviderModels = {
  llm: {
    groq: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }],
    lmstudio: [{ id: 'local-model', name: 'Local Model' }],
  },
  stt: {
    nvidia: [
      { id: 'openai/whisper-large-v3', name: 'Whisper Large v3' },
      { id: 'nvidia/canary-1b-asr', name: 'Canary 1B ASR' },
    ],
    'mlx-whisper': [
      { id: 'mlx-community/whisper-large-v3-turbo', name: 'Whisper Turbo' },
      { id: 'mlx-community/whisper-base-mlx', name: 'Whisper Base' },
    ],
  },
  vision: {
    lmstudio: [],
  },
}

describe('providerSettings', () => {
  it('does not change the active stt provider when selecting an api key target', () => {
    const selection = applyApiKeyProviderSelection(baseConfig, 'nvidia')

    expect(selection.nextApiProvider).toBe('nvidia')
    expect(selection.nextDraftConfig).toEqual(baseConfig)
    expect(selection.nextDraftConfig.stt.provider).toBe('mlx-whisper')
    expect(selection.nextDraftConfig.stt.model).toBe('mlx-community/whisper-large-v3-turbo')
  })

  it('updates only the requested provider section when the real stt picker changes', () => {
    const updated = applyProviderSelection(baseConfig, providerModels, 'stt', 'nvidia')

    expect(updated.stt.provider).toBe('nvidia')
    expect(updated.stt.model).toBe('openai/whisper-large-v3')
    expect(updated.llm.provider).toBe(baseConfig.llm.provider)
    expect(updated.llm.model).toBe(baseConfig.llm.model)
  })

  it('mirrors the Smart router provider and model when the LLM provider changes', () => {
    const updated = applyProviderSelection(baseConfig, providerModels, 'llm', 'lmstudio')

    expect(updated.llm.provider).toBe('lmstudio')
    expect(updated.llm.model).toBe('local-model')
    expect(updated.llm.routing.provider).toBe('lmstudio')
    expect(updated.llm.routing.model).toBe('local-model')
  })

  it('mirrors the Smart router model when the LLM model changes directly', () => {
    const updated = applyModelSelection(baseConfig, 'llm', 'moonshotai/kimi-k2-instruct-0905')

    expect(updated.llm.model).toBe('moonshotai/kimi-k2-instruct-0905')
    expect(updated.llm.routing.provider).toBe(baseConfig.llm.provider)
    expect(updated.llm.routing.model).toBe('moonshotai/kimi-k2-instruct-0905')
  })

  it('prefers whisper turbo when switching back to the local stt provider', () => {
    const updated = applyProviderSelection(baseConfig, providerModels, 'stt', 'mlx-whisper')

    expect(updated.stt.provider).toBe('mlx-whisper')
    expect(updated.stt.model).toBe('mlx-community/whisper-large-v3-turbo')
  })
})
