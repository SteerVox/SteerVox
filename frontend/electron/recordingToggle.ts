type ActiveCaptureKind = 'recording' | 'mic_test' | null

type RecordingToggleSource = 'hotkey' | 'ui'

type RecordingToggleDecision =
  | { kind: 'ignore'; reason: 'toggle_in_progress' | 'hotkey_rearm' }
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
  if (isToggleInProgress) {
    return {
      kind: 'ignore',
      reason: 'toggle_in_progress',
    }
  }

  if (source === 'hotkey' && now < hotkeyRearmUntil) {
    return {
      kind: 'ignore',
      reason: 'hotkey_rearm',
    }
  }

  if (captureIsRecording && activeCaptureKind !== 'recording') {
    return {
      kind: 'reset_stale_capture_state',
    }
  }

  if (activeCaptureKind === 'recording') {
    return {
      kind: 'stop',
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
