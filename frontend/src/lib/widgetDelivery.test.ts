import { beforeEach, describe, expect, it } from 'vitest'

import type { BackendStatus } from '../types'
import { resetPasteDeliveryRegistry } from './pasteDelivery'
import { getPendingNotificationKey, isPreparingPasteBusy } from './widgetDelivery'

function buildStatus(overrides: Partial<BackendStatus> = {}): BackendStatus {
  return {
    backend_ready: true,
    is_recording: false,
    is_processing: false,
    active_mode: null,
    active_skill: 'system_dictation',
    audio_amplitude: 0,
    last_error: null,
    pending_paste_text: null,
    pending_paste: null,
    pending_notification: null,
    missing_api_keys: false,
    recording_cues_enabled: false,
    restore_clipboard_after_paste: true,
    phase: 'ready',
    phase_label: 'Ready',
    captured_context: {
      app_name: 'Notes',
      bundle_id: null,
      window_title: null,
      page_title: null,
      url_host: null,
      url_path: null,
      focused_field_role: null,
      focused_field_subrole: null,
      focused_field_label: null,
      focused_field_placeholder: null,
    },
    captured_context_at: null,
    captured_context_quality: 'app_only',
    target_type: null,
    context_warning: null,
    last_smart_run: null,
    pipeline_timings: {
      record_start: null,
      stt_done: null,
      route_done: null,
      transform_done: null,
      paste_ack_done: null,
    },
    ...overrides,
  }
}

describe('widget delivery state', () => {
  beforeEach(() => {
    resetPasteDeliveryRegistry()
  })

  it('treats stale preparing-paste without pending delivery as idle', () => {
    const status = buildStatus({
      phase: 'preparing_paste',
      phase_label: 'Preparing paste',
    })

    expect(isPreparingPasteBusy(status, {
      successVisible: false,
      completedPasteId: null,
      handledNotificationKey: null,
    })).toBe(false)
  })

  it('stays busy for an active pending paste that has not completed locally', () => {
    const status = buildStatus({
      phase: 'preparing_paste',
      phase_label: 'Preparing paste',
      pending_paste: {
        id: 'paste-1',
        text: 'draft',
        restore_clipboard_after_paste: true,
      },
      pending_paste_text: 'draft',
    })

    expect(isPreparingPasteBusy(status, {
      successVisible: false,
      completedPasteId: null,
      handledNotificationKey: null,
    })).toBe(true)
  })

  it('returns to idle once the current paste has already completed locally', () => {
    const status = buildStatus({
      phase: 'preparing_paste',
      phase_label: 'Preparing paste',
      pending_paste: {
        id: 'paste-2',
        text: 'done',
        restore_clipboard_after_paste: true,
      },
      pending_paste_text: 'done',
    })

    expect(isPreparingPasteBusy(status, {
      successVisible: false,
      completedPasteId: 'paste-2',
      handledNotificationKey: null,
    })).toBe(false)
  })

  it('returns to idle once the pending notification was already handled locally', () => {
    const status = buildStatus({
      phase: 'preparing_paste',
      phase_label: 'Preparing paste',
      pending_notification: {
        title: 'Saved to Inbox',
        body: null,
      },
    })

    expect(isPreparingPasteBusy(status, {
      successVisible: false,
      completedPasteId: null,
      handledNotificationKey: getPendingNotificationKey(status.pending_notification),
    })).toBe(false)
  })

  it('shows success immediately even before backend acknowledgement clears', () => {
    const status = buildStatus({
      phase: 'preparing_paste',
      phase_label: 'Preparing paste',
      pending_paste: {
        id: 'paste-3',
        text: 'draft',
        restore_clipboard_after_paste: true,
      },
      pending_paste_text: 'draft',
    })

    expect(isPreparingPasteBusy(status, {
      successVisible: true,
      completedPasteId: null,
      handledNotificationKey: null,
    })).toBe(false)
  })
})
