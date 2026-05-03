import { BrandedProgressLoader } from '../../components/BrandedProgressLoader'
import { SetupIcon, ShieldIcon, SparkIcon } from '../../components/BrandIcons'
import { DISPLAY_NAME } from '../../../shared/branding'
import {
  type AppConfig,
  type AppDomainDefault,
  type AppLaunchContext,
  type DesktopLogKind,
  type DesktopLogSnapshot,
  type DictionaryEntry,
  type DomainMode,
  type DomainPackDetail,
  type DomainPackSummary,
  type HistoryItem,
  type LearnedMemory,
  type ReplacementEntry,
  type SemanticMemoryInstallState,
  type Skill,
  type SmartContext,
  type SmartRunTelemetry,
  type SnippetEntry,
  type WritingToolsSnapshot,
} from '../../types'
import { buildDomainGuidance, DICTIONARY_EXAMPLES, formatAliases } from '../constants'
import {
  buildSemanticMemoryDiagnostics,
  describeDomainMode,
  describeSemanticMemoryUi,
  formatActionRoute,
  formatCapturedAt,
  formatDomainFormat,
  formatDomainLabel,
  formatDomainMode,
  formatDomainSource,
  formatDomainSurfaceBehavior,
  formatDuration,
  formatExternalContextSource,
  formatPercent,
  formatPlannerResolverLabel,
  formatSemanticMemoryInstallerLabel,
  formatSkillSource,
  formatTargetType,
} from '../display'
import {
  ContextField,
  FooterButton,
  InlineSwitch,
  InspectorField,
  OptionalContextField,
  SectionCard,
  StatusBadge,
  ToggleCard,
} from '../primitives'
import {
  AdvancedHistorySection,
  AdvancedLogsSection,
  AdvancedUsageSection,
  AdvancedWindowBehaviorSection,
} from './AdvancedUtilitySections'

type WritingToolDraft = {
  source_text?: string
  canonical_text?: string
  aliases_text?: string
  replacement_text?: string
  trigger?: string
  expansion?: string
  match_type?: 'exact' | 'inline'
}

type DomainActionState = {
  type: 'idle' | 'importing' | 'exporting' | 'saving'
  domainId: string | null
  message: string | null
  error: string | null
}

type AdvancedSectionProps = {
  draftConfig: AppConfig
  developerMode: boolean
  semanticMemoryInstallState: SemanticMemoryInstallState
  showSemanticMemoryLogs: boolean
  memories: LearnedMemory[]
  memoryBusy: string | null
  memoryError: string | null
  onSetDraftConfig: (config: AppConfig) => void
  onToggleShowSemanticMemoryLogs: () => void
  onSetMemoryEnabled: (memoryId: number, enabled: boolean) => void
  onDeleteMemory: (memoryId: number) => void
  onRebuildMemories: () => void
  onClearAllMemories: () => void
  writingTools: WritingToolsSnapshot
  activeWritingTab: 'dictionary' | 'replacements' | 'snippets'
  writingToolDraft: WritingToolDraft
  editingWritingToolId: number | null
  writingToolBusy: string | null
  onSetActiveWritingTab: (tab: 'dictionary' | 'replacements' | 'snippets') => void
  onSetWritingToolDraft: (
    next: WritingToolDraft | ((current: WritingToolDraft) => WritingToolDraft),
  ) => void
  onResetWritingToolDraft: (tab?: 'dictionary' | 'replacements' | 'snippets') => void
  onBeginEditWritingTool: (tool: DictionaryEntry | ReplacementEntry | SnippetEntry) => void
  onSaveWritingTool: () => void
  onDeleteWritingTool: (tab: 'dictionary' | 'replacements' | 'snippets', id: number) => void
  orderedDomainPacks: DomainPackSummary[]
  orderedDomainDetails: DomainPackDetail[]
  domainActionState: DomainActionState
  expandedDomainId: 'shipping' | 'medical' | null
  onSetExpandedDomainId: (id: 'shipping' | 'medical' | null) => void
  canUseCurrentFrontmostApp: boolean
  liveContextPreview: SmartContext
  appDomainDefaults: AppDomainDefault[]
  onUpdateAppDomainDefault: (ruleId: string, updates: Partial<AppDomainDefault>) => void
  onUpdateAppDomainIdentity: (ruleId: string, field: 'app_name' | 'bundle_id' | 'url_host', value: string) => void
  onRemoveAppDomainDefault: (ruleId: string) => void
  onAddManualAppDomainDefault: () => void
  onUpsertCurrentFrontmostDomainDefault: () => void
  onImportDomainOverlay: (domainId: 'shipping' | 'medical') => void
  onExportDomainOverlay: (domainId: 'shipping' | 'medical') => void
  onSaveDomainEditor: (domainId: 'shipping' | 'medical') => void
  onUpdateDomainDetail: (
    domainId: 'shipping' | 'medical',
    updater: (current: DomainPackDetail) => DomainPackDetail,
  ) => void
  lastSmartRun: SmartRunTelemetry | null
  hasUsageStats: boolean
  usageMetrics: Array<{ label: string; value: string; hint: string }>
  resettingUsage: boolean
  trackingLabel: string
  onResetUsageStats: () => void
  historyItems: HistoryItem[]
  historySkillOptions: Skill[]
  resettingHistory: boolean
  resolveHistorySkillSelection: (item: HistoryItem) => string
  canHistoryItemRerun: (item: HistoryItem) => boolean
  getHistoryItemRerunNotice: (item: HistoryItem) => string | null
  onClearAllHistory: () => void
  onCopyOutput: (output: string) => void
  onDeleteHistoryEntry: (id: number) => void
  onHistorySkillSelectionChange: (id: number, skillId: string) => void
  onReprocessHistoryItem: (id: number, skillId?: string) => void
  onReuseHistoryTranscript: (transcript: string) => void
  launchContext: AppLaunchContext | null
  backgroundOnly: boolean
  onSetBackgroundOnly: (checked: boolean) => void
  activeLogTab: DesktopLogKind
  liveLogs: Record<DesktopLogKind, DesktopLogSnapshot>
  onRefreshLogs: () => void
  onSelectLogTab: (kind: DesktopLogKind) => void
}

