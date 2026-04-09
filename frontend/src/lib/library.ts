import type { HistoryItem, InboxNote, LibraryFilter, LibraryItem } from '../types'

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

export function buildLibraryPreview(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 136) return normalized
  return `${normalized.slice(0, 136).trimEnd()}…`
}

function normalizeHistoryAppName(item: HistoryItem) {
  const appName = item.context.app_name?.trim()
  return appName && appName !== 'Unknown' ? appName : 'Unknown app'
}

function normalizeHistoryWindowTitle(item: HistoryItem) {
  return item.context.window_title?.trim() || null
}

function normalizeHistoryOutputMode(item: HistoryItem) {
  return item.telemetry.output_mode || null
}

export function createLibraryItems(notes: InboxNote[], historyItems: HistoryItem[]): LibraryItem[] {
  const noteItems: LibraryItem[] = notes.map((note) => ({
    kind: 'note',
    id: note.id,
    created_at: note.created_at,
    app_name: note.app_name || 'Unknown app',
    window_title: note.window_title,
    output_mode: note.output_mode,
    source_mode: note.source_mode,
    source_kind: note.source_kind,
    preview: buildLibraryPreview(note.text),
    search_text: [
      note.text,
      note.app_name,
      note.window_title,
      note.source_mode,
      note.source_kind,
      note.output_mode,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
    note,
  }))

  const historyLibraryItems: LibraryItem[] = historyItems.map((item) => ({
    kind: 'history',
    id: String(item.id),
    created_at: item.created_at,
    app_name: normalizeHistoryAppName(item),
    window_title: normalizeHistoryWindowTitle(item),
    output_mode: normalizeHistoryOutputMode(item),
    source_mode: item.mode,
    preview: buildLibraryPreview(item.final_output || item.transcript),
    search_text: [
      item.transcript,
      item.final_output,
      item.context.app_name,
      item.context.window_title,
      item.mode,
      item.telemetry.output_mode,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
    history: item,
  }))

  return [...noteItems, ...historyLibraryItems].sort((left, right) => (
    new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  ))
}

export function tokenizeLibrarySearch(value: string) {
  return value
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

export function matchesLibraryItem(item: LibraryItem, tokens: string[], filter: LibraryFilter) {
  if (filter === 'notes' && item.kind !== 'note') return false
  if (filter === 'recent_runs' && item.kind !== 'history') return false
  if (!tokens.length) return true
  return tokens.every((token) => item.search_text.includes(token))
}

export function formatLibraryItemLabel(item: LibraryItem) {
  const modeLabel = item.source_mode === 'smart_transform' ? 'Smart' : 'Dictate'

  if (item.kind === 'note') {
    if (item.source_kind === 'selection_text') return `${modeLabel} • Selection note`
    if (item.source_kind === 'clipboard_text') return `${modeLabel} • Clipboard note`
    if (item.source_kind === 'transformed_output') return `${modeLabel} • Saved result`
    return `${modeLabel} • Spoken note`
  }

  return `${modeLabel} run`
}

export function formatLibraryDetailTitle(item: LibraryItem) {
  if (item.kind === 'note') return 'Saved note'
  return item.source_mode === 'smart_transform' ? 'Smart run' : 'Dictation run'
}

export function isLibraryCodeItem(item: LibraryItem) {
  return item.output_mode === 'code'
}
