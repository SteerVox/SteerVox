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
}

describe('onboarding selectors', () => {
  it('computes canonical readiness from permissions and applied providers', () => {
    const keysSet: KeyStatusMap = { groq: true }

    expect(computeReadiness(baseConfig, keysSet, 'granted', true)).toEqual({
      microphoneReady: true,
      accessibilityReady: true,
      dictationProviderReady: true,
      rewriteProviderReady: false,
      dictationReady: true,
      rewriteReady: false,
    })
  })

  it('marks onboarding complete only after a real dictation run exists', () => {
    const keysSet: KeyStatusMap = { groq: true }
    const usageStats: UsageStats = {
      tracking_started_at: '2026-03-25T00:00:00.000Z',
      dictation_runs: 1,
      smart_runs: 0,
      fastest_dictation_stt_ms: null,
      fastest_smart_stt_ms: null,
      time_saved_seconds_total: 0,
    }

    expect(computeOnboardingState(baseConfig, keysSet, 'granted', true, null)).toMatchObject({
      dictationReady: true,
      dictationTested: false,
      completed: false,
    })
    expect(computeOnboardingState(baseConfig, keysSet, 'granted', true, usageStats)).toMatchObject({
      dictationReady: true,
      dictationTested: true,
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
})
