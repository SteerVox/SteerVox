import { describe, expect, it } from 'vitest'

import { deriveLiveTranscriptionUiState, mapLiveTranscriptionControlValue, providerSupportsLivePreview } from './liveTranscriptionSettings'

describe('live transcription settings helpers', () => {
  it('recognizes providers with working live preview support', () => {
    expect(providerSupportsLivePreview('openai')).toBe(true)
    expect(providerSupportsLivePreview('deepgram')).toBe(true)
    expect(providerSupportsLivePreview('groq')).toBe(false)
  })

  it('maps supported providers to a simple enabled/off control', () => {
    expect(deriveLiveTranscriptionUiState({
      provider: 'openai',
      rawMode: 'auto',
    })).toMatchObject({
      supportsLivePreview: true,
      controlValue: 'enabled',
      capabilityLabel: 'Provider preview on',
      capabilityTone: 'good',
    })

    expect(deriveLiveTranscriptionUiState({
      provider: 'deepgram',
      rawMode: 'off',
    })).toMatchObject({
      supportsLivePreview: true,
      controlValue: 'off',
      capabilityLabel: 'Preview off',
      capabilityTone: 'neutral',
    })
  })

  it('marks unsupported providers as final-transcript only without inventing local preview support', () => {
    expect(deriveLiveTranscriptionUiState({
      provider: 'groq',
      rawMode: 'local_only',
    })).toMatchObject({
      supportsLivePreview: false,
      controlValue: 'enabled',
      capabilityLabel: 'Final transcript only',
      capabilityTone: 'warn',
    })

    expect(deriveLiveTranscriptionUiState({
      provider: 'mlx-whisper',
      rawMode: 'off',
    })).toMatchObject({
      supportsLivePreview: false,
      controlValue: 'off',
      capabilityLabel: 'Preview unavailable',
      capabilityTone: 'neutral',
    })
  })

  it('maps the visible control back to supported persisted values only when changed', () => {
    expect(mapLiveTranscriptionControlValue('enabled')).toBe('auto')
    expect(mapLiveTranscriptionControlValue('off')).toBe('off')
  })
})