function DomainPackEditor({
  pack,
  detail,
  expanded,
  busy,
  domainActionState,
  onToggleExpanded,
  onUpdateDomainDetail,
  onSave,
  onImport,
  onExport,
}: {
  pack: DomainPackSummary
  detail: DomainPackDetail
  expanded: boolean
  busy: boolean
  domainActionState: DomainActionState
  onToggleExpanded: () => void
  onUpdateDomainDetail: (updater: (current: DomainPackDetail) => DomainPackDetail) => void
  onSave: () => void
  onImport: () => void
  onExport: () => void
}) {
  const overlay = detail.overlay
  const effective = detail.effective
  const guidance = buildDomainGuidance(pack.id)

  return (
    <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text-primary">{pack.label}</div>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{pack.description}</p>
        </div>
        <StatusBadge
          label={pack.overlay_present ? 'Overlay imported' : 'Bundled pack'}
          tone={pack.overlay_present ? 'good' : 'neutral'}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <StatusBadge label={`${pack.glossary_count} glossary`} tone="neutral" />
        <StatusBadge label={`${pack.template_count} templates`} tone="neutral" />
        <StatusBadge label={`${pack.example_count} examples`} tone="neutral" />
      </div>

      {pack.documentation_only ? (
        <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
          Medical stays limited to documentation assistance, note drafting, and formatting support. It does not add diagnosis or treatment recommendations.
        </div>
      ) : null}

      <div className="mt-4 rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
        {pack.overlay_present
          ? `A local JSON overlay is active on this Mac. Last imported ${pack.last_imported_at ? formatCapturedAt(pack.last_imported_at) : 'recently'}.`
          : 'Only the bundled local pack is active right now. Imported overlays stay on this Mac and are never uploaded.'}
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-2 text-sm text-text-primary transition-colors hover:bg-white/[0.06]"
        >
          {expanded ? 'Hide editor' : 'Edit local pack'}
        </button>
      </div>

      {expanded ? (
        <div className="mt-4 grid gap-5">
          <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            This editor saves only the local overlay for this domain. Bundled pack entries stay active until you override them here, and exports remain overlay-only.
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusBadge label={`Effective format: ${formatDomainFormat(effective.controls.default_format)}`} tone="neutral" />
              <StatusBadge label={`Effective surface: ${formatDomainSurfaceBehavior(effective.controls.default_surface_behavior)}`} tone="neutral" />
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
              <div className="text-sm font-medium text-text-primary">Vocabulary</div>
              <p className="mt-2">{guidance.vocabulary}</p>
            </div>
            <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
              <div className="text-sm font-medium text-text-primary">Templates</div>
              <p className="mt-2">{guidance.template}</p>
            </div>
            <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
              <div className="text-sm font-medium text-text-primary">Examples</div>
              <p className="mt-2">{guidance.example}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
            <div className="text-sm font-medium text-text-primary">Overlay controls</div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Default format</label>
                <select
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  value={overlay.controls.default_format ?? effective.controls.default_format}
                  onChange={(event) => onUpdateDomainDetail((current) => ({
                    ...current,
                    overlay: {
                      ...current.overlay,
                      controls: { ...current.overlay.controls, default_format: event.target.value as DomainPackDetail['effective']['controls']['default_format'] },
                    },
                  }))}
                >
                  <option value="auto">Auto</option>
                  <option value="bullets">Bullets</option>
                  <option value="paragraph">Paragraph</option>
                  <option value="table">Table</option>
                </select>
              </div>
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Surface behavior</label>
                <select
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  value={overlay.controls.default_surface_behavior ?? effective.controls.default_surface_behavior}
                  onChange={(event) => onUpdateDomainDetail((current) => ({
                    ...current,
                    overlay: {
                      ...current.overlay,
                      controls: { ...current.overlay.controls, default_surface_behavior: event.target.value as DomainPackDetail['effective']['controls']['default_surface_behavior'] },
                    },
                  }))}
                >
                  <option value="auto">Auto</option>
                  <option value="email">Email</option>
                  <option value="note">Note</option>
                  <option value="summary">Summary</option>
                </select>
              </div>
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Tone</label>
                <input
                  type="text"
                  value={overlay.controls.tone ?? effective.controls.tone}
                  onChange={(event) => onUpdateDomainDetail((current) => ({
                    ...current,
                    overlay: {
                      ...current.overlay,
                      controls: { ...current.overlay.controls, tone: event.target.value },
                    },
                  }))}
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                />
              </div>
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Audience</label>
                <input
                  type="text"
                  value={overlay.controls.audience ?? effective.controls.audience}
                  onChange={(event) => onUpdateDomainDetail((current) => ({
                    ...current,
                    overlay: {
                      ...current.overlay,
                      controls: { ...current.overlay.controls, audience: event.target.value },
                    },
                  }))}
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                />
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ToggleCard
                title="Suppress external text"
                description="Keep selected text and clipboard text out of Smart while this domain is active."
                checked={overlay.controls.suppress_external_text ?? effective.controls.suppress_external_text}
                onChange={(checked) => onUpdateDomainDetail((current) => ({
                  ...current,
                  overlay: {
                    ...current.overlay,
                    controls: { ...current.overlay.controls, suppress_external_text: checked },
                  },
                }))}
              />
              <ToggleCard
                title="Minimize captured context"
                description="Trim browser path, titles, and focused-field metadata while this domain is active."
                checked={overlay.controls.minimize_context_capture ?? effective.controls.minimize_context_capture}
                onChange={(checked) => onUpdateDomainDetail((current) => ({
                  ...current,
                  overlay: {
                    ...current.overlay,
                    controls: { ...current.overlay.controls, minimize_context_capture: checked },
                  },
                }))}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-medium text-text-primary">Overlay vocabulary</div>
              <FooterButton tone="secondary" size="compact" onClick={() => onUpdateDomainDetail((current) => ({
                ...current,
                overlay: {
                  ...current.overlay,
                  glossary: [...current.overlay.glossary, { term: '', aliases: [], kind: null, priority: 0 }],
                },
              }))}>
                Add term
              </FooterButton>
            </div>
            <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3 text-sm leading-6 text-text-secondary">
              <p>Each row saves one final term plus the aliases that should map to it only when this domain is active.</p>
              <div className="mt-2">
                {guidance.sampleTerms.join(' | ')}
              </div>
            </div>
            <div className="mt-4 grid gap-3">
              {overlay.glossary.map((entry, index) => (
                <div key={`${pack.id}-glossary-${index}`} className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                  <div className="grid gap-4 lg:grid-cols-[1fr_1fr_120px_auto]">
                    <input
                      type="text"
                      value={entry.term}
                      onChange={(event) => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          glossary: current.overlay.glossary.map((item, itemIndex) => itemIndex === index ? { ...item, term: event.target.value } : item),
                        },
                      }))}
                      placeholder="Term"
                      className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                    <input
                      type="text"
                      value={entry.aliases.join(', ')}
                      onChange={(event) => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          glossary: current.overlay.glossary.map((item, itemIndex) => itemIndex === index ? { ...item, aliases: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } : item),
                        },
                      }))}
                      placeholder="Aliases"
                      className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                    <input
                      type="number"
                      value={entry.priority}
                      onChange={(event) => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          glossary: current.overlay.glossary.map((item, itemIndex) => itemIndex === index ? { ...item, priority: Number(event.target.value || 0) } : item),
                        },
                      }))}
                      placeholder="Priority"
                      className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                    <FooterButton tone="secondary" size="compact" onClick={() => onUpdateDomainDetail((current) => ({
                      ...current,
                      overlay: {
                        ...current.overlay,
                        glossary: current.overlay.glossary.filter((_item, itemIndex) => itemIndex !== index),
                      },
                    }))}>
                      Remove
                    </FooterButton>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-medium text-text-primary">Overlay templates</div>
              <FooterButton tone="secondary" size="compact" onClick={() => onUpdateDomainDetail((current) => ({
                ...current,
                overlay: {
                  ...current.overlay,
                  templates: [...current.overlay.templates, {
                    id: `template_${globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10)}`,
                    label: '',
                    intent: current.default_intent,
                    body: '',
                    priority: 0,
                  }],
                },
              }))}>
                Add template
              </FooterButton>
            </div>
            <div className="mt-4 grid gap-3">
              {overlay.templates.map((entry, index) => (
                <div key={entry.id} className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                  <div className="grid gap-3">
                    <input
                      type="text"
                      value={entry.label}
                      onChange={(event) => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          templates: current.overlay.templates.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item),
                        },
                      }))}
                      placeholder="Label"
                      className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                    <textarea
                      value={entry.body}
                      onChange={(event) => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          templates: current.overlay.templates.map((item, itemIndex) => itemIndex === index ? { ...item, body: event.target.value } : item),
                        },
                      }))}
                      rows={4}
                      placeholder="Template guidance"
                      className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                    <div className="flex justify-end">
                      <FooterButton tone="secondary" size="compact" onClick={() => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          templates: current.overlay.templates.filter((_item, itemIndex) => itemIndex !== index),
                        },
                      }))}>
                        Remove
                      </FooterButton>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-medium text-text-primary">Overlay examples</div>
              <FooterButton tone="secondary" size="compact" onClick={() => onUpdateDomainDetail((current) => ({
                ...current,
                overlay: {
                  ...current.overlay,
                  examples: [...current.overlay.examples, {
                    id: `example_${globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10)}`,
                    label: '',
                    intent: current.default_intent,
                    output: '',
                    priority: 0,
                  }],
                },
              }))}>
                Add example
              </FooterButton>
            </div>
            <div className="mt-4 grid gap-3">
              {overlay.examples.map((entry, index) => (
                <div key={entry.id} className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                  <div className="grid gap-3">
                    <input
                      type="text"
                      value={entry.label}
                      onChange={(event) => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          examples: current.overlay.examples.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item),
                        },
                      }))}
                      placeholder="Label"
                      className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                    <textarea
                      value={entry.output}
                      onChange={(event) => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          examples: current.overlay.examples.map((item, itemIndex) => itemIndex === index ? { ...item, output: event.target.value } : item),
                        },
                      }))}
                      rows={4}
                      placeholder="Reference example"
                      className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                    <div className="flex justify-end">
                      <FooterButton tone="secondary" size="compact" onClick={() => onUpdateDomainDetail((current) => ({
                        ...current,
                        overlay: {
                          ...current.overlay,
                          examples: current.overlay.examples.filter((_item, itemIndex) => itemIndex !== index),
                        },
                      }))}>
                        Remove
                      </FooterButton>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {expanded ? (
          <FooterButton onClick={onSave} disabled={domainActionState.type !== 'idle'}>
            {busy && domainActionState.type === 'saving' ? 'Saving…' : 'Save local changes'}
          </FooterButton>
        ) : null}
        <FooterButton onClick={onImport} disabled={domainActionState.type !== 'idle'}>
          {busy && domainActionState.type === 'importing' ? 'Importing…' : 'Import overlay'}
        </FooterButton>
        <FooterButton tone="secondary" onClick={onExport} disabled={domainActionState.type !== 'idle'}>
          {busy && domainActionState.type === 'exporting' ? 'Exporting…' : 'Export overlay'}
        </FooterButton>
        <div className="min-w-full text-xs leading-5 text-text-muted">
          Edit inline for everyday vocabulary and writing changes. Import or export JSON when you want to move a local overlay between Macs or keep it under version control.
        </div>
      </div>
    </div>
  )
}

