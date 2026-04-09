import { describe, expect, it } from 'vitest'

import {
  applyStablePreviewText,
  formatStablePreviewText,
  resolveLiveTranscriptionStrategy,
} from './liveTranscriptionRouting'

describe('resolveLiveTranscriptionStrategy', () => {
  it('keeps mlx-whisper on the stable final-transcript path by default', () => {
    expect(resolveLiveTranscriptionStrategy({
      provider: 'mlx-whisper',
      liveTranscriptionMode: 'auto',
    })).toBe('disabled')
  })

  it('routes supported provider streaming models to the backend live path', () => {
    expect(resolveLiveTranscriptionStrategy({
      provider: 'openai',
      liveTranscriptionMode: 'auto',
    })).toBe('backend_provider')
  })

  it('keeps local_only disabled until a real local preview path exists', () => {
    expect(resolveLiveTranscriptionStrategy({
      provider: 'openai',
      liveTranscriptionMode: 'local_only',
    })).toBe('disabled')
  })

  it('disables live transcription when the chosen mode and provider do not match', () => {
    expect(resolveLiveTranscriptionStrategy({
      provider: 'mlx-whisper',
      liveTranscriptionMode: 'provider_only',
    })).toBe('disabled')
  })
})

describe('applyStablePreviewText', () => {
  it('commits stable prefixes instead of rewriting older text away', () => {
    let state = { committedText: '', provisionalText: '' }

    state = applyStablePreviewText(state, 'ship the update')
    expect(formatStablePreviewText(state)).toBe('ship the update')

    state = applyStablePreviewText(state, 'ship the update tomorrow')
    expect(state.committedText).toBe('ship the update')
    expect(state.provisionalText).toBe('tomorrow')
    expect(formatStablePreviewText(state)).toBe('ship the update tomorrow')
  })

  it('preserves already committed words when later partials revise the tail', () => {
    let state = { committedText: '', provisionalText: '' }

    state = applyStablePreviewText(state, 'open the release notes')
    state = applyStablePreviewText(state, 'open the release notes in safari')
    state = applyStablePreviewText(state, 'open the release notes in chrome')

    expect(state.committedText).toBe('open the release notes in')
    expect(state.provisionalText).toBe('chrome')
    expect(formatStablePreviewText(state)).toBe('open the release notes in chrome')
  })
})
