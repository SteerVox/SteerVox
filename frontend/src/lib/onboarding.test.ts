import { describe, expect, it } from 'vitest'

import { computeOnboardingState, computeReadiness } from './onboarding'
import type { AppConfig, KeyStatusMap, UsageStats } from '../types'

const baseConfig: AppConfig = {
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
    model: 'google/gemma-4-e4b',
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
}

describe('onboarding selectors', () => {
  it('computes canonical readiness from permissions and applied providers', () => {
    const keysSet: KeyStatusMap = { groq: true, anthropic: true }

    expect(computeReadiness(baseConfig, keysSet, 'granted', true)).toMatchObject({
      microphoneReady: true,
      accessibilityReady: true,
      dictationProviderReady: true,
      rewriteProviderReady: true,
      dictationReady: true,
      rewriteReady: true,
      dictationProviderLabel: 'Groq',
      rewriteProviderLabel: 'Anthropic',
    })
  })

  it('marks onboarding complete only after Dictation and Smart both succeed once', () => {
    const keysSet: KeyStatusMap = { groq: true, anthropic: true }
    const usageStats: UsageStats = {
      tracking_started_at: '2026-03-25T00:00:00.000Z',
      dictation_runs: 1,
      smart_runs: 1,
      fastest_dictation_stt_ms: null,
      fastest_smart_stt_ms: null,
      time_saved_seconds_total: 0,
    }

    expect(computeOnboardingState(baseConfig, keysSet, 'granted', true, null)).toMatchObject({
      dictationReady: true,
      dictationTested: false,
      smartTested: false,
      completed: false,
    })
    expect(computeOnboardingState(baseConfig, keysSet, 'granted', true, usageStats)).toMatchObject({
      dictationReady: true,
      dictationTested: true,
      smartTested: true,
      completed: true,
    })
  })

  it('treats nvidia as a keyed provider for both dictation and Smart readiness', () => {
    const nvidiaConfig: AppConfig = {
      ...baseConfig,
      stt: {
        ...baseConfig.stt,
        provider: 'nvidia',
        model: 'openai/whisper-large-v3',
      },
      llm: {
        ...baseConfig.llm,
        provider: 'nvidia',
        model: 'moonshotai/kimi-k2-instruct-0905',
      },
    }

    expect(computeReadiness(nvidiaConfig, {}, 'granted', true)).toMatchObject({
      dictationProviderReady: false,
      rewriteProviderReady: false,
    })
    expect(computeReadiness(nvidiaConfig, { nvidia: true }, 'granted', true)).toMatchObject({
      dictationProviderReady: true,
      rewriteProviderReady: true,
    })
  })

  it('marks LM Studio ready when the selected local model is reachable even if it is not loaded yet', () => {
    const lmStudioConfig: AppConfig = {
      ...baseConfig,
      stt: {
        ...baseConfig.stt,
        provider: 'groq',
      },
      llm: {
        ...baseConfig.llm,
        provider: 'lmstudio',
        model: 'google/gemma-4-e4b',
      },
    }

    expect(computeReadiness(
      lmStudioConfig,
      { groq: true },
      'granted',
      true,
      {
        llm: {
          lmstudio: [{ id: 'google/gemma-4-e4b', name: 'Gemma 4 E4B', discovered: false, loaded: false, smart_capable: true }],
        },
        stt: {
          groq: [],
        },
        vision: {
          lmstudio: [],
        },
      },
    )).toMatchObject({
      rewriteProviderReady: false,
    })

    expect(computeReadiness(
      lmStudioConfig,
      { groq: true },
      'granted',
      true,
      {
        llm: {
          lmstudio: [{ id: 'google/gemma-4-e4b', name: 'Gemma 4 E4B', discovered: true, loaded: false, smart_capable: false }],
        },
        stt: {
          groq: [],
        },
        vision: {
          lmstudio: [],
        },
      },
    )).toMatchObject({
      rewriteProviderReady: true,
    })
  })

  it('does not mark MLX Whisper ready when the local runtime is unavailable', () => {
    const mlxConfig: AppConfig = {
      ...baseConfig,
      stt: {
        ...baseConfig.stt,
        provider: 'mlx-whisper',
      },
    }

    expect(computeReadiness(mlxConfig, {}, 'granted', true)).toMatchObject({
      dictationProviderReady: false,
    })

    expect(computeReadiness(
      mlxConfig,
      {},
      'granted',
      true,
      null,
      null,
      {
        supported: true,
        installed: true,
        ffmpeg_available: true,
        phase: 'ready',
        label: 'Ready',
        detail: 'Installed',
        progress: null,
        logs: [],
        can_install: true,
        venv_available: true,
      },
    )).toMatchObject({
      dictationProviderReady: true,
    })
  })
})