function RecentSmartRunSection({
  developerMode,
  lastSmartRun,
}: {
  developerMode: boolean
  lastSmartRun: SmartRunTelemetry | null
}) {
  return (
    <SectionCard
      title={developerMode ? 'Recent Smart Run' : 'Smart status'}
      icon={<ShieldIcon size={18} />}
      description={developerMode ? 'See the last route, context source, and timing.' : 'A concise summary of the last Smart route and whether it stayed local or called a model.'}
      action={
        <StatusBadge
          label={lastSmartRun ? (lastSmartRun.external_request_made ? 'Model request used' : 'Local-only route') : 'No Smart run yet'}
          tone={lastSmartRun ? (lastSmartRun.external_request_made ? 'good' : 'neutral') : 'neutral'}
        />
      }
      collapsible
      defaultOpen={false}
    >
      {lastSmartRun ? (
        developerMode ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                label={`Skill router: ${lastSmartRun.skill_router_resolver === 'model' ? 'Model-assisted' : lastSmartRun.skill_router_resolver === 'local' ? 'Local rules' : 'Not used'}`}
                tone={lastSmartRun.skill_router_resolver === 'model' ? 'good' : 'neutral'}
              />
              <StatusBadge label={`Smart router: ${formatPlannerResolverLabel(lastSmartRun)}`} tone={lastSmartRun.planner_resolver === 'model' ? 'good' : 'neutral'} />
              <StatusBadge label={`Action: ${formatActionRoute(lastSmartRun.action_route)}`} tone="neutral" />
              <StatusBadge label={`Action routing: ${lastSmartRun.action_resolver === 'groq' ? 'Groq note router' : lastSmartRun.action_resolver === 'local' ? 'Local rules' : 'None'}`} tone={lastSmartRun.action_resolver === 'groq' ? 'good' : 'neutral'} />
              <StatusBadge label={`Intent: ${formatTargetType(lastSmartRun.intent)}`} tone="neutral" />
              <StatusBadge label={`Domain: ${formatDomainLabel(lastSmartRun.domain_id)}`} tone={lastSmartRun.domain_id ? 'good' : 'neutral'} />
              {lastSmartRun.domain_intent ? (
                <StatusBadge label={`Domain intent: ${formatTargetType(lastSmartRun.domain_intent)}`} tone="neutral" />
              ) : null}
              <StatusBadge label={`Lane: ${lastSmartRun.lane}`} tone="neutral" />
              <StatusBadge label={`Confidence: ${formatPercent(lastSmartRun.confidence)}`} tone={lastSmartRun.confidence >= 0.8 ? 'good' : 'warn'} />
              <StatusBadge label={`Ambiguity: ${formatPercent(lastSmartRun.ambiguity)}`} tone={lastSmartRun.ambiguity >= 0.4 ? 'warn' : 'neutral'} />
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <InspectorField label="Requested template" value={`${lastSmartRun.requested_skill.name} (${lastSmartRun.requested_skill.id})`} />
              <InspectorField label="Template used" value={`${lastSmartRun.skill_used.name} (${lastSmartRun.skill_used.id})`} />
              <InspectorField label="Smart profile" value="Selected model" />
              <InspectorField
                label="Auto-selected template"
                value={lastSmartRun.auto_selected_skill_id
                  ? `${lastSmartRun.auto_selected_skill_name || 'Unnamed template'} (${lastSmartRun.auto_selected_skill_id})`
                  : 'No auto-selected template applied'}
              />
              <InspectorField label="Requested source" value={formatSkillSource(lastSmartRun.requested_skill_source)} />
              <InspectorField
                label="Domain-forced template"
                value={lastSmartRun.domain_skill_id ? lastSmartRun.domain_skill_id : 'No domain-forced template applied'}
              />
              <InspectorField label="Matched routing rule" value={lastSmartRun.requested_app_override_id ? `${lastSmartRun.requested_app_override_label || 'Unnamed rule'} (${lastSmartRun.requested_app_override_id})` : 'No routing rule used'} />
              <InspectorField
                label="Bypassed app/site route"
                value={lastSmartRun.suppressed_requested_skill_source
                  ? `${formatSkillSource(lastSmartRun.suppressed_requested_skill_source)}${lastSmartRun.suppressed_requested_app_override_id ? ` • ${lastSmartRun.suppressed_requested_app_override_label || 'Unnamed rule'} (${lastSmartRun.suppressed_requested_app_override_id})` : ''}`
                  : 'No app or site route was bypassed'}
              />
              <InspectorField
                label="Detected domain"
                value={lastSmartRun.domain_id
                  ? `${formatDomainLabel(lastSmartRun.domain_id)} • ${formatDomainSource(lastSmartRun.domain_source)}`
                  : 'No domain pack used'}
              />
              <InspectorField label="Surface kind" value={lastSmartRun.surface_kind || 'No focused-field hint captured'} />
              <InspectorField
                label="Notes capture"
                value={lastSmartRun.note_routing_suppressed
                  ? 'Suppressed because a domain pack was active'
                  : lastSmartRun.domain_id
                    ? 'Domain pack active, but no note phrase was suppressed'
                    : 'Standard Notes routing rules'}
              />
              <InspectorField
                label="Domain rule"
                value={lastSmartRun.domain_rule_id
                  ? `${lastSmartRun.domain_rule_label || 'Unnamed rule'} (${lastSmartRun.domain_rule_id})`
                  : 'No domain rule used'}
              />
              <InspectorField
                label="Domain retrieval"
                value={lastSmartRun.domain_id
                  ? [
                    lastSmartRun.domain_intent ? `Intent ${formatTargetType(lastSmartRun.domain_intent)}` : null,
                    lastSmartRun.domain_template_id ? `Template ${lastSmartRun.domain_template_id}` : null,
                    lastSmartRun.domain_example_id ? `Example ${lastSmartRun.domain_example_id}` : null,
                    lastSmartRun.domain_glossary_hits.length ? `Glossary ${lastSmartRun.domain_glossary_hits.length} hit(s)` : null,
                  ].filter(Boolean).join(' • ') || 'Domain active with no extra retrieval context'
                  : 'No domain retrieval used'}
              />
              <InspectorField
                label="Skill router"
                value={lastSmartRun.skill_router_resolver === 'model'
                  ? `${lastSmartRun.skill_router_provider || 'Unknown'} • ${lastSmartRun.skill_router_model || 'Unknown'}`
                  : lastSmartRun.skill_router_model_attempted
                    ? `Local fallback after ${lastSmartRun.skill_router_model_error || 'router failure'}`
                    : lastSmartRun.skill_router_resolver === 'local'
                      ? 'Local rules only'
                      : 'Not used'}
              />
              <InspectorField
                label="Smart router"
                value={lastSmartRun.planner_resolver === 'model'
                  ? formatPlannerResolverLabel(lastSmartRun)
                  : lastSmartRun.planner_model_attempted
                    ? `Local fallback after ${lastSmartRun.planner_model_error || 'router failure'}`
                    : 'Local rules only'}
              />
              <InspectorField label="Transform model" value={lastSmartRun.external_request_made ? `${lastSmartRun.provider || 'Unknown'} • ${lastSmartRun.model || 'Unknown'}` : 'No external model call'} />
              <InspectorField label="Action route" value={`${formatActionRoute(lastSmartRun.action_route)} • ${lastSmartRun.action_resolver === 'groq' ? 'resolved by Groq note router' : lastSmartRun.action_resolver === 'local' ? 'resolved locally' : 'no action router used'}`} />
              <InspectorField label="External source" value={formatExternalContextSource(lastSmartRun.external_context_source)} />
              <InspectorField label="Context fields sent" value={lastSmartRun.context_fields_sent.length ? lastSmartRun.context_fields_sent.join(', ') : 'None sent outside the local device'} />
              <InspectorField label="Command layer" value={lastSmartRun.command_operations_applied.length ? lastSmartRun.command_operations_applied.join(', ') : 'No local command operations'} />
              <InspectorField label="Format contract" value={lastSmartRun.format_contract || 'No explicit format contract'} />
              <InspectorField label="Surface contract" value={lastSmartRun.surface_contract_applied ? 'Applied to fit the active field' : 'No extra surface cleanup needed'} />
              <InspectorField label="Selection context" value={lastSmartRun.selection_available ? `${lastSmartRun.selection_used ? 'Used' : 'Available but not used'} • ${lastSmartRun.selection_chars} chars${lastSmartRun.selection_truncated ? ' • truncated before upload' : ''}` : 'No selected text was captured'} />
              <InspectorField label="Clipboard context" value={lastSmartRun.clipboard_available ? `${lastSmartRun.clipboard_used ? 'Used' : 'Available but not used'} • ${lastSmartRun.clipboard_chars} chars${lastSmartRun.clipboard_truncated ? ' • truncated before upload' : ''}` : 'No clipboard text was available'} />
              <InspectorField label="Transcript / output size" value={`${lastSmartRun.transcript_chars} chars in • ${lastSmartRun.output_chars} chars out`} />
              <InspectorField label="Payload estimate" value={lastSmartRun.external_request_made ? `${lastSmartRun.payload_estimated_bytes} bytes` : '0 bytes (local-only route)'} />
              <InspectorField label="Structured output" value={lastSmartRun.structured_output_mode === 'json_schema' ? `${lastSmartRun.structured_output_schema || 'json_schema'}${lastSmartRun.structured_output_failure_kind !== 'none' ? ` • ${lastSmartRun.structured_output_failure_kind}` : ''}` : 'Not used'} />
              <InspectorField label="Latencies" value={`Total ${formatDuration(lastSmartRun.total_latency_ms)} • STT ${formatDuration(lastSmartRun.stt_latency_ms)} • Planner ${formatDuration(lastSmartRun.planner_latency_ms)} • LLM ${formatDuration(lastSmartRun.llm_latency_ms)}`} />
              <InspectorField label="Deterministic ops" value={lastSmartRun.deterministic_operations.length ? lastSmartRun.deterministic_operations.join(', ') : 'None'} />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-7 text-text-secondary">
                <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Routing reason</div>
                <p className="mt-3">{lastSmartRun.reason}</p>
                {lastSmartRun.profile_limit_reason ? (
                  <p className="mt-2 text-text-secondary">
                    Profile limit: {lastSmartRun.profile_limit_reason}
                  </p>
                ) : null}
                {lastSmartRun.auto_selected_skill_reason ? (
                  <p className="mt-3 border-t border-white/8 pt-3">
                    Skill selection: {lastSmartRun.auto_selected_skill_reason}
                  </p>
                ) : null}
              </div>
              <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-7 text-text-secondary">
                <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Fallback and browser enrichment</div>
                <p className="mt-3">
                  {lastSmartRun.fallback_applied
                    ? `Fallback applied. ${lastSmartRun.fallback_reason || 'A template contract mismatch triggered a safer path.'}`
                    : 'No template fallback was needed.'}
                </p>
                <p className="mt-2">
                  Browser enrichment {lastSmartRun.browser_enrichment_used ? 'was used' : 'was not used'}.
                </p>
                <p className="mt-2">
                  {lastSmartRun.domain_id
                    ? `Domain retrieval ${lastSmartRun.domain_template_id || lastSmartRun.domain_example_id || lastSmartRun.domain_glossary_hits.length ? 'was used' : 'matched without extra pack retrieval'} for ${formatDomainLabel(lastSmartRun.domain_id)}.`
                    : 'No domain pack was active for this run.'}
                </p>
              </div>
            </div>
          </>
        ) : (
          <div className="grid gap-4">
            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-6 text-text-secondary">
              <div className="text-sm font-medium text-text-primary">Latest Smart summary</div>
              <p className="mt-2">
                {lastSmartRun.reason}
              </p>
              <p className="mt-2">
                {lastSmartRun.external_request_made
                  ? `Used ${lastSmartRun.provider || 'the selected provider'} with ${lastSmartRun.model || 'the selected model'}.`
                  : 'Resolved through the local Smart path without an external model request.'}
              </p>
              <p className="mt-2">
                Route: {formatActionRoute(lastSmartRun.action_route)}. Intent: {formatTargetType(lastSmartRun.intent)}.
              </p>
            </div>
            <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
              Turn on Developer mode above if you need the full route, model, payload, and timing inspector for debugging.
            </div>
          </div>
        )
      ) : (
        <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
          Run Smart once to populate this view.
        </div>
      )}
    </SectionCard>
  )
}

