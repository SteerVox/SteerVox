import { describe, expect, it } from 'vitest'

import type { LibraryItem } from '../types'
import {
  formatLibraryDetailTitle,
  formatLibraryItemLabel,
  formatLibraryProviderSummary,
  isLibraryCodeItem,
  libraryFilterLabel,
} from './library'

function buildLibraryItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'history:1',
    source_type: 'history',
    source_id: '1',
    lane: 'smart',
    title: 'Smart run',
    label: 'Smart',
    preview: 'A concise version of the update.',
    created_at: '2026-03-27T12:00:00.000Z',
    primary_text: 'A concise version of the update.',
    secondary_text: 'make this concise',
    metadata: {
      source_mode: 'smart_transform',
      source_kind: 'run',
      output_mode: 'plain_text',
      app_name: 'Slack',
      bundle_id: null,
      window_title: 'eng-updates',
      page_title: null,
      url_host: null,
      url_path: null,
      surface_kind: 'chat_input',
      stt_provider: 'mlx-whisper',
      stt_model: 'mlx-community/whisper-base-mlx',
      llm_provider: 'lmstudio',
      llm_model: 'qwen2.5-0.5b-instruct-mlx',
      skill_id: 'system_dictation',
      skill_label: 'Dictation',
      domain_id: null,
      intent: null,
      local_only: false,
      model_backed: true,
      transcript_chars: 18,
      output_chars: 32,
      duration_ms: null,
      step_count: null,
      completed_steps: null,
      failed_step_id: null,
      failed_step_title: null,
      memory_eligible: true,
      memory_state: 'eligible',
    },
    ...overrides,
  }
}

describe('library helpers', () => {
  it('formats note labels with source-kind detail', () => {
    const note = buildLibraryItem({
      id: 'note:1',
      source_type: 'note',
      source_id: '1',
      lane: 'smart',
      title: 'Saved Smart note',
      label: 'Smart',
      metadata: {
        ...buildLibraryItem().metadata,
        source_kind: 'selection_text',
      },
    })

    expect(formatLibraryItemLabel(note)).toBe('Smart • Selection note')
    expect(formatLibraryDetailTitle(note)).toBe('Saved Smart note')
  })

  it('formats history items and provider summaries', () => {
    const item = buildLibraryItem()
    expect(formatLibraryItemLabel(item)).toBe('Smart run')
    expect(formatLibraryDetailTitle(item)).toBe('Smart run')
    expect(formatLibraryProviderSummary(item)).toContain('STT MLX Whisper')
    expect(formatLibraryProviderSummary(item)).toContain('Smart LM Studio')
  })

  it('detects code output mode and human filter labels', () => {
    const codeItem = buildLibraryItem({
      metadata: {
        ...buildLibraryItem().metadata,
        output_mode: 'code',
      },
    })

    expect(isLibraryCodeItem(codeItem)).toBe(true)
    expect(libraryFilterLabel('computer_use')).toBe('Computer Use')
    expect(libraryFilterLabel('runs')).toBe('Runs')
  })
})
