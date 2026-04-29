import { RefreshIcon, SetupIcon, WaveIcon } from '../../components/BrandIcons'
import type { DesktopLogKind, DesktopLogSnapshot, HistoryItem, Skill } from '../../types'
import {
  FooterButton,
  LiveLogViewer,
  ReadOnlyShortcut,
  SectionCard,
  StatusBadge,
  ToggleCard,
  UsageMetricCard,
} from '../primitives'

export function VoiceShortcutsSection() {
  return (
    <SectionCard
      title="Shortcuts"
      icon={<WaveIcon size={18} />}
      description="These shortcuts are fixed for now."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <ReadOnlyShortcut
          title="Dictation"
          shortcut="Ctrl+D"
          description="Start or stop dictation."
        />
        <ReadOnlyShortcut
          title="Smart"
          shortcut="Ctrl+T"
          description="Start or stop Smart."
        />
      </div>
    </SectionCard>
  )
}

export function AdvancedUsageSection({
  hasUsageStats,
  metrics,
  resettingUsage,
  trackingLabel,
  onResetUsageStats,
}: {
  hasUsageStats: boolean
  metrics: Array<{ label: string; value: string; hint: string }>
  resettingUsage: boolean
  trackingLabel: string
  onResetUsageStats: () => void
}) {
  return (
    <SectionCard
      title="Usage"
      icon={<WaveIcon size={18} />}
      description="Local counts and timing highlights from successful runs."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label="Local only" tone="neutral" />
          <FooterButton tone="secondary" size="compact" onClick={onResetUsageStats} disabled={resettingUsage || !hasUsageStats}>
            {resettingUsage ? 'Resetting…' : 'Reset stats'}
          </FooterButton>
        </div>
      }
      collapsible
      defaultOpen={false}
    >
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-5">
        {metrics.map((metric) => (
          <UsageMetricCard key={metric.label} label={metric.label} value={metric.value} hint={metric.hint} />
        ))}
      </div>

      <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3 text-sm leading-6 text-text-secondary">
        {hasUsageStats
          ? `Tracking locally since ${trackingLabel}. These stats stay on this Mac and are never uploaded.`
          : 'No local usage yet. Run Dictate or Smart once to start filling this card.'}
      </div>
    </SectionCard>
  )
}

