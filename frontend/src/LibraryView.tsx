import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import { BrandedProgressLoader } from './components/BrandedProgressLoader'
import { InboxIcon } from './components/BrandIcons'
import { apiDelete, apiGet, apiPost } from './lib/api'
import { getErrorMessage, isAbortError } from './lib/errors'
import {
  formatLibraryDetailTitle,
  formatLibraryItemLabel,
  formatLibraryLaneLabel,
  formatLibraryProviderSummary,
  formatLibraryTimestamp,
  isLibraryCodeItem,
} from './lib/library'
import { getHistoryItemRerunNotice, isHistoryItemRerunnable } from './lib/historyRuns'
import { createLatestRequestController, responseData, retryRead, runSafeAction, settleRecord, withSignal } from './lib/runtime'
import { useRuntimeStore } from './lib/runtimeStore'
import type { HistoryItem, LibraryFilter, LibraryItem, SectionLoadState, Skill } from './types'

const INITIAL_SECTION_STATE: SectionLoadState = {
  status: 'idle',
  error: null,
  stale: false,
  updatedAt: null,
}

const FILTER_BUTTONS: ReadonlyArray<{ value: LibraryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'notes', label: 'Notes' },
  { value: 'runs', label: 'Recent runs' },
]

function parseFilter(value: string | null): LibraryFilter {
  if (value === 'notes' || value === 'runs' || value === 'smart' || value === 'dictate' || value === 'local_task' || value === 'computer_use') {
    return value
  }
  return 'all'
}

function itemKey(item: LibraryItem) {
  return item.id
}

function formatLibrarySourceLabel(item: LibraryItem) {
  return item.metadata.url_host || item.metadata.app_name || 'Unknown App'
}

function formatRunProviders(item: LibraryItem) {
  const parts = [formatLibraryProviderSummary(item)]
  if (item.metadata.local_only) {
    parts.push('Local only')
  }
  return parts.filter(Boolean).join(' • ')
}

function formatOutputTitle(item: LibraryItem, historyItem: HistoryItem | null) {
  if (!historyItem) {
    return item.source_type === 'history' ? 'Run output' : 'Saved content'
  }
  if (historyItem.telemetry.intent === 'computer_use') {
    return 'Computer use output'
  }
  if (item.metadata.source_mode === 'smart_transform') {
    return 'Smart output'
  }
  if (item.metadata.source_mode === 'local_task') {
    return 'Task output'
  }
  return 'Dictation output'
}

