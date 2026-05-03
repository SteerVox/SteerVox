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
      model: 'google/gemma-4-e4b',
      temperature: 0,
    },
  },
  vision: {
    enabled: true,
    model: 'google/gemma-4-e4b',
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
    lmstudio: [{ id: 'google/gemma-4-e4b', name: 'Gemma 4 E4B', discovered: true, loaded: false, smart_capable: true }],
    nvidia: [{ id: 'minimaxai/minimax-m2.7', name: 'MiniMax M2.7' }],
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
    expect(updated.llm.model).toBe('google/gemma-4-e4b')
    expect(updated.llm.routing.provider).toBe('lmstudio')
    expect(updated.llm.routing.model).toBe('google/gemma-4-e4b')
  })

  it('mirrors the Smart router model when the LLM model changes directly', () => {
    const updated = applyModelSelection(baseConfig, 'llm', 'minimaxai/minimax-m2.7')

    expect(updated.llm.model).toBe('minimaxai/minimax-m2.7')
    expect(updated.llm.routing.provider).toBe(baseConfig.llm.provider)
    expect(updated.llm.routing.model).toBe('minimaxai/minimax-m2.7')
  })

  it('prefers whisper turbo when switching back to the local stt provider', () => {
    const updated = applyProviderSelection(baseConfig, providerModels, 'stt', 'mlx-whisper')

    expect(updated.stt.provider).toBe('mlx-whisper')
    expect(updated.stt.model).toBe('mlx-community/whisper-large-v3-turbo')
  })

  it('keeps Gemma 4 E4B as the LM Studio default even when discovery returns other local models first', () => {
    const updated = applyProviderSelection(baseConfig, {
      ...providerModels,
      llm: {
        ...providerModels.llm,
        lmstudio: [
          { id: 'qwen/qwen3-4b-thinking-2507', name: 'Qwen 3 4B Thinking', discovered: true, loaded: true, smart_capable: true },
        ],
      },
    }, 'llm', 'lmstudio')

    expect(updated.llm.provider).toBe('lmstudio')
    expect(updated.llm.model).toBe('google/gemma-4-e4b')
    expect(updated.llm.routing.model).toBe('google/gemma-4-e4b')
  })

  it('prefers MiniMax M2.7 when switching to the NVIDIA Smart provider', () => {
    const updated = applyProviderSelection(baseConfig, providerModels, 'llm', 'nvidia')

    expect(updated.llm.provider).toBe('nvidia')
    expect(updated.llm.model).toBe('minimaxai/minimax-m2.7')
    expect(updated.llm.routing.provider).toBe('nvidia')
    expect(updated.llm.routing.model).toBe('minimaxai/minimax-m2.7')
  })
})
