import type { LibraryFilter, LibraryItem } from '../types'
import { formatProviderDisplayName } from './providerLabels'

export function formatLibraryTimestamp(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed)
}

export function formatLibraryItemLabel(item: LibraryItem) {
  if (item.source_type === 'note') {
    if (item.metadata.source_kind === 'selection_text') return `${item.label} • Selection note`
    if (item.metadata.source_kind === 'clipboard_text') return `${item.label} • Clipboard note`
    if (item.metadata.source_kind === 'transformed_output') return `${item.label} • Saved result`
    if (item.metadata.source_kind === 'task_result') return `${item.label} • Task result`
    return `${item.label} • Saved note`
  }
  return item.title
}

export function formatLibraryLaneLabel(lane: LibraryItem['lane']) {
  if (lane === 'note') return 'Note'
  if (lane === 'dictate') return 'Dictate'
  if (lane === 'smart') return 'Smart'
  if (lane === 'local_task') return 'Local Task'
  return 'Computer Use'
}

export function formatLibraryDetailTitle(item: LibraryItem) {
  return item.title
}

export function isLibraryCodeItem(item: LibraryItem) {
  return item.metadata.output_mode === 'code'
}

export function formatLibraryProviderSummary(item: LibraryItem) {
  const parts: string[] = []
  if (item.metadata.stt_provider || item.metadata.stt_model) {
    parts.push(`STT ${item.metadata.stt_provider ? formatProviderDisplayName(item.metadata.stt_provider) : 'Unknown'}${item.metadata.stt_model ? ` • ${item.metadata.stt_model}` : ''}`)
  }
  if (item.metadata.llm_provider || item.metadata.llm_model) {
    parts.push(`Smart ${item.metadata.llm_provider ? formatProviderDisplayName(item.metadata.llm_provider) : 'Unknown'}${item.metadata.llm_model ? ` • ${item.metadata.llm_model}` : ''}`)
  }
  if (!parts.length) {
    return item.metadata.local_only ? 'Local only' : 'No model metadata'
  }
  return parts.join(' | ')
}

export function formatLibraryRouteSummary(item: LibraryItem) {
  if (item.metadata.local_only) {
    return 'Local only'
  }
  if (item.metadata.model_backed) {
    return 'Model-backed'
  }
  return 'Local utility'
}

export function libraryFilterLabel(filter: LibraryFilter) {
  if (filter === 'notes') return 'Notes'
  if (filter === 'runs') return 'Runs'
  if (filter === 'smart') return 'Smart'
  if (filter === 'dictate') return 'Dictate'
  if (filter === 'local_task') return 'Local Task'
  if (filter === 'computer_use') return 'Computer Use'
  return 'All'
}