export function AdvancedHistorySection({
  historyItems,
  historySkillOptions,
  resettingHistory,
  resolveHistorySkillSelection,
  writingToolBusy,
  onClearAllHistory,
  onCopyOutput,
  onDeleteHistoryEntry,
  onHistorySkillSelectionChange,
  onReprocessHistoryItem,
  onReuseHistoryTranscript,
  canRerun,
  getRerunNotice,
  formatCapturedAt,
}: {
  historyItems: HistoryItem[]
  historySkillOptions: Skill[]
  resettingHistory: boolean
  resolveHistorySkillSelection: (item: HistoryItem) => string
  writingToolBusy: string | null
  onClearAllHistory: () => void
  onCopyOutput: (output: string) => void
  onDeleteHistoryEntry: (id: number) => void
  onHistorySkillSelectionChange: (id: number, skillId: string) => void
  onReprocessHistoryItem: (id: number, skillId?: string) => void
  onReuseHistoryTranscript: (transcript: string) => void
  canRerun: (item: HistoryItem) => boolean
  getRerunNotice: (item: HistoryItem) => string | null
  formatCapturedAt: (value: string | null | undefined) => string
}) {
  return (
    <SectionCard
      title="History"
      icon={<SetupIcon size={18} />}
      description="Text-only local history for retrying, copying, and deleting previous runs."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label="No audio stored" tone="neutral" />
          <FooterButton tone="secondary" size="compact" onClick={onClearAllHistory} disabled={resettingHistory || historyItems.length === 0}>
            {resettingHistory ? 'Clearing…' : 'Clear history'}
          </FooterButton>
        </div>
      }
      collapsible
      defaultOpen={false}
    >
      <div className="grid gap-4">
        {historyItems.length ? historyItems.map((item) => {
          const itemCanRerun = canRerun(item)
          const rerunNotice = getRerunNotice(item)

          return (
            <div key={item.id} className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text-primary">
                    {item.mode === 'smart_transform'
                      ? 'Smart'
                      : item.mode === 'local_task'
                        ? 'Local task'
                        : 'Dictation'} • {formatCapturedAt(item.created_at)}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    STT {item.stt_provider || 'unknown'} • {item.stt_model || 'unknown'}
                    {item.mode === 'smart_transform' ? ` • LLM ${item.llm_provider || 'unknown'} / ${item.llm_model || 'unknown'}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <FooterButton tone="secondary" size="compact" onClick={() => onReuseHistoryTranscript(item.transcript)}>
                    Use transcript
                  </FooterButton>
                  <FooterButton tone="secondary" size="compact" onClick={() => onCopyOutput(item.final_output)}>
                    Copy output
                  </FooterButton>
                  {itemCanRerun ? (
                    <FooterButton size="compact" onClick={() => onReprocessHistoryItem(item.id)} disabled={writingToolBusy === `history-${item.id}`}>
                      {writingToolBusy === `history-${item.id}` ? 'Reprocessing…' : 'Reprocess'}
                    </FooterButton>
                  ) : null}
                  <FooterButton tone="secondary" size="compact" onClick={() => onDeleteHistoryEntry(item.id)} disabled={writingToolBusy === `history-delete-${item.id}`}>
                    Delete
                  </FooterButton>
                </div>
              </div>
              {itemCanRerun ? (
                <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
                  <div>
                    <label className="mb-2 block text-[11px] uppercase tracking-[0.24em] text-text-muted">Run with a different template</label>
                    <select
                      className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                      value={resolveHistorySkillSelection(item)}
                      onChange={(event) => onHistorySkillSelectionChange(item.id, event.target.value)}
                    >
                      {historySkillOptions.map((skill) => (
                        <option key={skill.id} value={skill.id}>{skill.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <FooterButton
                      size="compact"
                      onClick={() => onReprocessHistoryItem(item.id, resolveHistorySkillSelection(item))}
                      disabled={writingToolBusy === `history-${item.id}`}
                    >
                      {writingToolBusy === `history-${item.id}` ? 'Running…' : 'Run with template'}
                    </FooterButton>
                  </div>
                </div>
              ) : rerunNotice ? (
                <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                  {rerunNotice}
                </div>
              ) : null}
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-white/6 bg-black/25 p-4">
                  <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Transcript</div>
                  <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-primary">{item.transcript}</pre>
                </div>
                <div className="rounded-2xl border border-white/6 bg-black/25 p-4">
                  <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Output</div>
                  <pre className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-primary">{item.final_output}</pre>
                </div>
              </div>
            </div>
          )
        }) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            No text-only history yet. Successful Dictate and Smart runs will appear here.
          </div>
        )}
      </div>
    </SectionCard>
  )
}

export function AdvancedWindowBehaviorSection({
  backgroundOnly,
  onSetBackgroundOnly,
}: {
  backgroundOnly: boolean
  onSetBackgroundOnly: (checked: boolean) => void
}) {
  return (
    <SectionCard
      title="Window behavior"
      icon={<SetupIcon size={18} />}
      description="Keep SteerVox as a tray-first background app unless you explicitly open a window."
      collapsible
      defaultOpen={false}
    >
      <div className="grid gap-4">
        <ToggleCard
          title="Background only"
          description="Hide the dock icon and keep SteerVox tray-first. Hotkeys stay active and windows only appear when you explicitly open them."
          checked={backgroundOnly}
          onChange={onSetBackgroundOnly}
        />
      </div>
    </SectionCard>
  )
}

export function AdvancedLogsSection({
  activeLogTab,
  liveLogs,
  onRefresh,
  onSelectLogTab,
}: {
  activeLogTab: DesktopLogKind
  liveLogs: Record<DesktopLogKind, DesktopLogSnapshot>
  onRefresh: () => void
  onSelectLogTab: (kind: DesktopLogKind) => void
}) {
  return (
    <SectionCard
      title="Logs"
      icon={<RefreshIcon size={18} />}
      description="Watch the latest backend and Electron logs without leaving the app."
      action={<FooterButton onClick={onRefresh}>Refresh</FooterButton>}
      collapsible
      defaultOpen={false}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <FooterButton tone="secondary" size="compact" onClick={() => void window.windowControls?.openLogsDirectory?.()}>
            Open log files
          </FooterButton>
          <FooterButton
            tone="secondary"
            size="compact"
            onClick={() => void window.windowControls?.writeClipboardText?.(liveLogs[activeLogTab].path)}
          >
            Copy visible path
          </FooterButton>
        </div>
        <LiveLogViewer activeKind={activeLogTab} logs={liveLogs} onSelect={onSelectLogTab} />
      </div>
    </SectionCard>
  )
}
