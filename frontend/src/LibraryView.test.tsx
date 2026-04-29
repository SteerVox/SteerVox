import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LibraryView } from './LibraryView'
import type { HistoryItem, LibraryItem, Skill } from './types'

const {
  apiDeleteMock,
  apiGetMock,
  apiPostMock,
} = vi.hoisted(() => ({
  apiDeleteMock: vi.fn(),
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}))

let runtimeState: {
  invalidationTokens: Record<string, number>
}

vi.mock('./lib/api', () => ({
  apiDelete: apiDeleteMock,
  apiGet: apiGetMock,
  apiPost: apiPostMock,
}))

vi.mock('./lib/runtimeStore', () => ({
  useRuntimeStore: (selector: (state: unknown) => unknown) => selector(runtimeState),
}))

const libraryItems: LibraryItem[] = [
  {
    id: 'note-1',
    source_type: 'note',
    source_id: 'note-1',
    lane: 'note',
    title: 'Saved note',
    label: 'Saved note',
    preview: 'First saved note preview',
    created_at: '2026-04-18T10:00:00.000Z',
    primary_text: 'First note body',
    secondary_text: 'First note supporting text',
    metadata: {
      source_mode: 'smart_transform',
      source_kind: 'transformed_output',
      output_mode: 'plain_text',
      app_name: 'Notes',
      bundle_id: 'com.apple.Notes',
      window_title: 'Daily Notes',
      page_title: null,
      url_host: null,
      url_path: null,
      surface_kind: 'native_app',
      stt_provider: 'mlx-whisper',
      stt_model: 'base',
      llm_provider: 'lmstudio',
      llm_model: 'google/gemma-4-e4b',
      skill_id: 'system_rewrite',
      skill_label: 'Smart Rewrite',
      domain_id: null,
      intent: 'summarize',
      local_only: false,
      model_backed: true,
      transcript_chars: 42,
      output_chars: 15,
      duration_ms: 1900,
      step_count: null,
      completed_steps: null,
      failed_step_id: null,
      failed_step_title: null,
      memory_eligible: true,
      memory_state: 'eligible',
    },
  },
  {
    id: 'history-7',
    source_type: 'history',
    source_id: '7',
    lane: 'computer_use',
    title: 'Computer Use run',
    label: 'Computer Use',
    preview: 'Second run preview',
    created_at: '2026-04-18T11:00:00.000Z',
    primary_text: 'Second run output',
    secondary_text: null,
    metadata: {
      source_mode: 'smart_transform',
      source_kind: 'task_result',
      output_mode: 'plain_text',
      app_name: 'Google Chrome',
      bundle_id: 'com.google.Chrome',
      window_title: 'YouTube',
      page_title: 'Indie songs',
      url_host: 'youtube.com',
      url_path: '/results',
      surface_kind: 'browser',
      stt_provider: 'mlx-whisper',
      stt_model: 'base',
      llm_provider: 'lmstudio',
      llm_model: 'google/gemma-4-e4b',
      skill_id: 'system_computer_use',
      skill_label: 'Computer Use',
      domain_id: null,
      intent: 'open_and_play',
      local_only: true,
      model_backed: false,
      transcript_chars: 68,
      output_chars: 17,
      duration_ms: 3200,
      step_count: 2,
      completed_steps: 2,
      failed_step_id: null,
      failed_step_title: null,
      memory_eligible: false,
      memory_state: 'ignored',
    },
  },
]

const historyItems: HistoryItem[] = [
  {
    id: 7,
    mode: 'smart_transform',
    transcript: 'open Chrome and play indie songs on YouTube',
    final_output: 'Second run output',
    created_at: '2026-04-18T11:00:00.000Z',
    telemetry: {
      action_execution_mode: 'none',
      skill_used: {
        id: 'system_computer_use',
        name: 'Computer Use',
      },
    },
    context: {
      app_name: 'Google Chrome',
    },
    stt_provider: 'mlx-whisper',
    stt_model: 'base',
    llm_provider: 'lmstudio',
    llm_model: 'google/gemma-4-e4b',
  },
]

const skills: Skill[] = [
  {
    id: 'system_computer_use',
    name: 'Computer Use',
    prompt: '',
    description: 'Perform a local action.',
    max_chars: null,
    target_types: [],
    triggers: [],
    style: null,
    fallback_behavior: 'paste_original',
    output_mode: 'plain_text',
  },
]

function renderLibraryView() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <LibraryView />
    </MemoryRouter>,
  )
}

describe('LibraryView', () => {
  beforeEach(() => {
    runtimeState = {
      invalidationTokens: {
        config: 0,
        providers: 0,
        history: 0,
        inbox: 0,
        skills: 0,
        domains: 0,
        writing_tools: 0,
        usage: 0,
      },
    }

    apiDeleteMock.mockReset()
    apiGetMock.mockReset()
    apiPostMock.mockReset()

    const fallbackLibraryItems = libraryItems.map((item) => (
      item.id === 'history-7'
        ? { ...item, secondary_text: 'Fallback transcript from Library item' }
        : item
    ))

    apiGetMock.mockImplementation((url: string) => {
      if (url.startsWith('/library')) {
        return Promise.resolve({ data: { items: fallbackLibraryItems } })
      }
      if (url === '/history') {
        return Promise.resolve({ data: { items: historyItems } })
      }
      if (url === '/skills') {
        return Promise.resolve({ data: { skills } })
      }
      throw new Error(`Unexpected apiGet call: ${url}`)
    })

    apiDeleteMock.mockResolvedValue({ data: { ok: true } })
    apiPostMock.mockResolvedValue({ data: { ok: true } })

    window.windowControls = {
      writeClipboardText: vi.fn(() => Promise.resolve()),
    } as unknown as typeof window.windowControls
  })

  it('keeps note actions visible in the main detail view', async () => {
    renderLibraryView()

    expect(await screen.findByText('First note body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy & Archive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.getByText('Notes and recent runs.')).toBeInTheDocument()
    expect(screen.getByText('Saved content')).toBeInTheDocument()
  })

  it('keeps run actions and rerun controls visible after selecting a run', async () => {
    renderLibraryView()

    expect(await screen.findByText('First note body')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Second run preview/i }))

    expect((await screen.findAllByText('Second run output')).length).toBeGreaterThan(0)
    expect(screen.getByText('open Chrome and play indie songs on YouTube')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy transcript' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run with template' })).toBeInTheDocument()
    expect(screen.getByText('Run with a different template')).toBeInTheDocument()
    expect(screen.getByText('Transcript')).toBeInTheDocument()
    expect(screen.getByText('Smart output')).toBeInTheDocument()
  })

  it('keeps run actions visible from normalized Library data when history details are not hydrated', async () => {
    const fallbackLibraryItems = libraryItems.map((item) => (
      item.id === 'history-7'
        ? { ...item, secondary_text: 'Fallback transcript from Library item' }
        : item
    ))

    apiGetMock.mockImplementation((url: string) => {
      if (url.startsWith('/library')) {
        return Promise.resolve({ data: { items: fallbackLibraryItems } })
      }
      if (url === '/history') {
        return Promise.resolve({ data: { items: [] } })
      }
      if (url === '/skills') {
        return Promise.resolve({ data: { skills } })
      }
      throw new Error(`Unexpected apiGet call: ${url}`)
    })

    renderLibraryView()

    expect(await screen.findByText('First note body')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Second run preview/i }))

    expect((await screen.findAllByText('Second run output')).length).toBeGreaterThan(0)
    expect(screen.getByText('Fallback transcript from Library item')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy transcript' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })
})