export function AdvancedSection({
  draftConfig,
  developerMode,
  semanticMemoryInstallState,
  showSemanticMemoryLogs,
  memories,
  memoryBusy,
  memoryError,
  onSetDraftConfig,
  onToggleShowSemanticMemoryLogs,
  onSetMemoryEnabled,
  onDeleteMemory,
  onRebuildMemories,
  onClearAllMemories,
  writingTools,
  activeWritingTab,
  writingToolDraft,
  editingWritingToolId,
  writingToolBusy,
  onSetActiveWritingTab,
  onSetWritingToolDraft,
  onResetWritingToolDraft,
  onBeginEditWritingTool,
  onSaveWritingTool,
  onDeleteWritingTool,
  orderedDomainPacks,
  orderedDomainDetails,
  domainActionState,
  expandedDomainId,
  onSetExpandedDomainId,
  canUseCurrentFrontmostApp,
  liveContextPreview,
  appDomainDefaults,
  onUpdateAppDomainDefault,
  onUpdateAppDomainIdentity,
  onRemoveAppDomainDefault,
  onAddManualAppDomainDefault,
  onUpsertCurrentFrontmostDomainDefault,
  onImportDomainOverlay,
  onExportDomainOverlay,
  onSaveDomainEditor,
  onUpdateDomainDetail,
  lastSmartRun,
  hasUsageStats,
  usageMetrics,
  resettingUsage,
  trackingLabel,
  onResetUsageStats,
  historyItems,
  historySkillOptions,
  resettingHistory,
  resolveHistorySkillSelection,
  canHistoryItemRerun,
  getHistoryItemRerunNotice,
  onClearAllHistory,
  onCopyOutput,
  onDeleteHistoryEntry,
  onHistorySkillSelectionChange,
  onReprocessHistoryItem,
  onReuseHistoryTranscript,
  launchContext,
  backgroundOnly,
  onSetBackgroundOnly,
  activeLogTab,
  liveLogs,
  onRefreshLogs,
  onSelectLogTab,
}: AdvancedSectionProps) {
  const localTaskShell = draftConfig.actions.local_task_shell ?? {
    enabled: true,
    safety_mode: 'strict' as const,
    allowed_directories: [],
  }
  const semanticMemoryUi = describeSemanticMemoryUi(
    draftConfig.memory.semantic_retrieval_enabled,
    semanticMemoryInstallState,
  )
  const activeWritingItems = activeWritingTab === 'dictionary'
    ? writingTools.dictionary
    : activeWritingTab === 'replacements'
      ? writingTools.replacements
      : writingTools.snippets

  return (
    <>
      <SectionCard
        title="Power tools"
        icon={<SetupIcon size={18} />}
        description="Reveal low-level diagnostics, raw editors, and runtime internals intended for support and power-user troubleshooting."
        action={<StatusBadge label={developerMode ? 'Developer mode on' : 'Developer mode off'} tone={developerMode ? 'warn' : 'neutral'} />}
      >
        <div className="grid gap-5">
          <ToggleCard
            title="Developer mode"
            description="Keep this off for the normal product view. Turn it on only when you need raw diagnostics, install logs, or low-level template controls."
            checked={developerMode}
            onChange={(checked) => onSetDraftConfig({
              ...draftConfig,
              debug: {
                ...draftConfig.debug,
                developer_mode: checked,
              },
            })}
          />
          <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            {developerMode
              ? 'Developer mode is enabled. Advanced diagnostics, raw fallback controls, and runtime internals are visible in this app session.'
              : `Developer mode is off. ${DISPLAY_NAME} keeps diagnostics summarized and hides raw controls until you explicitly need them.`}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Desktop actions"
        icon={<SetupIcon size={18} />}
        description="Advanced controls for reviewed actions and low-risk UI automation inside Smart."
        action={
          <StatusBadge
            label={
              draftConfig.actions.enabled
                ? [
                  draftConfig.actions.auto_approve_reviewed ? 'auto-approve on' : 'manual review',
                  draftConfig.actions.experimental_media_controls ? 'experimental media on' : 'experimental media off',
                ].join(' · ')
                : 'Disabled'
            }
            tone={
              !draftConfig.actions.enabled
                ? 'warn'
                : draftConfig.actions.auto_approve_reviewed
                  ? 'danger'
                  : 'good'
            }
          />
        }
      >
        <div className="grid gap-5">
          <ToggleCard
            title="Enable desktop actions"
            description="Allow Smart to run reviewed desktop actions and low-risk local UI automation when the transcript is explicit."
            checked={draftConfig.actions.enabled}
            onChange={(checked) => onSetDraftConfig({
              ...draftConfig,
              actions: {
                ...draftConfig.actions,
                enabled: checked,
                auto_approve_reviewed: checked ? draftConfig.actions.auto_approve_reviewed : false,
              },
            })}
          />

          <ToggleCard
            title="Auto-approve reviewed actions"
            description="Skip the approval card and immediately run reviewed actions like app open, URL navigation, and Mail draft."
            checked={draftConfig.actions.enabled && draftConfig.actions.auto_approve_reviewed}
            disabled={!draftConfig.actions.enabled}
            onChange={(checked) => onSetDraftConfig({
              ...draftConfig,
              actions: {
                ...draftConfig.actions,
                auto_approve_reviewed: checked,
              },
            })}
          />

          <ToggleCard
            title="Experimental media controls"
            description="Beta global media controls for play/pause and track navigation. Volume, brightness, browser navigation, and app-aware pause stay available outside this gate."
            checked={draftConfig.actions.experimental_media_controls}
            disabled={!draftConfig.actions.enabled}
            onChange={(checked) => onSetDraftConfig({
              ...draftConfig,
              actions: {
                ...draftConfig.actions,
                experimental_media_controls: checked,
              },
            })}
          />

          <div className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${
            draftConfig.actions.enabled && draftConfig.actions.auto_approve_reviewed
              ? 'border-semantic-error/20 bg-semantic-error/10 text-text-secondary'
              : 'border-semantic-warning/20 bg-semantic-warning/8 text-text-secondary'
          }`}>
            {draftConfig.actions.enabled && draftConfig.actions.auto_approve_reviewed
              ? 'Auto-approve is risky. Reviewed actions will execute immediately without showing the widget review card. Keep this off unless you fully trust your voice commands and local action routing.'
              : 'Disabling desktop actions blocks both reviewed actions and low-risk UI automation. Explicit action requests will return a controlled Smart error instead of running.'}
          </div>

          <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            {draftConfig.actions.experimental_media_controls
              ? 'Experimental media controls are enabled. Global play/pause and track navigation use the beta system transport path, while pause still prefers app-aware handling first.'
              : 'Experimental media controls are off. Global play/pause and track navigation are blocked, but app-aware pause, volume, brightness, browser navigation, and reviewed actions still work normally.'}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Local task shell"
        icon={<SparkIcon size={18} />}
        description="Native reviewed command execution for local tasks. This lane stays local-only and blocks network-capable shell paths."
        action={
          <StatusBadge
            label={localTaskShell.enabled ? `Enabled · ${(localTaskShell.safety_mode || 'strict').replace('_', ' ')}` : 'Disabled'}
            tone={localTaskShell.enabled ? 'good' : 'warn'}
          />
        }
      >
        <div className="grid gap-5">
          <ToggleCard
            title="Enable local task shell"
            description={`Allow ${DISPLAY_NAME} to run reviewed local tasks such as repo-local search, diff, and test commands after approval.`}
            checked={localTaskShell.enabled}
            onChange={(checked) => onSetDraftConfig({
              ...draftConfig,
              actions: {
                ...draftConfig.actions,
                local_task_shell: {
                  ...localTaskShell,
                  enabled: checked,
                },
              },
            })}
          />

          <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-text-muted">Safety mode</div>
            <div className="mt-2">
              Strict local-only mode is always on in V1. Network tools, remote git operations, package installs, shell chaining, and working directories outside approved roots stay blocked.
            </div>
          </div>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-text-primary">Allowed directories</span>
            <textarea
              value={(localTaskShell.allowed_directories || []).join('\n')}
              onChange={(event) => onSetDraftConfig({
                ...draftConfig,
                actions: {
                  ...draftConfig.actions,
                  local_task_shell: {
                    ...localTaskShell,
                    allowed_directories: event.target.value
                      .split('\n')
                      .map((value) => value.trim())
                      .filter(Boolean),
                  },
                },
              })}
              rows={4}
              className="min-h-[112px] rounded-2xl border border-white/10 bg-black/25 px-3 py-3 text-sm leading-6 text-text-primary outline-none transition-colors focus:border-white/20"
              placeholder="/Users/you/Work/project-one&#10;/Users/you/Work/project-two"
            />
            <p className="text-sm leading-6 text-text-secondary">
              One absolute path per line. {DISPLAY_NAME} always allows the current workspace root and app-home storage; use this list to add extra local roots explicitly.
            </p>
          </label>
        </div>
      </SectionCard>

      <SectionCard
        title="Memory"
        icon={<SparkIcon size={18} />}
        description="Local long-term memory for recurring preferences and facts that only Smart uses when they are relevant."
        action={
          <StatusBadge
            label={draftConfig.memory.enabled ? (draftConfig.memory.semantic_retrieval_enabled ? 'Enabled · semantic on' : 'Enabled · semantic off') : 'Disabled'}
            tone={draftConfig.memory.enabled ? 'good' : 'warn'}
          />
        }
        collapsible
        defaultOpen={false}
      >
        <div className="grid gap-5">
          <ToggleCard
            title="Enable local memory"
            description="Let Smart use bounded local memory context for stable preferences and recurring facts. Dictate and desktop actions are unchanged."
            checked={draftConfig.memory.enabled}
            onChange={(checked) => onSetDraftConfig({
              ...draftConfig,
              memory: {
                ...draftConfig.memory,
                enabled: checked,
              },
            })}
          />

          <ToggleCard
            title="Auto-learn from Library"
            description="Learn only from saved local Library items. No live transcript, clipboard, or screen-context learning is used."
            checked={draftConfig.memory.auto_learn_from_history}
            onChange={(checked) => onSetDraftConfig({
              ...draftConfig,
              memory: {
                ...draftConfig.memory,
                auto_learn_from_history: checked,
              },
            })}
          />

          <ToggleCard
            title="Semantic retrieval"
            description={`Improve paraphrase matching with an optional local semantic runtime. If it is not installed, ${DISPLAY_NAME} falls back to the lighter lexical memory path automatically.`}
            checked={draftConfig.memory.semantic_retrieval_enabled}
            disabled={!draftConfig.memory.enabled}
            onChange={(checked) => onSetDraftConfig({
              ...draftConfig,
              memory: {
                ...draftConfig.memory,
                semantic_retrieval_enabled: checked,
              },
            })}
          />

          <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text-primary">Semantic retrieval status</div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">
                  {semanticMemoryUi.detail}
                </p>
              </div>
              <StatusBadge label={semanticMemoryUi.label} tone={semanticMemoryUi.tone} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <ContextField label="Current mode" value={draftConfig.memory.semantic_retrieval_enabled ? 'Semantic when ready' : 'Lexical only'} />
              <ContextField label="Runtime" value={semanticMemoryInstallState.installed ? (semanticMemoryInstallState.runtime_source === 'managed' ? 'Managed runtime' : semanticMemoryInstallState.runtime_source === 'development' ? 'Development runtime' : 'System runtime') : 'Not installed'} />
              <ContextField label="Installer" value={formatSemanticMemoryInstallerLabel(semanticMemoryInstallState)} />
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <ContextField label="SQLite" value={semanticMemoryInstallState.sqlite_module === 'unknown' ? 'Waiting' : `${semanticMemoryInstallState.sqlite_module} ${semanticMemoryInstallState.sqlite_version ?? ''}`.trim()} />
              <ContextField label="sqlite-vec" value={semanticMemoryInstallState.vec_version ?? 'Waiting'} />
              <ContextField label="Error code" value={semanticMemoryInstallState.error_code ?? 'None'} />
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              {draftConfig.memory.semantic_retrieval_enabled && semanticMemoryInstallState.can_install ? (
                <FooterButton
                  onClick={() => void (
                    semanticMemoryInstallState.phase === 'repair_needed' || semanticMemoryInstallState.phase === 'error'
                      ? window.windowControls?.repairSemanticMemoryRuntime?.()
                      : window.windowControls?.installSemanticMemoryRuntime?.()
                  )}
                >
                  {semanticMemoryInstallState.phase === 'repair_needed' || semanticMemoryInstallState.phase === 'error'
                    ? 'Repair semantic runtime'
                    : 'Install semantic retrieval'}
                </FooterButton>
              ) : null}
              <FooterButton tone="secondary" onClick={() => void window.windowControls?.checkSemanticMemoryInstallation?.()}>
                Refresh semantic status
              </FooterButton>
              <FooterButton tone="secondary" onClick={() => void window.windowControls?.writeClipboardText?.(buildSemanticMemoryDiagnostics(semanticMemoryInstallState))}>
                Copy diagnostics
              </FooterButton>
              <FooterButton tone="secondary" onClick={() => void window.windowControls?.writeClipboardText?.(semanticMemoryInstallState.logs.join('\n') || 'No semantic runtime logs recorded yet.')}>
                Copy logs
              </FooterButton>
              <FooterButton tone="secondary" onClick={() => void window.windowControls?.revealSemanticMemoryRuntime?.()}>
                Reveal semantic runtime
              </FooterButton>
            </div>

            {(semanticMemoryInstallState.phase === 'checking' || semanticMemoryInstallState.phase === 'provisioning_runtime' || semanticMemoryInstallState.phase === 'installing' || semanticMemoryInstallState.phase === 'preparing_model') && draftConfig.memory.semantic_retrieval_enabled ? (
              <div className="mt-5 rounded-2xl border border-white/6 bg-black/20 p-4">
                <BrandedProgressLoader
                  compact
                  title={semanticMemoryInstallState.label}
                  subtitle={semanticMemoryInstallState.detail}
                  progress={semanticMemoryInstallState.progress}
                />
              </div>
            ) : null}

            {developerMode && (semanticMemoryInstallState.logs.length > 0 || semanticMemoryInstallState.phase === 'error') ? (
              <div className="mt-4">
                <FooterButton tone="secondary" size="compact" onClick={onToggleShowSemanticMemoryLogs}>
                  {showSemanticMemoryLogs ? 'Hide semantic logs' : 'Show semantic logs'}
                </FooterButton>
                {showSemanticMemoryLogs ? (
                  <div className="mt-3 rounded-2xl border border-white/6 bg-black/35 p-4">
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-text-secondary">
                      {semanticMemoryInstallState.logs.join('\n') || 'No semantic install logs yet.'}
                    </pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <FooterButton tone="secondary" onClick={onRebuildMemories} disabled={memoryBusy !== null}>
              {memoryBusy === 'rebuild' ? 'Rebuilding…' : 'Rebuild From Library'}
            </FooterButton>
            <FooterButton tone="secondary" onClick={onClearAllMemories} disabled={memoryBusy !== null || memories.length === 0}>
              {memoryBusy === 'clear' ? 'Clearing…' : 'Clear All'}
            </FooterButton>
            <StatusBadge label={`${memories.length} learned`} tone={memories.length ? 'good' : 'neutral'} />
          </div>

          {memoryError ? (
            <div className="rounded-2xl border border-semantic-error/20 bg-semantic-error/10 px-4 py-3 text-sm leading-6 text-text-secondary">
              {memoryError}
            </div>
          ) : null}

          {memories.length ? (
            <div className="grid gap-3">
              {memories.map((memory) => (
                <div key={memory.id} className="rounded-2xl border border-white/6 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-text-primary">{memory.summary}</div>
                      <div className="mt-2 text-xs uppercase tracking-[0.22em] text-text-muted">
                        {memory.kind.replace(/_/g, ' ')} · {memory.evidence_count} evidence {memory.evidence_count === 1 ? 'item' : 'items'}
                      </div>
                      <p className="mt-3 text-sm leading-6 text-text-secondary">
                        {memory.app_name ? `App: ${memory.app_name}. ` : ''}
                        {memory.url_host ? `Site: ${memory.url_host}. ` : ''}
                        {memory.domain_id ? `Domain: ${memory.domain_id}. ` : ''}
                        Updated {new Date(memory.updated_at).toLocaleString()}.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <InlineSwitch
                        checked={memory.enabled}
                        onChange={(checked) => onSetMemoryEnabled(memory.id, checked)}
                      />
                      <FooterButton tone="secondary" size="compact" onClick={() => onDeleteMemory(memory.id)} disabled={memoryBusy !== null}>
                        Remove
                      </FooterButton>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
              No learned memories yet. Keep auto-learn on and use Smart for a while, or rebuild from your saved Library to seed local memory now.
            </div>
          )}

          <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            Local memory is bounded and Smart-only. It learns from saved local Library items, including notes and runs, and it never changes Dictate output, desktop action planning, provider selection, or domain resolution.
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Writing tools"
        icon={<SetupIcon size={18} />}
        description="Local vocabulary, replacements, and snippets that run after transcription and before Smart routing."
        action={<StatusBadge label="Local only" tone="neutral" />}
        collapsible
        defaultOpen={false}
      >
        <div className="grid gap-5">
          <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            Global vocabulary applies everywhere after transcription. Domain glossaries add extra aliases, templates, and examples only when that domain is active.
          </div>

          <div className="flex flex-wrap gap-2">
            {([
              ['dictionary', 'Dictionary'],
              ['replacements', 'Replacements'],
              ['snippets', 'Snippets'],
            ] as const).map(([id, label]) => {
              const active = activeWritingTab === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onSetActiveWritingTab(id)
                    onResetWritingToolDraft(id)
                  }}
                  className={`rounded-2xl border px-4 py-2 text-sm transition-colors ${active
                    ? 'border-white/14 bg-white/[0.08] text-text-primary'
                    : 'border-white/6 bg-white/[0.02] text-text-secondary hover:border-white/12 hover:bg-white/[0.04] hover:text-text-primary'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
              <div className="text-sm font-medium text-text-primary">Dictionary</div>
              <p className="mt-2 text-sm leading-6 text-text-secondary">
                Use this for names, acronyms, pronunciations, and common speech-recognition misses. Save the final output once, then list the spoken aliases that should map to it.
              </p>
            </div>
            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
              <div className="text-sm font-medium text-text-primary">Replacements</div>
              <p className="mt-2 text-sm leading-6 text-text-secondary">
                Use replacements when you want a deterministic phrase rewrite like `pls advise` to `Please advise.` They are not pronunciation tools.
              </p>
            </div>
            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
              <div className="text-sm font-medium text-text-primary">Snippets</div>
              <p className="mt-2 text-sm leading-6 text-text-secondary">
                Use snippets when a short trigger should expand into a longer template or checklist.
              </p>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="grid gap-3">
              {activeWritingItems.length ? (
                activeWritingItems.map((item) => (
                  <div key={item.id} className="rounded-2xl border border-white/6 bg-black/20 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-text-primary">
                          {'canonical_text' in item ? item.canonical_text : 'source_text' in item ? item.source_text : item.trigger}
                        </div>
                        <div className="mt-2 text-sm leading-6 text-text-secondary">
                          {'canonical_text' in item
                            ? (item.aliases.length
                              ? `Spoken as ${formatAliases(item.aliases)}`
                              : 'Matches the canonical term directly for casing and consistent output.')
                            : 'replacement_text' in item
                              ? `${item.match_type} → ${item.replacement_text}`
                              : `${item.match_type} → ${item.expansion}`}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <FooterButton tone="secondary" size="compact" onClick={() => onBeginEditWritingTool(item)}>
                          Edit
                        </FooterButton>
                        <FooterButton
                          tone="secondary"
                          size="compact"
                          onClick={() => onDeleteWritingTool(activeWritingTab, item.id)}
                          disabled={writingToolBusy === `${activeWritingTab}-${item.id}`}
                        >
                          Delete
                        </FooterButton>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                  No {activeWritingTab} yet. Add one on the right.
                </div>
              )}
            </div>

            <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
              <div className="text-sm font-medium text-text-primary">
                {editingWritingToolId ? 'Edit local writing tool' : 'Add local writing tool'}
              </div>
              <p className="mt-2 text-sm leading-6 text-text-secondary">
                {activeWritingTab === 'dictionary'
                  ? 'Save one canonical output and list the spoken aliases or common mishearings that should resolve to it.'
                  : activeWritingTab === 'replacements'
                    ? 'Refine a repeated phrase deterministically.'
                    : 'Expand an exact trigger or inline phrase into a longer snippet.'}
              </p>

              {activeWritingTab === 'dictionary' ? (
                <div className="mt-4 grid gap-3">
                  {DICTIONARY_EXAMPLES.map((example) => (
                    <div key={example.saved} className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                      Said as <span className="font-medium text-text-primary">`{example.spoken}`</span>, save as <span className="font-medium text-text-primary">`{example.saved}`</span>.
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="mt-4 grid gap-4">
                {activeWritingTab === 'dictionary' || activeWritingTab === 'replacements' ? (
                  <div>
                    <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">{activeWritingTab === 'dictionary' ? 'Canonical output' : 'Source text'}</label>
                    <input
                      type="text"
                      value={activeWritingTab === 'dictionary' ? (writingToolDraft.canonical_text || '') : (writingToolDraft.source_text || '')}
                      onChange={(event) => onSetWritingToolDraft((current) => (
                        activeWritingTab === 'dictionary'
                          ? { ...current, canonical_text: event.target.value }
                          : { ...current, source_text: event.target.value }
                      ))}
                      className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Trigger phrase</label>
                    <input
                      type="text"
                      value={writingToolDraft.trigger || ''}
                      onChange={(event) => onSetWritingToolDraft((current) => ({ ...current, trigger: event.target.value }))}
                      className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                  </div>
                )}

                {activeWritingTab === 'dictionary' ? (
                  <div>
                    <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Spoken aliases</label>
                    <textarea
                      value={writingToolDraft.aliases_text || ''}
                      onChange={(event) => onSetWritingToolDraft((current) => ({ ...current, aliases_text: event.target.value }))}
                      rows={4}
                      placeholder="sea quay well, sequel"
                      className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                    <p className="mt-2 text-xs leading-5 text-text-muted">
                      Optional comma-separated variants. Add the ways you say the term, the spelling you expect to be misheard, or both.
                    </p>
                  </div>
                ) : null}

                {activeWritingTab === 'replacements' ? (
                  <div>
                    <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Replacement text</label>
                    <textarea
                      value={writingToolDraft.replacement_text || ''}
                      onChange={(event) => onSetWritingToolDraft((current) => ({ ...current, replacement_text: event.target.value }))}
                      rows={4}
                      className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                  </div>
                ) : null}

                {activeWritingTab === 'snippets' ? (
                  <div>
                    <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Expansion</label>
                    <textarea
                      value={writingToolDraft.expansion || ''}
                      onChange={(event) => onSetWritingToolDraft((current) => ({ ...current, expansion: event.target.value }))}
                      rows={6}
                      className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                    />
                  </div>
                ) : null}

                {activeWritingTab !== 'dictionary' ? (
                  <div>
                    <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Match type</label>
                    <select
                      className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                      value={writingToolDraft.match_type || (activeWritingTab === 'snippets' ? 'exact' : 'inline')}
                      onChange={(event) => onSetWritingToolDraft((current) => ({ ...current, match_type: event.target.value as 'exact' | 'inline' }))}
                    >
                      <option value="exact">Exact match</option>
                      <option value="inline">Inline match</option>
                    </select>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <FooterButton onClick={onSaveWritingTool} disabled={Boolean(writingToolBusy)}>
                  {writingToolBusy === activeWritingTab ? 'Saving…' : editingWritingToolId ? 'Update' : 'Add'}
                </FooterButton>
                <FooterButton tone="secondary" onClick={() => onResetWritingToolDraft()}>
                  Clear
                </FooterButton>
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Domain customization"
        icon={<SparkIcon size={18} />}
        description="Edit the full Shipping and Medical pack overlays, examples, import/export files, and per-app domain rules."
        action={<StatusBadge label={`Mode: ${formatDomainMode(draftConfig.domains.mode)}`} tone={draftConfig.domains.mode === 'off' ? 'neutral' : 'good'} />}
        collapsible
        defaultOpen={false}
      >
        <div className="grid gap-5">
          <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            Use the global dictionary for terms you want everywhere. Use a domain glossary when the correction should only help inside Shipping or Medical, and when you also want domain-specific STT hints and prompt examples.
          </div>

          <div>
            <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Domain mode</label>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {(['off', 'auto', 'shipping', 'medical'] as DomainMode[]).map((mode) => {
                const active = draftConfig.domains.mode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSetDraftConfig({
                      ...draftConfig,
                      domains: {
                        ...draftConfig.domains,
                        mode,
                      },
                    })}
                    className={`rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] ${active
                      ? 'border-white/14 bg-white/[0.08] shadow-[0_10px_24px_rgba(0,0,0,0.12)]'
                      : 'border-white/6 bg-white/[0.02] hover:border-white/12 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="text-sm font-medium text-text-primary">{formatDomainMode(mode)}</div>
                    <p className="mt-3 text-sm leading-6 text-text-secondary">{describeDomainMode(mode)}</p>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {orderedDomainPacks.map((pack) => {
              const detail = orderedDomainDetails.find((item) => item.id === pack.id)
              if (!detail) return null
              const busy = domainActionState.domainId === pack.id && domainActionState.type !== 'idle'
              return (
                <DomainPackEditor
                  key={pack.id}
                  pack={pack}
                  detail={detail}
                  expanded={expandedDomainId === pack.id}
                  busy={busy}
                  domainActionState={domainActionState}
                  onToggleExpanded={() => onSetExpandedDomainId(expandedDomainId === pack.id ? null : pack.id)}
                  onUpdateDomainDetail={(updater) => onUpdateDomainDetail(pack.id, updater)}
                  onSave={() => onSaveDomainEditor(pack.id)}
                  onImport={() => onImportDomainOverlay(pack.id)}
                  onExport={() => onExportDomainOverlay(pack.id)}
                />
              )
            })}
          </div>

          {domainActionState.message ? (
            <div className="rounded-2xl border border-semantic-success/20 bg-semantic-success/8 px-4 py-3 text-sm leading-6 text-text-secondary">
              {domainActionState.message}
            </div>
          ) : null}

          {domainActionState.error ? (
            <div className="rounded-2xl border border-semantic-error/20 bg-semantic-error/10 px-4 py-3 text-sm leading-6 text-text-secondary">
              {domainActionState.error}
            </div>
          ) : null}

          <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text-primary">Per-app and site domains</div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
                  Override the global mode for specific apps or browser hosts. When a domain is active, it overrides per-app Smart routing and disables Notes capture. Host rules beat app-name rules, and imported domain data always stays local.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <FooterButton tone="secondary" onClick={onAddManualAppDomainDefault}>
                  Add manual rule
                </FooterButton>
                <FooterButton tone="secondary" onClick={onUpsertCurrentFrontmostDomainDefault} disabled={!canUseCurrentFrontmostApp}>
                  Use current frontmost target
                </FooterButton>
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <OptionalContextField label="Current app name" value={liveContextPreview.app_name} emptyLabel="Unknown" />
              <OptionalContextField label="Current bundle id" value={liveContextPreview.bundle_id} emptyLabel="Unavailable" />
              <OptionalContextField label="Current site host" value={liveContextPreview.url_host} emptyLabel="Unavailable" />
              <OptionalContextField label="Current page path" value={liveContextPreview.url_path} emptyLabel="Unavailable" />
            </div>

            <div className="mt-4 rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
              {draftConfig.domains.mode === 'off'
                ? 'Domain packs are currently off. Per-app rules can still be saved now and will activate once you switch to Auto or pin a domain.'
                : `Current mode: ${formatDomainMode(draftConfig.domains.mode)}. ${describeDomainMode(draftConfig.domains.mode)}`}
            </div>

            <div className="mt-4 grid gap-4">
              {appDomainDefaults.length ? appDomainDefaults.map((rule) => (
                <div key={rule.id} className="rounded-2xl border border-white/6 bg-black/20 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-text-primary">{rule.app_label}</div>
                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                        Matches <span className="font-medium text-text-primary">{rule.app_name}</span>
                        {rule.url_host ? ` on ${rule.url_host}` : ''}
                        {rule.bundle_id ? ` with bundle id ${rule.bundle_id}` : ''}.
                      </p>
                    </div>
                    <InlineSwitch
                      checked={rule.enabled}
                      onChange={(checked) => onUpdateAppDomainDefault(rule.id, { enabled: checked })}
                    />
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <div>
                      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">App name</label>
                      <input
                        type="text"
                        value={rule.app_name}
                        onChange={(event) => onUpdateAppDomainIdentity(rule.id, 'app_name', event.target.value)}
                        placeholder="Microsoft Word"
                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                      />
                    </div>
                    <div>
                      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Bundle id</label>
                      <input
                        type="text"
                        value={rule.bundle_id || ''}
                        onChange={(event) => onUpdateAppDomainIdentity(rule.id, 'bundle_id', event.target.value)}
                        placeholder="com.microsoft.Word"
                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                      />
                    </div>
                    <div>
                      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Site host</label>
                      <input
                        type="text"
                        value={rule.url_host || ''}
                        onChange={(event) => onUpdateAppDomainIdentity(rule.id, 'url_host', event.target.value)}
                        placeholder="app.example.com"
                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                      />
                    </div>
                    <div>
                      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Domain override</label>
                      <select
                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                        value={rule.domain_id}
                        onChange={(event) => onUpdateAppDomainDefault(rule.id, { domain_id: event.target.value as 'shipping' | 'medical' })}
                      >
                        <option value="shipping">Shipping</option>
                        <option value="medical">Medical</option>
                      </select>
                    </div>
                    <div className="lg:col-span-2 flex items-center justify-end">
                      <FooterButton tone="secondary" onClick={() => onRemoveAppDomainDefault(rule.id)}>
                        Remove
                      </FooterButton>
                    </div>
                  </div>
                </div>
              )) : (
                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                  No domain overrides yet. Add one manually or capture the current frontmost target.
                </div>
              )}
            </div>
          </div>
        </div>
      </SectionCard>

      <RecentSmartRunSection developerMode={developerMode} lastSmartRun={lastSmartRun} />

      <AdvancedUsageSection
        hasUsageStats={hasUsageStats}
        metrics={usageMetrics}
        resettingUsage={resettingUsage}
        trackingLabel={trackingLabel}
        onResetUsageStats={onResetUsageStats}
      />

      <AdvancedHistorySection
        historyItems={historyItems}
        historySkillOptions={historySkillOptions}
        resettingHistory={resettingHistory}
        resolveHistorySkillSelection={resolveHistorySkillSelection}
        writingToolBusy={writingToolBusy}
        onClearAllHistory={onClearAllHistory}
        onCopyOutput={onCopyOutput}
        onDeleteHistoryEntry={onDeleteHistoryEntry}
        onHistorySkillSelectionChange={onHistorySkillSelectionChange}
        onReprocessHistoryItem={onReprocessHistoryItem}
        onReuseHistoryTranscript={onReuseHistoryTranscript}
        canRerun={canHistoryItemRerun}
        getRerunNotice={getHistoryItemRerunNotice}
        formatCapturedAt={formatCapturedAt}
      />

      {!launchContext?.is_packaged ? (
        <AdvancedWindowBehaviorSection
          backgroundOnly={backgroundOnly}
          onSetBackgroundOnly={onSetBackgroundOnly}
        />
      ) : null}

      <AdvancedLogsSection
        activeLogTab={activeLogTab}
        liveLogs={liveLogs}
        onRefresh={onRefreshLogs}
        onSelectLogTab={onSelectLogTab}
      />
    </>
  )
}
