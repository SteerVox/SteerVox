import { describe, expect, it } from 'vitest'

import type { HistoryItem, InboxNote } from '../types'
import {
  buildLibraryPreview,
  createLibraryItems,
  formatLibraryDetailTitle,
  formatLibraryItemLabel,
  isLibraryCodeItem,
  matchesLibraryItem,
  tokenizeLibrarySearch,
} from './library'

function buildHistoryItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: 1,
    mode: 'smart_transform',
    transcript: 'make this concise',
    final_output: 'A concise version of the update.',
    created_at: '2026-03-27T12:00:00.000Z',
    telemetry: {
      output_mode: 'plain_text',
    },
    context: {
      app_name: 'Slack',
      window_title: 'eng-updates',
    },
    stt_provider: 'mlx-whisper',
    stt_model: 'mlx-community/whisper-base-mlx',
    llm_provider: 'lmstudio',
    llm_model: 'qwen2.5-0.5b-instruct-mlx',
    ...overrides,
  }
}

function buildNote(overrides: Partial<InboxNote> = {}): InboxNote {
  return {
    id: 'note-1',
    text: 'Remember to update the shipping tracker before 5 PM.',
    created_at: '2026-03-27T13:00:00.000Z',
    app_name: 'Notes',
    bundle_id: null,
    window_title: 'Daily handoff',
    source_mode: 'smart_transform',
    source_kind: 'selection_text',
    output_mode: 'plain_text',
    ...overrides,
  }
}

describe('library helpers', () => {
  it('builds previews with normalized whitespace and truncation', () => {
    expect(buildLibraryPreview('  update   docs   today  ')).toBe('update docs today')

    const longText = 'alpha '.repeat(40)
    expect(buildLibraryPreview(longText)).toMatch(/…$/)
  })

  it('merges notes and runs into a descending library timeline', () => {
    const note = buildNote()
    const history = buildHistoryItem({
      created_at: '2026-03-27T11:00:00.000Z',
      context: {
        app_name: 'Unknown',
        window_title: '',
      },
    })

    const items = createLibraryItems([note], [history])

    expect(items.map((item) => item.kind)).toEqual(['note', 'history'])
    expect(items[0].app_name).toBe('Notes')
    expect(items[1].app_name).toBe('Unknown app')
    expect(items[1].window_title).toBeNull()
  })

  it('formats labels and detail titles using Smart naming', () => {
    const noteItem = createLibraryItems(
      [buildNote({ source_kind: 'selection_text' })],
      [],
    )[0]
    const historyItem = createLibraryItems(
      [],
      [buildHistoryItem({ telemetry: { output_mode: 'code' } })],
    )[0]

    expect(formatLibraryItemLabel(noteItem)).toBe('Smart • Selection note')
    expect(formatLibraryItemLabel(historyItem)).toBe('Smart run')
    expect(formatLibraryDetailTitle(noteItem)).toBe('Saved note')
    expect(formatLibraryDetailTitle(historyItem)).toBe('Smart run')
    expect(isLibraryCodeItem(historyItem)).toBe(true)
  })

  it('filters by tokens and section type', () => {
    const noteItem = createLibraryItems(
      [buildNote({ text: 'Call carrier about Bangalore delay.' })],
      [],
    )[0]
    const historyItem = createLibraryItems(
      [],
      [buildHistoryItem({ transcript: 'draft customer update', final_output: 'Customer update ready.' })],
    )[0]

    const noteTokens = tokenizeLibrarySearch('bangalore delay')
    const historyTokens = tokenizeLibrarySearch('customer update')

    expect(matchesLibraryItem(noteItem, noteTokens, 'all')).toBe(true)
    expect(matchesLibraryItem(noteItem, historyTokens, 'all')).toBe(false)
    expect(matchesLibraryItem(noteItem, noteTokens, 'notes')).toBe(true)
    expect(matchesLibraryItem(noteItem, noteTokens, 'recent_runs')).toBe(false)
    expect(matchesLibraryItem(historyItem, historyTokens, 'recent_runs')).toBe(true)
  })
})
