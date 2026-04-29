type ActiveCaptureKind = 'recording' | 'mic_test' | null

type RecordingToggleSource = 'hotkey' | 'ui'

type RecordingToggleDecision =
  | { kind: 'ignore'; reason: 'toggle_in_progress' | 'hotkey_rearm' }
  | { kind: 'defer_stop' }
  | { kind: 'reset_stale_capture_state' }
  | { kind: 'start' }
  | { kind: 'stop' }

type ResolveRecordingToggleDecisionOptions = {
  source: RecordingToggleSource
  now: number
  hotkeyRearmUntil: number
  isToggleInProgress: boolean
  captureIsRecording: boolean
  activeCaptureKind: ActiveCaptureKind
}

export const HOTKEY_TOGGLE_REARM_MS = 320

export function resolveRecordingToggleDecision({
  source,
  now,
  hotkeyRearmUntil,
  isToggleInProgress,
  captureIsRecording,
  activeCaptureKind,
}: ResolveRecordingToggleDecisionOptions): RecordingToggleDecision {
  if (captureIsRecording && activeCaptureKind !== 'recording') {
    return {
      kind: 'reset_stale_capture_state',
    }
  }

  if (isToggleInProgress) {
    if (source === 'hotkey' && activeCaptureKind === 'recording' && !captureIsRecording) {
      return {
        kind: 'defer_stop',
      }
    }

    return {
      kind: 'ignore',
      reason: 'toggle_in_progress',
    }
  }

  if (activeCaptureKind === 'recording') {
    return {
      kind: 'stop',
    }
  }

  if (source === 'hotkey' && now < hotkeyRearmUntil) {
    return {
      kind: 'ignore',
      reason: 'hotkey_rearm',
    }
  }

  return {
    kind: 'start',
  }
}

export type {
  ActiveCaptureKind,
  RecordingToggleDecision,
  RecordingToggleSource,
  ResolveRecordingToggleDecisionOptions,
}
