import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import { BrandedProgressLoader } from './components/BrandedProgressLoader'
import { InboxIcon } from './components/BrandIcons'
import { apiDelete, apiGet, apiPost } from './lib/api'
import { getErrorMessage, isAbortError } from './lib/errors'
import {
  createLibraryItems,
  formatLibraryDetailTitle,
  formatLibraryItemLabel,
  formatLibraryTimestamp,
  isLibraryCodeItem,
  matchesLibraryItem,
  tokenizeLibrarySearch,
} from './lib/library'
import { getHistoryItemRerunNotice, isHistoryItemRerunnable } from './lib/historyRuns'
import { createLatestRequestController, responseData, retryRead, runSafeAction, settleRecord, withSignal } from './lib/runtime'
import { useRuntimeStore } from './lib/runtimeStore'
import type { HistoryItem, InboxNote, LibraryFilter, LibraryItem, SectionLoadState, Skill } from './types'

type InboxResponse = {
  notes: InboxNote[]
}
const INITIAL_SECTION_STATE: SectionLoadState = {
  status: 'idle',
  error: null,
  stale: false,
  updatedAt: null,
}

function parseFilter(value: string | null): LibraryFilter {
  if (value === 'notes' || value === 'recent_runs') return value
  return 'all'
}

function itemKey(item: LibraryItem) {
  return `${item.kind}:${item.id}`
}

function formatRunProviders(item: HistoryItem) {
  const stt = `${item.stt_provider || 'unknown'} • ${item.stt_model || 'unknown'}`
  if (item.mode !== 'smart_transform') return `STT ${stt}`
  return `${stt} • LLM ${item.llm_provider || 'unknown'} • ${item.llm_model || 'unknown'}`
}

