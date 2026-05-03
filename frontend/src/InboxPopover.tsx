import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ErrorIcon, InboxIcon } from './components/BrandIcons'
import { apiDelete, apiGet } from './lib/api'
import type { InboxNote } from './types'

type InboxResponse = {
  notes: InboxNote[]
}

function formatTimestamp(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed)
}

function tokenizeSearch(value: string) {
  return value
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function matchesTokens(note: InboxNote, tokens: string[]) {
  if (tokens.length === 0) return true

  const haystack = [
    note.text,
    note.app_name,
    note.window_title,
    note.source_mode,
    note.source_kind,
    note.output_mode,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return tokens.every((token) => haystack.includes(token))
}

function buildPreview(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 120) return normalized
  return `${normalized.slice(0, 120).trimEnd()}…`
}

function isCodeNote(note: InboxNote) {
  return note.output_mode === 'code'
}

function formatSourceLabel(note: InboxNote) {
  const modeLabel = note.source_mode === 'smart_transform'
    ? 'Smart'
    : note.source_mode === 'local_task'
      ? 'Local task'
      : 'Dictation'
  if (note.source_kind === 'selection_text') return `${modeLabel} • Selection`
  if (note.source_kind === 'clipboard_text') return `${modeLabel} • Clipboard`
  if (note.source_kind === 'transformed_output') return `${modeLabel} • Transformed`
  return `${modeLabel} • Spoken`
}

export default function InboxPopover() {
  const [notes, setNotes] = useState<InboxNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedAppFilter, setSelectedAppFilter] = useState('all')
  const [platform, setPlatform] = useState('darwin')
  const lastLoadAtRef = useRef(0)

  const loadNotes = useCallback(async (force = false) => {
    const now = Date.now()
    if (!force && now - lastLoadAtRef.current < 300) {
      return
    }
    lastLoadAtRef.current = now
    setLoading(true)
    try {
      const response = await apiGet<InboxResponse>('/inbox')
      setNotes(response.data.notes || [])
      setError(null)
    } catch {
      setError('Unable to load inbox notes from the local backend.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.surface = 'inbox'
    document.body.dataset.surface = 'inbox'
    void loadNotes(true)
    window.windowControls?.getPlatform?.().then((nextPlatform) => {
      if (nextPlatform) {
        setPlatform(nextPlatform)
      }
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        window.windowControls?.closeInboxWindow?.()
      }
    }

    const onFocus = () => {
      void loadNotes()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('focus', onFocus)
    const disposeInboxChanged = window.windowControls?.onInboxChanged?.(() => {
      void loadNotes(true)
    })
    return () => {
      delete document.documentElement.dataset.surface
      delete document.body.dataset.surface
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('focus', onFocus)
      disposeInboxChanged?.()
    }
  }, [loadNotes])

  const isMac = platform === 'darwin'
  const headerInsetClass = isMac ? 'pl-[84px] pr-5 py-3.5' : 'px-5 py-3.5'
  const searchTokens = useMemo(() => tokenizeSearch(searchQuery), [searchQuery])
  const appOptions = useMemo(
    () => Array.from(new Set(notes.map((note) => note.app_name || 'Unknown app'))).sort((left, right) => left.localeCompare(right)),
    [notes],
  )
  const filteredNotes = useMemo(
    () => notes.filter((note) => {
      const appMatches = selectedAppFilter === 'all' || (note.app_name || 'Unknown app') === selectedAppFilter
      return appMatches && matchesTokens(note, searchTokens)
    }),
    [notes, searchTokens, selectedAppFilter],
  )
  const selectedNote = useMemo(
    () => filteredNotes.find((note) => note.id === selectedNoteId) ?? null,
    [filteredNotes, selectedNoteId],
  )

  useEffect(() => {
    if (selectedAppFilter !== 'all' && !appOptions.includes(selectedAppFilter)) {
      setSelectedAppFilter('all')
    }
  }, [appOptions, selectedAppFilter])

  useEffect(() => {
    if (!filteredNotes.length) {
      setSelectedNoteId(null)
      return
    }

    if (!selectedNoteId || !filteredNotes.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId(filteredNotes[0].id)
    }
  }, [filteredNotes, selectedNoteId])

  const copyNote = async (text: string) => {
    await window.windowControls?.writeClipboardText?.(text)
  }

  const deleteNote = async (noteId: string) => {
    try {
      await apiDelete(`/inbox/${noteId}`)
      await loadNotes()
      setError(null)
      return true
    } catch {
      setError('Unable to delete that inbox note.')
      return false
    }
  }

  const copyAndArchiveNote = async (note: InboxNote) => {
    try {
      await copyNote(note.text)
      const deleted = await deleteNote(note.id)
      if (!deleted) {
        setError('Copied the note, but could not archive it.')
      }
    } catch {
      setError('Unable to copy and archive that note.')
    }
  }

  const isFilteredView = searchTokens.length > 0 || selectedAppFilter !== 'all'
  const resultLabel = isFilteredView
    ? `${filteredNotes.length} match${filteredNotes.length === 1 ? '' : 'es'}`
    : `${notes.length} note${notes.length === 1 ? '' : 's'}`

  return (
    <div className="workspace-shell relative flex h-full w-full min-h-0 flex-col overflow-hidden rounded-[24px] border border-white/8 text-text-primary shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
      <div className={`workspace-titlebar soft-divider shrink-0 border-b ${headerInsetClass}`}>
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Notes</div>
          <div className="mt-1 text-[13px] font-semibold tracking-[-0.02em] text-text-primary">
            {resultLabel}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <div className="flex h-full min-h-0">
          <aside className="settings-sidebar soft-divider flex w-[282px] min-h-0 shrink-0 flex-col border-r">
            <div className="shrink-0 px-4 py-3.5">
              <div className="mb-3 flex items-center gap-3">
                <div className="widget-control flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-text-primary">
                  <InboxIcon size={15} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary">Notes</div>
                  <div className="mt-1 text-xs leading-5 text-text-secondary">
                    Search by text, app, or window.
                  </div>
                </div>
              </div>

              <div className="section-intro-panel rounded-2xl border border-white/6 p-3.5">
                <label className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.24em] text-text-muted">
                  Search
                </label>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Filter notes"
                  className="w-full rounded-2xl border border-white/8 bg-black/24 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-white/16 focus:ring-2 focus:ring-white/12"
                />

                <label className="mb-2 mt-3 block text-[10px] font-semibold uppercase tracking-[0.24em] text-text-muted">
                  App
                </label>
                <select
                  value={selectedAppFilter}
                  onChange={(event) => setSelectedAppFilter(event.target.value)}
                  className="w-full rounded-2xl border border-white/8 bg-black/24 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-white/16 focus:ring-2 focus:ring-white/12"
                >
                  <option value="all">All apps</option>
                  {appOptions.map((appName) => (
                    <option key={appName} value={appName}>{appName}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {loading ? (
                <div className="section-intro-panel rounded-2xl border border-white/8 px-4 py-4 text-sm text-text-secondary">
                  Loading inbox notes…
                </div>
              ) : error ? (
                <div className="rounded-2xl border border-semantic-error/20 bg-[rgba(74,28,31,0.76)] px-4 py-4 text-sm text-text-secondary">
                  <div className="flex items-start gap-3">
                    <ErrorIcon size={16} className="mt-0.5 text-semantic-error" />
                    <div>{error}</div>
                  </div>
                </div>
              ) : filteredNotes.length === 0 ? (
                <div className="section-intro-panel rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm leading-6 text-text-secondary">
                  {searchTokens.length
                    ? 'No notes match the current search. Try fewer or broader words.'
                    : 'Use Smart with a phrase like “take a note of this” to save notes here.'}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {filteredNotes.map((note) => {
                    const active = note.id === selectedNoteId
                    return (
                      <button
                        key={note.id}
                        type="button"
                        onClick={() => setSelectedNoteId(note.id)}
                        className={`settings-sidebar-item rounded-[20px] border px-3 py-2.5 text-left transition-colors ${
                          active
                            ? 'settings-sidebar-item-active border-white/14 shadow-[0_10px_24px_rgba(0,0,0,0.12)]'
                            : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="truncate text-[9px] font-medium uppercase tracking-[0.18em] text-text-muted">
                            {note.app_name || 'Unknown app'}
                          </div>
                          <div className="shrink-0 text-[9px] uppercase tracking-[0.18em] text-text-muted">
                            {formatTimestamp(note.created_at)}
                          </div>
                        </div>
                        <div
                          className={`mt-1.5 text-[12px] leading-6 text-text-primary ${isCodeNote(note) ? 'font-mono text-[11.5px]' : ''}`}
                          style={{
                            display: '-webkit-box',
                            WebkitBoxOrient: 'vertical',
                            WebkitLineClamp: 2,
                            overflow: 'hidden',
                          }}
                        >
                          {buildPreview(note.text)}
                        </div>
                        <div className="mt-2 text-[9px] uppercase tracking-[0.16em] text-text-muted">
                          {formatSourceLabel(note)}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </aside>

          <section className="settings-content-shell flex min-w-0 flex-1 flex-col">
            {selectedNote ? (
              <>
                <div className="soft-divider shrink-0 border-b px-6 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Note</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted">
                          {selectedNote.app_name || 'Unknown app'}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
                          {formatTimestamp(selectedNote.created_at)}
                        </span>
                        <span className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
                          {formatSourceLabel(selectedNote)}
                        </span>
                        {selectedNote.output_mode === 'code' ? (
                          <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted">
                            Code
                          </span>
                        ) : null}
                      </div>
                      {selectedNote.window_title ? (
                        <div className="mt-3 truncate text-sm text-text-secondary">
                          {selectedNote.window_title}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void copyNote(selectedNote.text)}
                        className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-text-secondary transition-colors hover:bg-white/[0.08] hover:text-text-primary"
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyAndArchiveNote(selectedNote)}
                        className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-text-secondary transition-colors hover:bg-white/[0.08] hover:text-text-primary"
                      >
                        Copy &amp; Archive
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteNote(selectedNote.id)}
                        className="rounded-full border border-semantic-error/18 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-semantic-error transition-colors hover:bg-semantic-error/12"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                  <div className="glass-card px-5 py-5">
                    {selectedNote.output_mode === 'code' ? (
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[20px] border border-white/6 bg-black/22 px-4 py-4 font-mono text-[13px] leading-7 text-text-primary">
                        <code>{selectedNote.text}</code>
                      </pre>
                    ) : (
                      <div className="whitespace-pre-wrap text-[14px] leading-8 text-text-primary">
                        {selectedNote.text}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-8">
                <div className="section-intro-panel max-w-md rounded-[24px] border border-white/8 px-6 py-6 text-center">
                  <div className="text-sm font-medium text-text-primary">No note selected</div>
                  <div className="mt-2 text-sm leading-6 text-text-secondary">
                    {searchTokens.length
                      ? 'Clear or adjust the search to pick a note from the sidebar.'
                      : 'Select a note from the sidebar to read the full text here.'}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
