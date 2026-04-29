import { describe, expect, it } from 'vitest'

import { resolveDeferredHotkeyStopExecution, resolveDeferredHotkeyStopRequest } from './recordingHotkeyFlow'

describe('recording hotkey flow', () => {
  it('queues one deferred stop for the same mode while start is in progress', () => {
    expect(resolveDeferredHotkeyStopRequest({
      requestedMode: 'dictation',
      activeRecordingMode: 'dictation',
      pendingStopQueued: false,
    })).toEqual({
      kind: 'queue_stop',
      mode: 'dictation',
    })
  })

  it('ignores duplicate deferred-stop requests once one is already queued', () => {
    expect(resolveDeferredHotkeyStopRequest({
      requestedMode: 'dictation',
      activeRecordingMode: 'dictation',
      pendingStopQueued: true,
    })).toEqual({
      kind: 'ignore',
      reason: 'already_queued',
    })
  })

  it('does not queue a mode switch while another mode is still starting', () => {
    expect(resolveDeferredHotkeyStopRequest({
      requestedMode: 'smart_transform',
      activeRecordingMode: 'dictation',
      pendingStopQueued: false,
    })).toEqual({
      kind: 'ignore',
      reason: 'mode_switch_in_progress',
    })
  })

  it('executes the deferred stop once recording becomes active', () => {
    expect(resolveDeferredHotkeyStopExecution({
      pendingStopQueued: true,
      activeCaptureKind: 'recording',
      captureIsRecording: true,
    })).toEqual({
      kind: 'execute_stop',
    })
  })

  it('clears the deferred stop if start never becomes an active recording', () => {
    expect(resolveDeferredHotkeyStopExecution({
      pendingStopQueued: true,
      activeCaptureKind: null,
      captureIsRecording: false,
    })).toEqual({
      kind: 'clear',
      reason: 'recording_never_became_active',
    })
  })
})