function parseHistoryId(item: LibraryItem | null) {
  if (!item || item.source_type !== 'history') return null
  const parsed = Number.parseInt(item.source_id, 10)
  return Number.isFinite(parsed) ? parsed : null
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
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([])
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [templates, setTemplates] = useState<Skill[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [historyTemplateSelections, setHistoryTemplateSelections] = useState<Record<number, string>>({})
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const requestsRef = useRef(createLatestRequestController())
  const itemsRef = useRef<LibraryItem[]>([])
  const contentStateRef = useRef<SectionLoadState>(INITIAL_SECTION_STATE)
  const templateStateRef = useRef<SectionLoadState>(INITIAL_SECTION_STATE)

  const activeFilter = parseFilter(searchParams.get('filter'))

  useEffect(() => {
    itemsRef.current = libraryItems
  }, [libraryItems])

  useEffect(() => {
    contentStateRef.current = contentState
  }, [contentState])

  useEffect(() => {
    templateStateRef.current = templateState
  }, [templateState])

  const loadData = useCallback(async () => {
    const request = requestsRef.current.begin()
    if (!itemsRef.current.length) {
      setContentState((current) => ({ ...current, status: 'loading', error: null }))
    }
    if (!templates.length) {
      setTemplateState((current) => ({ ...current, status: 'loading', error: null }))
    }

    const params = new URLSearchParams()
    if (activeFilter !== 'all') params.set('filter', activeFilter)
    if (searchQuery.trim()) params.set('q', searchQuery.trim())
    params.set('limit', '500')

    try {
      const settled = await retryRead(async (signal) => (
        settleRecord<{
          library: Promise<{ items: LibraryItem[] }>
          history: Promise<{ items: HistoryItem[] }>
          skills: Promise<{ skills: Skill[] }>
        }>({
          library: apiGet<{ items: LibraryItem[] }>(`/library?${params.toString()}`, withSignal({ timeout: 10000 }, signal)).then(responseData),
          history: apiGet<{ items: HistoryItem[] }>('/history', withSignal({ timeout: 10000 }, signal)).then(responseData),
          skills: apiGet<{ skills: Skill[] }>('/skills', withSignal({ timeout: 10000 }, signal)).then(responseData),
        })
      ), { signal: request.signal })

      if (!requestsRef.current.isLatest(request.token)) return

      if (settled.library.status === 'fulfilled') {
        setLibraryItems(settled.library.value.items || [])
      }
      if (settled.history.status === 'fulfilled') {
        setHistoryItems(settled.history.value.items || [])
      }
      if (settled.skills.status === 'fulfilled') {
        setTemplates(settled.skills.value.skills || [])
      }

      const contentErrors = [
        settled.library.status === 'rejected' ? 'Library' : null,
        settled.history.status === 'rejected' ? 'Run details' : null,
      ].filter(Boolean)

      setContentState({
        status: contentErrors.length ? 'stale' : 'ready',
        error: contentErrors.length ? `${contentErrors.join(' and ')} could not refresh. Showing the last successful load.` : null,
        stale: Boolean(contentErrors.length),
        updatedAt: Date.now(),
      })
      setTemplateState({
        status: settled.skills.status === 'fulfilled' ? 'ready' : templates.length ? 'stale' : 'error',
        error: settled.skills.status === 'rejected' ? 'Templates could not refresh. Existing options are still available.' : null,
        stale: settled.skills.status === 'rejected' && templates.length > 0,
        updatedAt: settled.skills.status === 'fulfilled' ? Date.now() : templateStateRef.current.updatedAt,
      })
      setError(null)
    } catch (nextError: unknown) {
      if (isAbortError(nextError) || !requestsRef.current.isLatest(request.token)) return
      const hasLastGoodData = itemsRef.current.length > 0
      const message = getErrorMessage(nextError, 'Unable to load your Library right now.')
      setContentState({
        status: hasLastGoodData ? 'stale' : 'error',
        error: message,
        stale: hasLastGoodData,
        updatedAt: contentStateRef.current.updatedAt,
      })
      setError(message)
    }
  }, [activeFilter, searchQuery, templates.length])

  useEffect(() => {
    const requests = requestsRef.current
    const timer = window.setTimeout(() => {
      void loadData()
    }, searchQuery.trim() ? 180 : 0)
    return () => {
      window.clearTimeout(timer)
      requests.cancel()
    }
  }, [loadData, searchQuery])

  useEffect(() => {
    if (invalidationTokens.history === 0 && invalidationTokens.inbox === 0 && invalidationTokens.skills === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      void loadData()
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

  const selectedItem = useMemo(() => {
    const effectiveKey = selectedKey && libraryItems.some((item) => itemKey(item) === selectedKey)
      ? selectedKey
      : libraryItems[0]?.id ?? null
    return effectiveKey ? libraryItems.find((item) => itemKey(item) === effectiveKey) ?? null : null
  }, [libraryItems, selectedKey])
  const selectedItemKey = selectedItem ? itemKey(selectedItem) : null
  const historyById = useMemo(
    () => new Map(historyItems.map((item) => [String(item.id), item])),
    [historyItems],
  )
  const selectedHistoryItem = selectedItem?.source_type === 'history'
    ? historyById.get(selectedItem.source_id) ?? null
    : null
  const selectedHistoryId = parseHistoryId(selectedItem)
  const selectedHistoryTranscript = selectedItem?.source_type === 'history'
    ? (selectedHistoryItem?.transcript || selectedItem.secondary_text || selectedItem.primary_text)
    : ''
  const selectedHistoryOutput = selectedItem?.source_type === 'history'
    ? (selectedHistoryItem?.final_output || selectedItem.primary_text)
    : ''
  const selectedHistoryIsRerunnable = selectedHistoryId !== null && (
    selectedHistoryItem ? isHistoryItemRerunnable(selectedHistoryItem) : true
  )
  const selectedHistoryRerunNotice = selectedHistoryItem ? getHistoryItemRerunNotice(selectedHistoryItem) : null
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
        await loadData()
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

  const copyAndArchiveNote = async (item: LibraryItem) => {
    try {
      await copyText(item.primary_text, 'Copied output')
      const deleted = await deleteNote(item.source_id)
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
        await loadData()
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
        await loadData()
      },
      {
        fallbackError: 'Unable to delete that run.',
        onSuccess: () => setNotice('Run deleted'),
        onError: setError,
      },
    )
    setBusyAction(null)
  }

  const resolveTemplateSelection = (historyId: number, item?: HistoryItem | null) => (
    historyTemplateSelections[historyId]
    || item?.telemetry.skill_used?.id
    || historyTemplateOptions[0]?.id
    || ''
  )

  const resultLabel = `${libraryItems.length} item${libraryItems.length === 1 ? '' : 's'}`
  const selectedOutputTitle = selectedItem ? formatOutputTitle(selectedItem, selectedHistoryItem) : 'Saved content'
  const selectedProviderSummary = selectedItem ? formatRunProviders(selectedItem) : null
  const selectedStepSummary = selectedItem?.metadata.step_count
    ? `${selectedItem.metadata.completed_steps || 0}/${selectedItem.metadata.step_count} steps`
    : null

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
            <ActionChip onClick={() => void loadData()}>Refresh</ActionChip>
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
                    {FILTER_BUTTONS.map(({ value, label }) => {
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
                {contentState.status === 'loading' && !libraryItems.length ? (
                  <div className="flex h-full items-center justify-center px-4">
                    <BrandedProgressLoader
                      compact
                      title="Loading Library"
                      subtitle="Fetching notes and recent runs."
                    />
                  </div>
                ) : libraryItems.length ? (
                  <div className="space-y-2">
                    {libraryItems.map((item) => {
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
                            <div className="truncate text-[10px] uppercase tracking-[0.18em] text-text-muted">
                              {formatLibrarySourceLabel(item)}
                            </div>
                            <div className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-text-muted">
                              {formatLibraryTimestamp(item.created_at)}
                            </div>
                          </div>
                          <div className={`mt-2 text-sm leading-6 text-text-primary ${isLibraryCodeItem(item) ? 'font-mono text-[12px]' : ''}`}>
                            {item.preview}
                          </div>
                          <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-text-secondary">
                            {formatLibraryItemLabel(item)}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-5 text-sm leading-6 text-text-secondary">
                    {searchQuery
                      ? 'No Library items match the current search.'
                      : activeFilter === 'notes'
                        ? 'Saved notes will show up here after you save one from Dictate or Smart.'
                        : activeFilter === 'runs'
                          ? 'Runs will appear here after your first successful Dictate, Smart, or local task pass.'
                          : 'Your Library will populate after the first saved note or run.'}
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
                            {formatLibrarySourceLabel(selectedItem)}
                          </span>
                          <span className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
                            {formatLibraryTimestamp(selectedItem.created_at)}
                          </span>
                          <span className="text-[11px] uppercase tracking-[0.16em] text-text-muted">
                            {formatLibraryLaneLabel(selectedItem.lane)}
                          </span>
                        </div>
                        {selectedItem.metadata.window_title ? (
                          <div className="mt-3 truncate text-sm text-text-secondary">{selectedItem.metadata.window_title}</div>
                        ) : selectedItem.metadata.page_title ? (
                          <div className="mt-3 truncate text-sm text-text-secondary">{selectedItem.metadata.page_title}</div>
                        ) : null}
                      </div>

                      {selectedItem.source_type === 'note' ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <ActionChip onClick={() => void copyText(selectedItem.primary_text, 'Copied output')}>Copy</ActionChip>
                          <ActionChip onClick={() => void copyAndArchiveNote(selectedItem)}>Copy & Archive</ActionChip>
                          <ActionChip
                            tone="danger"
                            disabled={busyAction === `note-delete-${selectedItem.source_id}`}
                            onClick={() => void deleteNote(selectedItem.source_id)}
                          >
                            Delete
                          </ActionChip>
                        </div>
                      ) : selectedItem.source_type === 'history' ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <ActionChip onClick={() => void copyText(selectedHistoryTranscript, 'Copied transcript')}>Copy transcript</ActionChip>
                          <ActionChip onClick={() => void copyText(selectedHistoryOutput, 'Copied output')}>Copy output</ActionChip>
                          {selectedHistoryIsRerunnable ? (
                            <ActionChip
                              disabled={busyAction === `history-${selectedHistoryId}`}
                              onClick={() => {
                                if (selectedHistoryId !== null) {
                                  void rerunHistoryItem(selectedHistoryId)
                                }
                              }}
                            >
                              {busyAction === `history-${selectedHistoryId}` ? 'Running...' : 'Re-run'}
                            </ActionChip>
                          ) : null}
                          {selectedHistoryId !== null ? (
                            <ActionChip
                              tone="danger"
                              disabled={busyAction === `history-delete-${selectedHistoryId}`}
                              onClick={() => void deleteHistoryItem(selectedHistoryId)}
                            >
                              Delete
                            </ActionChip>
                          ) : null}
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <ActionChip onClick={() => void copyText(selectedItem.primary_text, 'Copied output')}>Copy output</ActionChip>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                    {selectedItem.source_type === 'note' ? (
                      <div className="glass-card px-5 py-5">
                        <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{selectedOutputTitle}</div>
                        {isLibraryCodeItem(selectedItem) ? (
                          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-[20px] border border-white/6 bg-black/22 px-4 py-4 font-mono text-[13px] leading-7 text-text-primary">
                            <code>{selectedItem.primary_text}</code>
                          </pre>
                        ) : (
                          <div className="mt-3 whitespace-pre-wrap text-[14px] leading-8 text-text-primary">{selectedItem.primary_text}</div>
                        )}
                        {selectedItem.secondary_text ? (
                          <div className="mt-4 border-t border-white/6 pt-4 text-sm leading-6 text-text-secondary">
                            {selectedItem.secondary_text}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="grid gap-5">
                        <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
                          {selectedHistoryId !== null && selectedHistoryIsRerunnable ? (
                            <div className="flex flex-wrap items-end gap-4">
                              <div className="min-w-0 flex-1">
                                <label className="mb-3 block text-[11px] uppercase tracking-[0.24em] text-text-muted">Run with a different template</label>
                                <select
                                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                  value={resolveTemplateSelection(selectedHistoryId, selectedHistoryItem)}
                                  onChange={(event) => setHistoryTemplateSelections((current) => ({
                                    ...current,
                                    [selectedHistoryId]: event.target.value,
                                  }))}
                                >
                                  {historyTemplateOptions.map((template) => (
                                    <option key={template.id} value={template.id}>{template.name}</option>
                                  ))}
                                </select>
                              </div>
                              <ActionChip
                                disabled={busyAction === `history-${selectedHistoryId}` || !resolveTemplateSelection(selectedHistoryId, selectedHistoryItem)}
                                onClick={() => void rerunHistoryItem(selectedHistoryId, resolveTemplateSelection(selectedHistoryId, selectedHistoryItem))}
                              >
                                {busyAction === `history-${selectedHistoryId}` ? 'Running...' : 'Run with template'}
                              </ActionChip>
                            </div>
                          ) : (
                            <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                              {selectedHistoryRerunNotice || 'Run details are available, but this item cannot be re-run from the current context.'}
                            </div>
                          )}

                          <div className="mt-4 grid gap-2 text-sm leading-6 text-text-secondary xl:grid-cols-2">
                            {selectedProviderSummary ? <div>{selectedProviderSummary}</div> : null}
                            {selectedStepSummary ? <div>{selectedStepSummary}</div> : null}
                            {selectedItem.metadata.duration_ms ? <div>{selectedItem.metadata.duration_ms} ms</div> : null}
                            {selectedItem.metadata.failed_step_title ? <div>Failed step: {selectedItem.metadata.failed_step_title}</div> : null}
                          </div>
                        </div>

                        <div className="grid gap-5 xl:grid-cols-2">
                          <div className="glass-card p-5">
                            <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Transcript</div>
                            <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-primary">
                              {selectedHistoryTranscript || 'Transcript details are unavailable for this run.'}
                            </pre>
                          </div>
                          <div className="glass-card p-5">
                            <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{selectedOutputTitle}</div>
                            {isLibraryCodeItem(selectedItem) ? (
                              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-[20px] border border-white/6 bg-black/22 px-4 py-4 font-mono text-[13px] leading-7 text-text-primary">
                                <code>{selectedHistoryOutput}</code>
                              </pre>
                            ) : (
                              <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-primary">{selectedHistoryOutput}</pre>
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
