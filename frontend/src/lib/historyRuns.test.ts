import { describe, expect, it } from 'vitest'

import type { HistoryItem } from '../types'
import { getHistoryItemRerunNotice, isHistoryItemRerunnable } from './historyRuns'

function buildHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: 1,
    mode: 'smart_transform',
    transcript: 'open Slack',
    final_output: 'Opened Slack.',
    created_at: '2026-04-04T10:00:00.000Z',
    telemetry: {
      output_mode: 'plain_text',
    },
    context: {
      app_name: 'Slack',
      window_title: 'General',
    },
    stt_provider: 'groq',
    stt_model: 'whisper-large-v3-turbo',
    llm_provider: 'openai',
    llm_model: 'gpt-4.1',
    ...overrides,
  }
}

describe('history rerun gating', () => {
  it('keeps older or normal history items rerunnable', () => {
    expect(isHistoryItemRerunnable(buildHistoryItem())).toBe(true)
    expect(getHistoryItemRerunNotice(buildHistoryItem())).toBeNull()
  })

  it('blocks reviewed action runs when telemetry marks them explicitly', () => {
    const item = buildHistoryItem({
      telemetry: {
        output_mode: 'plain_text',
        action_execution_mode: 'reviewed',
      },
    })

    expect(isHistoryItemRerunnable(item)).toBe(false)
    expect(getHistoryItemRerunNotice(item)).toContain('Reviewed desktop actions')
  })

  it('blocks auto action runs when telemetry marks them explicitly', () => {
    const item = buildHistoryItem({
      telemetry: {
        output_mode: 'plain_text',
        action_execution_mode: 'auto',
      },
    })

    expect(isHistoryItemRerunnable(item)).toBe(false)
    expect(getHistoryItemRerunNotice(item)).toContain('Executed desktop actions')
  })

  it('treats legacy action-review telemetry as non-rerunnable', () => {
    const item = buildHistoryItem({
      telemetry: {
        output_mode: 'plain_text',
        action_review_required: true,
      },
    })

    expect(isHistoryItemRerunnable(item)).toBe(false)
    expect(getHistoryItemRerunNotice(item)).toContain('Reviewed desktop actions')
  })
})
