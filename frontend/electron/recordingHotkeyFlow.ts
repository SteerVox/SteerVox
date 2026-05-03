type RecordingMode = 'dictation' | 'smart_transform'
type ActiveCaptureKind = 'recording' | 'mic_test' | null

type DeferredHotkeyStopRequest =
  | { kind: 'queue_stop'; mode: RecordingMode }
  | { kind: 'ignore'; reason: 'already_queued' | 'mode_switch_in_progress' }

type DeferredHotkeyStopExecution =
  | { kind: 'noop' }
  | { kind: 'execute_stop' }
  | { kind: 'clear'; reason: 'recording_never_became_active' }

export function resolveDeferredHotkeyStopRequest({
  requestedMode,
  activeRecordingMode,
  pendingStopQueued,
}: {
  requestedMode: RecordingMode
  activeRecordingMode: RecordingMode | null
  pendingStopQueued: boolean
}): DeferredHotkeyStopRequest {
  if (pendingStopQueued) {
    return {
      kind: 'ignore',
      reason: 'already_queued',
    }
  }

  if (activeRecordingMode && activeRecordingMode !== requestedMode) {
    return {
      kind: 'ignore',
      reason: 'mode_switch_in_progress',
    }
  }

  return {
    kind: 'queue_stop',
    mode: activeRecordingMode || requestedMode,
  }
}

export function resolveDeferredHotkeyStopExecution({
  pendingStopQueued,
  activeCaptureKind,
  captureIsRecording,
}: {
  pendingStopQueued: boolean
  activeCaptureKind: ActiveCaptureKind
  captureIsRecording: boolean
}): DeferredHotkeyStopExecution {
  if (!pendingStopQueued) {
    return { kind: 'noop' }
  }

  if (activeCaptureKind === 'recording' && captureIsRecording) {
    return { kind: 'execute_stop' }
  }

  return {
    kind: 'clear',
    reason: 'recording_never_became_active',
  }
}

export type {
  ActiveCaptureKind,
  DeferredHotkeyStopExecution,
  DeferredHotkeyStopRequest,
  RecordingMode,
}
