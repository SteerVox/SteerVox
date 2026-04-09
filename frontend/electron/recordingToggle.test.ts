import { describe, expect, it } from 'vitest'

import { HOTKEY_TOGGLE_REARM_MS, resolveRecordingToggleDecision } from './recordingToggle'

describe('resolveRecordingToggleDecision', () => {
  it('blocks hotkey repeats during the short rearm window', () => {
    expect(resolveRecordingToggleDecision({
      source: 'hotkey',
      now: 1_000,
      hotkeyRearmUntil: 1_000 + HOTKEY_TOGGLE_REARM_MS,
      isToggleInProgress: false,
      captureIsRecording: false,
      activeCaptureKind: null,
    })).toEqual({
      kind: 'ignore',
      reason: 'hotkey_rearm',
    })
  })

  it('does not apply the hotkey rearm window to widget clicks', () => {
    expect(resolveRecordingToggleDecision({
      source: 'ui',
      now: 1_000,
      hotkeyRearmUntil: 1_000 + HOTKEY_TOGGLE_REARM_MS,
      isToggleInProgress: false,
      captureIsRecording: false,
      activeCaptureKind: null,
    })).toEqual({
      kind: 'start',
    })
  })

  it('resets stale capture state instead of starting a new recording', () => {
    expect(resolveRecordingToggleDecision({
      source: 'hotkey',
      now: 1_000,
      hotkeyRearmUntil: 0,
      isToggleInProgress: false,
      captureIsRecording: true,
      activeCaptureKind: null,
    })).toEqual({
      kind: 'reset_stale_capture_state',
    })
  })

  it('stops a live recording session', () => {
    expect(resolveRecordingToggleDecision({
      source: 'hotkey',
      now: 1_000,
      hotkeyRearmUntil: 0,
      isToggleInProgress: false,
      captureIsRecording: true,
      activeCaptureKind: 'recording',
    })).toEqual({
      kind: 'stop',
    })
  })

  it('ignores duplicate toggles while a transition is already running', () => {
    expect(resolveRecordingToggleDecision({
      source: 'hotkey',
      now: 1_000,
      hotkeyRearmUntil: 0,
      isToggleInProgress: true,
      captureIsRecording: true,
      activeCaptureKind: 'recording',
    })).toEqual({
      kind: 'ignore',
      reason: 'toggle_in_progress',
    })
  })
})