function ActionChip({
  onClick,
  children,
  tone = 'neutral',
  disabled = false,
}: {
  onClick: () => void
  children: ReactNode
  tone?: 'neutral' | 'danger'
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        tone === 'danger'
          ? 'border-semantic-error/18 text-semantic-error hover:bg-semantic-error/12'
          : 'border-white/10 bg-white/[0.04] text-text-secondary hover:bg-white/[0.08] hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}

export function LibraryView() {
  const runtime = useRuntimeStore((state) => state)
  const { invalidationTokens } = runtime
  const [searchParams, setSearchParams] = useSearchParams()
  const [contentState, setContentState] = useState<SectionLoadState>(INITIAL_SECTION_STATE)
  const [templateState, setTemplateState] = useState<SectionLoadState>(INITIAL_SECTION_STATE)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [notes, setNotes] = useState<InboxNote[]>([])
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [templates, setTemplates] = useState<Skill[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [historyTemplateSelections, setHistoryTemplateSelections] = useState<Record<number, string>>({})
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const lastLoadAtRef = useRef(0)
  const requestsRef = useRef(createLatestRequestController())
  const notesRef = useRef<InboxNote[]>([])
  const historyRef = useRef<HistoryItem[]>([])
  const templatesRef = useRef<Skill[]>([])
  const contentStateRef = useRef<SectionLoadState>(INITIAL_SECTION_STATE)
  const templateStateRef = useRef<SectionLoadState>(INITIAL_SECTION_STATE)

  const activeFilter = parseFilter(searchParams.get('filter'))

  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  useEffect(() => {
    historyRef.current = historyItems
  }, [historyItems])

  useEffect(() => {
    templatesRef.current = templates
  }, [templates])

  useEffect(() => {
    contentStateRef.current = contentState
  }, [contentState])

  useEffect(() => {
    templateStateRef.current = templateState
  }, [templateState])

  const loadData = useCallback(async (force = false) => {
    const now = Date.now()
    if (!force && now - lastLoadAtRef.current < 250) return
    lastLoadAtRef.current = now
    const request = requestsRef.current.begin()
    if (!notesRef.current.length && !historyRef.current.length) {
      setContentState((current) => ({ ...current, status: 'loading', error: null }))
    }
    if (!templatesRef.current.length) {
      setTemplateState((current) => ({ ...current, status: 'loading', error: null }))
    }

    try {
      const settled = await retryRead(async (signal) => (
        settleRecord<{
          notes: Promise<InboxResponse>
          history: Promise<{ items: HistoryItem[] }>
          skills: Promise<{ skills: Skill[] }>
        }>({
          notes: apiGet<InboxResponse>('/inbox', withSignal({ timeout: 10000 }, signal)).then(responseData),
          history: apiGet<{ items: HistoryItem[] }>('/history', withSignal({ timeout: 10000 }, signal)).then(responseData),
          skills: apiGet<{ skills: Skill[] }>('/skills', withSignal({ timeout: 10000 }, signal)).then(responseData),
        })
      ), { signal: request.signal })

      if (!requestsRef.current.isLatest(request.token)) return

      if (settled.notes.status === 'fulfilled') {
        setNotes(settled.notes.value.notes || [])
      }
      if (settled.history.status === 'fulfilled') {
        setHistoryItems(settled.history.value.items || [])
      }
      if (settled.skills.status === 'fulfilled') {
        setTemplates(settled.skills.value.skills || [])
      }

      const contentErrors = [
        settled.notes.status === 'rejected' ? 'Notes' : null,
        settled.history.status === 'rejected' ? 'Recent runs' : null,
      ].filter(Boolean)

      setContentState({
        status: contentErrors.length ? 'stale' : 'ready',
        error: contentErrors.length ? `${contentErrors.join(' and ')} could not refresh. Showing the last successful load.` : null,
        stale: Boolean(contentErrors.length),
        updatedAt: Date.now(),
      })
      setTemplateState({
        status: settled.skills.status === 'fulfilled' ? 'ready' : templatesRef.current.length ? 'stale' : 'error',
        error: settled.skills.status === 'rejected' ? 'Templates could not refresh. Existing options are still available.' : null,
        stale: settled.skills.status === 'rejected' && templatesRef.current.length > 0,
        updatedAt: settled.skills.status === 'fulfilled' ? Date.now() : templateStateRef.current.updatedAt,
      })
      setError(null)
    } catch (nextError: unknown) {
      if (isAbortError(nextError) || !requestsRef.current.isLatest(request.token)) return
      const hasLastGoodData = notesRef.current.length > 0 || historyRef.current.length > 0
      const message = getErrorMessage(nextError, 'Unable to load your Library right now.')
      setContentState({
        status: hasLastGoodData ? 'stale' : 'error',
        error: message,
        stale: hasLastGoodData,
        updatedAt: contentStateRef.current.updatedAt,
      })
      setError(message)
    }
  }, [])

  useEffect(() => {
    const requests = requestsRef.current
    const timer = window.setTimeout(() => {
      void loadData(true)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      requests.cancel()
    }
  }, [loadData])

  useEffect(() => {
    if (
      invalidationTokens.inbox === 0
      && invalidationTokens.history === 0
      && invalidationTokens.skills === 0
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      void loadData(true)
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [invalidationTokens.history, invalidationTokens.inbox, invalidationTokens.skills, loadData])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2600)
    return () => clearTimeout(timer)
  }, [notice])

  const allItems = useMemo(
    () => createLibraryItems(notes, historyItems),
    [historyItems, notes],
  )
  const searchTokens = useMemo(() => tokenizeLibrarySearch(searchQuery), [searchQuery])
  const filteredItems = useMemo(
    () => allItems.filter((item) => matchesLibraryItem(item, searchTokens, activeFilter)),
    [activeFilter, allItems, searchTokens],
  )
  const selectedItem = useMemo(
    () => {
      const effectiveKey = selectedKey && filteredItems.some((item) => itemKey(item) === selectedKey)
        ? selectedKey
        : filteredItems[0]
          ? itemKey(filteredItems[0])
          : null
      return effectiveKey ? filteredItems.find((item) => itemKey(item) === effectiveKey) ?? null : null
    },
    [filteredItems, selectedKey],
  )
  const selectedItemKey = selectedItem ? itemKey(selectedItem) : null
  const historyTemplateOptions = useMemo(
    () => templates.filter((template) => template.id !== 'system_dictation'),
    [templates],
  )

  const updateFilter = (nextFilter: LibraryFilter) => {
    const nextParams = new URLSearchParams(searchParams)
    if (nextFilter === 'all') nextParams.delete('filter')
    else nextParams.set('filter', nextFilter)
    setSearchParams(nextParams, { replace: true })
  }

  const copyText = async (text: string, label: string) => {
    await runSafeAction(
      async () => window.windowControls?.writeClipboardText?.(text),
      {
        fallbackError: 'Unable to copy that text right now.',
        onSuccess: () => setNotice(label),
        onError: setError,
      },
    )
  }

  const deleteNote = async (noteId: string) => {
    setBusyAction(`note-delete-${noteId}`)
    const result = await runSafeAction(
      async () => {
        await apiDelete(`/inbox/${noteId}`)
        await loadData(true)
        return true
      },
      {
        fallbackError: 'Unable to delete that note.',
        onSuccess: () => setNotice('Note deleted'),
        onError: setError,
      },
    )
    setBusyAction(null)
    return Boolean(result)
  }

  const copyAndArchiveNote = async (note: InboxNote) => {
    try {
      await copyText(note.text, 'Copied output')
      const deleted = await deleteNote(note.id)
      if (!deleted) {
        setError('Copied the note, but could not archive it.')
      }
    } catch (nextError: unknown) {
      setError(getErrorMessage(nextError, 'Unable to copy and archive that note.'))
    }
  }

  const rerunHistoryItem = async (id: number, templateId?: string) => {
    setBusyAction(`history-${id}`)
    await runSafeAction(
      async () => {
        await apiPost(`/history/${id}/reprocess`, templateId ? { skill_id: templateId } : {})
        await loadData(true)
      },
      {
        fallbackError: 'Unable to re-run that item right now.',
        onSuccess: () => setNotice(templateId ? 'Re-run started with template' : 'Re-run started'),
        onError: setError,
      },
    )
    setBusyAction(null)
  }

  const deleteHistoryItem = async (id: number) => {
    setBusyAction(`history-delete-${id}`)
    await runSafeAction(
      async () => {
        await apiDelete(`/history/${id}`)
        await loadData(true)
      },
      {
        fallbackError: 'Unable to delete that run.',
        onSuccess: () => setNotice('Run deleted'),
        onError: setError,
      },
    )
    setBusyAction(null)
  }

  const resolveTemplateSelection = (item: HistoryItem) => (
    historyTemplateSelections[item.id]
    || item.telemetry.skill_used?.id
    || historyTemplateOptions[0]?.id
    || ''
  )

  const resultLabel = `${filteredItems.length} item${filteredItems.length === 1 ? '' : 's'}`
  const selectedHistoryItem = selectedItem?.kind === 'history' ? selectedItem.history : null
  const selectedHistoryIsRerunnable = selectedHistoryItem ? isHistoryItemRerunnable(selectedHistoryItem) : false
  const selectedHistoryRerunNotice = selectedHistoryItem ? getHistoryItemRerunNotice(selectedHistoryItem) : null

  return (
    <div className="h-full overflow-hidden px-8 py-6">
      <div className="mx-auto flex h-full max-w-6xl flex-col">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-text-muted">Library</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text-primary">Notes and recent runs.</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-text-secondary">
              Search saved notes and recent dictation or rewrite runs in one place. Nothing here changes backend storage or contracts.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ActionChip onClick={() => void loadData(true)}>Refresh</ActionChip>
          </div>
        </div>

        {notice ? (
          <div className="mt-5 rounded-2xl border border-semantic-success/20 bg-semantic-success/8 px-4 py-3 text-sm leading-6 text-text-secondary">
            {notice}
          </div>
        ) : null}

        {error ? (
          <div className="mt-5 rounded-2xl border border-semantic-error/20 bg-semantic-error/10 px-4 py-3 text-sm leading-6 text-text-secondary">
            {error}
          </div>
        ) : null}

        {!error && (contentState.stale || templateState.stale) ? (
          <div className="mt-5 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
            {contentState.error || templateState.error || 'Some Library sections are showing the last successful load.'}
          </div>
        ) : null}

        <div className="mt-6 min-h-0 flex-1">
          <div className="flex h-full min-h-0 gap-4">
            <aside className="settings-sidebar flex w-[324px] shrink-0 flex-col overflow-hidden rounded-[24px] border border-white/7 p-3">
              <div className="shrink-0">
                <div className="flex items-center gap-3 px-2 py-2">
                  <div className="widget-control flex h-10 w-10 items-center justify-center rounded-2xl text-text-primary">
                    <InboxIcon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary">Library</div>
                    <div className="mt-1 text-xs leading-5 text-text-secondary">{resultLabel}</div>
                  </div>
                </div>

                <div className="section-intro-panel mt-3 rounded-2xl border border-white/6 p-3.5">
                  <label className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.24em] text-text-muted">
                    Search
                  </label>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Find notes and runs"
                    className="w-full rounded-2xl border border-white/8 bg-black/24 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-white/16 focus:ring-2 focus:ring-white/12"
                  />

                  <div className="mt-3 flex flex-wrap gap-2">
                    {([
                      ['all', 'All'],
                      ['notes', 'Notes'],
                      ['recent_runs', 'Recent runs'],
                    ] as const).map(([value, label]) => {
                      const active = activeFilter === value
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => updateFilter(value)}
                          className={`rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] transition-colors ${
                            active
                              ? 'border-white/14 bg-white/[0.08] text-text-primary'
                              : 'border-white/8 bg-white/[0.03] text-text-secondary hover:border-white/12 hover:bg-white/[0.05] hover:text-text-primary'
                          }`}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-1">
                {contentState.status === 'loading' && !allItems.length ? (
                  <div className="flex h-full items-center justify-center px-4">
                    <BrandedProgressLoader
                      compact
                      title="Loading Library"
                      subtitle="Merging notes and recent runs."
                    />
                  </div>
                ) : filteredItems.length ? (
                  <div className="space-y-2">
                    {filteredItems.map((item) => {
                      const active = itemKey(item) === selectedItemKey
                      return (
                        <button
                          key={itemKey(item)}
                          type="button"
                          onClick={() => setSelectedKey(itemKey(item))}
                          className={`w-full rounded-[20px] border px-3 py-3 text-left transition-colors ${
                            active
                              ? 'settings-sidebar-item-active border-white/14 shadow-[0_10px_24px_rgba(0,0,0,0.12)]'
                              : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.05]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="truncate text-[10px] uppercase tracking-[0.18em] text-text-muted">{item.app_name}</div>
                            <div className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-text-muted">{formatLibraryTimestamp(item.created_at)}</div>
                          </div>
                          <div className={`mt-2 text-sm leading-6 text-text-primary ${isLibraryCodeItem(item) ? 'font-mono text-[12px]' : ''}`}>
                            {item.preview}
                          </div>
                          <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-text-secondary">{formatLibraryItemLabel(item)}</div>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-5 text-sm leading-6 text-text-secondary">
                    {searchQuery
                      ? 'No Library items match the current search.'
                      : activeFilter === 'notes'
                        ? 'Saved notes will show up here after you use Smart with a note phrase.'
                        : 'Dictation and Smart runs will appear here after the first successful pass.'}
                  </div>
                )}
              </div>
            </aside>

            <section className="settings-content-shell flex min-w-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-white/7">
              {selectedItem ? (
                <>
                  <div className="soft-divider shrink-0 border-b px-6 py-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[11px] uppercase tracking-[0.22em] text-text-muted">{formatLibraryDetailTitle(selectedItem)}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted">
                            {selectedItem.app_name}
                          </span>
                          <span className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
                            {formatLibraryTimestamp(selectedItem.created_at)}
                          </span>
                          <span className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
                            {formatLibraryItemLabel(selectedItem)}
                          </span>
                          {selectedItem.output_mode ? (
                            <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted">
                              {selectedItem.output_mode.replace('_', ' ')}
                            </span>
                          ) : null}
                        </div>
                        {selectedItem.window_title ? (
                          <div className="mt-3 truncate text-sm text-text-secondary">{selectedItem.window_title}</div>
                        ) : null}
                      </div>

                      {selectedItem.kind === 'note' ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <ActionChip onClick={() => void copyText(selectedItem.note.text, 'Copied output')}>Copy</ActionChip>
                          <ActionChip onClick={() => void copyAndArchiveNote(selectedItem.note)}>Copy & Archive</ActionChip>
                          <ActionChip
                            tone="danger"
                            disabled={busyAction === `note-delete-${selectedItem.note.id}`}
                            onClick={() => void deleteNote(selectedItem.note.id)}
                          >
                            Delete
                          </ActionChip>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <ActionChip onClick={() => void copyText(selectedItem.history.transcript, 'Copied output')}>Use transcript</ActionChip>
                          <ActionChip onClick={() => void copyText(selectedItem.history.final_output, 'Copied output')}>Copy output</ActionChip>
                          {selectedHistoryIsRerunnable ? (
                            <ActionChip
                              disabled={busyAction === `history-${selectedItem.history.id}`}
                              onClick={() => void rerunHistoryItem(selectedItem.history.id)}
                            >
                              {busyAction === `history-${selectedItem.history.id}` ? 'Running…' : 'Re-run'}
                            </ActionChip>
                          ) : null}
                          <ActionChip
                            tone="danger"
                            disabled={busyAction === `history-delete-${selectedItem.history.id}`}
                            onClick={() => void deleteHistoryItem(selectedItem.history.id)}
                          >
                            Delete
                          </ActionChip>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                    {selectedItem.kind === 'note' ? (
                      <div className="glass-card px-5 py-5">
                        {isLibraryCodeItem(selectedItem) ? (
                          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[20px] border border-white/6 bg-black/22 px-4 py-4 font-mono text-[13px] leading-7 text-text-primary">
                            <code>{selectedItem.note.text}</code>
                          </pre>
                        ) : (
                          <div className="whitespace-pre-wrap text-[14px] leading-8 text-text-primary">{selectedItem.note.text}</div>
                        )}
                      </div>
                    ) : (
                      <div className="grid gap-5">
                        <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
                          {selectedHistoryIsRerunnable ? (
                            <div className="flex flex-wrap items-end gap-4">
                              <div className="min-w-0 flex-1">
                                <label className="mb-3 block text-[11px] uppercase tracking-[0.24em] text-text-muted">Run with a different template</label>
                                <select
                                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                  value={resolveTemplateSelection(selectedItem.history)}
                                  onChange={(event) => setHistoryTemplateSelections((current) => ({
                                    ...current,
                                    [selectedItem.history.id]: event.target.value,
                                  }))}
                                >
                                  {historyTemplateOptions.map((template) => (
                                    <option key={template.id} value={template.id}>{template.name}</option>
                                  ))}
                                </select>
                              </div>
                              <ActionChip
                                disabled={busyAction === `history-${selectedItem.history.id}` || !resolveTemplateSelection(selectedItem.history)}
                                onClick={() => void rerunHistoryItem(selectedItem.history.id, resolveTemplateSelection(selectedItem.history))}
                              >
                                {busyAction === `history-${selectedItem.history.id}` ? 'Running…' : 'Run with template'}
                              </ActionChip>
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                              {selectedHistoryRerunNotice}
                            </div>
                          )}
                          <div className="mt-4 text-sm leading-6 text-text-secondary">{formatRunProviders(selectedItem.history)}</div>
                        </div>

                        <div className="grid gap-5 xl:grid-cols-2">
                          <div className="glass-card p-5">
                            <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Transcript</div>
                            <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-primary">{selectedItem.history.transcript}</pre>
                          </div>
                          <div className="glass-card p-5">
                            <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">
                              {selectedItem.source_mode === 'smart_transform' ? 'Smart output' : 'Dictation output'}
                            </div>
                            {isLibraryCodeItem(selectedItem) ? (
                              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-[20px] border border-white/6 bg-black/22 px-4 py-4 font-mono text-[13px] leading-7 text-text-primary">
                                <code>{selectedItem.history.final_output}</code>
                              </pre>
                            ) : (
                              <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-primary">{selectedItem.history.final_output}</pre>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-8">
                  <div className="section-intro-panel max-w-md rounded-[24px] border border-white/8 px-6 py-6 text-center">
                    <div className="text-sm font-medium text-text-primary">No item selected</div>
                    <div className="mt-2 text-sm leading-6 text-text-secondary">
                      {searchQuery
                        ? 'Clear or broaden the current search to pick an item from the Library.'
                        : 'Select a note or recent run from the left to inspect it here.'}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
