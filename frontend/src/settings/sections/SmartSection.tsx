import { DISPLAY_NAME } from '../../../shared/branding'
import { SparkIcon } from '../../components/BrandIcons'
import type {
  AppConfig,
  AppSkillDefault,
  DomainMode,
  KeyStatusMap,
  ProviderModel,
  Skill,
  SmartContext,
} from '../../types'
import { DOMAIN_MODES, PROVIDERS } from '../constants'
import { describeDomainMode, formatDomainMode, formatProviderModelLabel } from '../display'
import {
  FooterButton,
  InfoDisclosure,
  InlineSwitch,
  OptionalContextField,
  ProviderPicker,
  SectionCard,
  StatusBadge,
  ToggleCard,
} from '../primitives'

type SmartSectionProps = {
  draftConfig: AppConfig
  keysSet: KeyStatusMap
  displayedLlmModels: ProviderModel[]
  activeSkill: Skill | null
  skills: Skill[]
  refreshingLmStudioModels: boolean
  lmStudioRefreshMessage: string | null
  selectedLmStudioModelUndiscovered: boolean
  loadedLmStudioSmartModelCount: number
  lmStudioSmartModelCount: number
  selectedLmStudioModelAutoLoadReady: boolean
  lmStudioSmartModelMessage: string | null
  draftSmartProviderNeedsAccess: boolean
  visionModels: ProviderModel[]
  loadedVisionModelCount: number
  selectedVisionModel: string
  visionAvailabilityMessage: string | null
  appSkillDefaults: AppSkillDefault[]
  canUseCurrentFrontmostApp: boolean
  liveContextPreview: SmartContext
  onUpdateProvider: (provider: string) => void
  onRefreshLmStudioModels: () => void
  onSetDraftConfig: (config: AppConfig) => void
  onOpenAccessStep: (provider: string) => void
  onUpsertCurrentFrontmostAppDefault: () => void
  onUpdateAppSkillDefault: (ruleId: string, updates: Partial<AppSkillDefault>) => void
  onRemoveAppSkillDefault: (ruleId: string) => void
  onNavigateToStep: (step: 'advanced') => void
}

export function SmartSection({
  draftConfig,
  keysSet,
  displayedLlmModels,
  activeSkill,
  skills,
  refreshingLmStudioModels,
  lmStudioRefreshMessage,
  selectedLmStudioModelUndiscovered,
  loadedLmStudioSmartModelCount,
  lmStudioSmartModelCount,
  selectedLmStudioModelAutoLoadReady,
  lmStudioSmartModelMessage,
  draftSmartProviderNeedsAccess,
  visionModels,
  loadedVisionModelCount,
  selectedVisionModel,
  visionAvailabilityMessage,
  appSkillDefaults,
  canUseCurrentFrontmostApp,
  liveContextPreview,
  onUpdateProvider,
  onRefreshLmStudioModels,
  onSetDraftConfig,
  onOpenAccessStep,
  onUpsertCurrentFrontmostAppDefault,
  onUpdateAppSkillDefault,
  onRemoveAppSkillDefault,
  onNavigateToStep,
}: SmartSectionProps) {
  return (
    <>
      <SectionCard
        title="Core Smart setup"
        icon={<SparkIcon size={18} />}
        description={`Choose the active Smart provider, model, and default behavior that ${DISPLAY_NAME} should use after transcription.`}
      >
        <div className="grid gap-5">
          <ProviderPicker
            label="LLM provider"
            value={draftConfig.llm.provider}
            options={PROVIDERS.llm}
            availableKeys={keysSet}
            onChange={onUpdateProvider}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-3">
            <div className="text-sm leading-6 text-text-secondary">
              Restarted LM Studio or added local models? Refresh the LM Studio catalog here without restarting {DISPLAY_NAME}.
            </div>
            <FooterButton tone="secondary" onClick={onRefreshLmStudioModels} disabled={refreshingLmStudioModels}>
              {refreshingLmStudioModels ? 'Refreshing…' : 'Refresh LM Studio models'}
            </FooterButton>
          </div>

          {lmStudioRefreshMessage ? (
            <div className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${
              lmStudioRefreshMessage === 'LM Studio models refreshed.'
                ? 'border-semantic-success/20 bg-semantic-success/8 text-text-secondary'
                : 'border-semantic-error/20 bg-semantic-error/10 text-text-secondary'
            }`}>
              {lmStudioRefreshMessage}
            </div>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
            <div>
              <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">LLM model</label>
              <select
                className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                value={draftConfig.llm.model}
                onChange={(event) => onSetDraftConfig({
                  ...draftConfig,
                  llm: {
                    ...draftConfig.llm,
                    model: event.target.value,
                    routing: {
                      ...draftConfig.llm.routing,
                      provider: draftConfig.llm.provider,
                      model: event.target.value,
                    },
                  },
                })}
              >
                {displayedLlmModels.map((model) => (
                  <option key={model.id} value={model.id}>{formatProviderModelLabel(model, draftConfig.llm.provider)}</option>
                ))}
              </select>
              {draftConfig.llm.provider === 'lmstudio' ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <StatusBadge
                    label={selectedLmStudioModelUndiscovered
                      ? 'LM Studio unavailable'
                      : loadedLmStudioSmartModelCount
                        ? `${loadedLmStudioSmartModelCount} loaded Smart-ready / ${lmStudioSmartModelCount} detected`
                        : selectedLmStudioModelAutoLoadReady
                          ? 'Smart-ready model selected'
                          : lmStudioSmartModelCount
                            ? `${lmStudioSmartModelCount} Smart-ready detected`
                            : 'No Smart-ready model'}
                    tone={selectedLmStudioModelUndiscovered
                      ? 'danger'
                      : loadedLmStudioSmartModelCount || selectedLmStudioModelAutoLoadReady
                        ? 'good'
                        : lmStudioSmartModelCount
                          ? 'warn'
                          : 'danger'}
                  />
                  <div className="text-xs leading-5 text-text-muted">
                    {`${DISPLAY_NAME} uses your selected local model for both Smart Mode and local vision. If LM Studio has the model downloaded but not loaded yet, ${DISPLAY_NAME} will ask LM Studio to load it automatically.`}
                  </div>
                </div>
              ) : null}
              {lmStudioSmartModelMessage ? (
                <div className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-100">
                  {lmStudioSmartModelMessage}
                </div>
              ) : null}
            </div>
            <div>
              <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Default template</label>
              <select
                className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                value={draftConfig.hotkeys.default_skill_id}
                onChange={(event) => onSetDraftConfig({
                  ...draftConfig,
                  hotkeys: { ...draftConfig.hotkeys, default_skill_id: event.target.value },
                })}
              >
                {skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>{skill.name}</option>
                ))}
              </select>
              {activeSkill?.description ? (
                <div className="mt-3 flex justify-end">
                  <InfoDisclosure label={`${activeSkill.name} details`}>
                    <p>{activeSkill.description}</p>
                  </InfoDisclosure>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-3">
            <div className="text-sm leading-6 text-text-secondary">
              API keys are managed in <span className="font-medium text-text-primary">Access</span>. Smart only controls the active provider, model, and behavior.
            </div>
            <FooterButton tone="secondary" onClick={() => onOpenAccessStep(draftConfig.llm.provider)}>
              {draftSmartProviderNeedsAccess ? 'Manage access' : 'Open Access'}
            </FooterButton>
          </div>

          <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text-primary">Local vision context</div>
                <p className="mt-1.5 max-w-2xl text-sm leading-6 text-text-secondary">
                  Smart can capture the primary display and ask a local LM Studio vision model for a short context summary. If no supported model is available, Smart keeps the normal local flow.
                </p>
              </div>
              <StatusBadge
                label={visionModels.length ? `${loadedVisionModelCount} loaded / ${visionModels.length} vision models` : 'Auto fallback only'}
                tone={loadedVisionModelCount ? 'good' : visionModels.length ? 'warn' : 'neutral'}
              />
            </div>

            <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)]">
              <ToggleCard
                title="Enable local vision capture"
                description="Capture the primary display only for Smart runs and keep the screenshot local to the LM Studio vision handoff."
                checked={draftConfig.vision.enabled}
                onChange={(checked) => onSetDraftConfig({
                  ...draftConfig,
                  vision: {
                    ...draftConfig.vision,
                    enabled: checked,
                  },
                })}
              />

              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Vision timeout</label>
                <input
                  type="number"
                  min={500}
                  max={10000}
                  step={100}
                  value={draftConfig.vision.timeout_ms}
                  onChange={(event) => onSetDraftConfig({
                    ...draftConfig,
                    vision: {
                      ...draftConfig.vision,
                      timeout_ms: Math.max(500, Math.min(10000, Number(event.target.value) || 2500)),
                    },
                  })}
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                />
              </div>
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]">
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Vision model</label>
                <select
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  value={selectedVisionModel}
                  onChange={(event) => onSetDraftConfig({
                    ...draftConfig,
                    vision: {
                      ...draftConfig.vision,
                      model: event.target.value === '__reuse__' ? null : event.target.value,
                    },
                  })}
                >
                  <option value="__reuse__">Use current Smart model when supported</option>
                  {visionModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}{model.loaded === false ? ' (not loaded)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                {draftConfig.llm.provider === 'lmstudio'
                  ? 'When your selected Smart model supports vision, Smart reuses it automatically. Otherwise the explicit vision model is used when available.'
                  : 'Vision always uses LM Studio locally. Your main Smart provider can stay remote or local.'}
              </div>
            </div>

            {visionAvailabilityMessage ? (
              <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-100">
                {visionAvailabilityMessage}
              </div>
            ) : null}
          </div>

          <div className="section-intro-panel rounded-[22px] border border-white/6 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text-primary">Notes</div>
                <p className="mt-1.5 text-sm leading-6 text-text-secondary">Only explicit note phrases save to Notes.</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge label="Explicit note phrases" tone="neutral" />
                <InfoDisclosure label="Notes routing help">
                  <p>Use phrases like “take a note of this” or “summarize this and take a note.” When Shipping or Medical is active, note-like phrasing stays in the normal Smart flow instead of saving to Notes.</p>
                </InfoDisclosure>
              </div>
            </div>
          </div>

          <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-text-primary">Per-app and site defaults</div>
                <p className="mt-1.5 text-sm leading-6 text-text-secondary">Optional template overrides for specific apps or hosts.</p>
              </div>
              <div className="flex items-center gap-2">
                <FooterButton tone="secondary" onClick={onUpsertCurrentFrontmostAppDefault} disabled={!canUseCurrentFrontmostApp}>
                  Use current target
                </FooterButton>
                <InfoDisclosure label="Override routing help">
                  <p>These overrides are optional. Active Shipping or Medical domains still take priority over normal app and site template routes.</p>
                </InfoDisclosure>
              </div>
            </div>

            <div className="mt-4 grid gap-4">
              <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Default template</div>
                    <div className="mt-2 text-sm font-medium text-text-primary">{activeSkill?.name || 'No default template selected'}</div>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      Used when no app-specific override matches.
                    </p>
                  </div>
                  <StatusBadge label={canUseCurrentFrontmostApp ? `Live app: ${liveContextPreview.app_name}` : 'No frontmost app detected'} tone={canUseCurrentFrontmostApp ? 'good' : 'warn'} />
                </div>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <OptionalContextField label="Current app name" value={liveContextPreview.app_name} emptyLabel="Unknown" />
                  <OptionalContextField label="Current bundle id" value={liveContextPreview.bundle_id} emptyLabel="Unavailable" />
                  <OptionalContextField label="Current site host" value={liveContextPreview.url_host} emptyLabel="Unavailable" />
                  <OptionalContextField label="Current page path" value={liveContextPreview.url_path} emptyLabel="Unavailable" />
                </div>
              </div>

              {appSkillDefaults.length ? appSkillDefaults.map((rule) => {
                const selectedSkillMissing = !skills.some((skill) => skill.id === rule.skill_id)
                return (
                  <div key={rule.id} className="rounded-2xl border border-white/6 bg-black/20 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-text-primary">{rule.app_label}</div>
                        <p className="mt-2 text-sm leading-6 text-text-secondary">
                          Matches <span className="font-medium text-text-primary">{rule.app_name}</span>
                          {rule.url_host ? ` on ${rule.url_host}` : ''}
                          {rule.bundle_id ? ` with bundle id ${rule.bundle_id}` : ''}
                          .
                        </p>
                      </div>
                      <InlineSwitch
                        checked={rule.enabled}
                        onChange={(checked) => onUpdateAppSkillDefault(rule.id, { enabled: checked })}
                      />
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                      <div>
                        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Template override</label>
                        <select
                          className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                          value={selectedSkillMissing ? '__missing__' : rule.skill_id}
                          onChange={(event) => {
                            if (event.target.value === '__missing__') return
                            onUpdateAppSkillDefault(rule.id, { skill_id: event.target.value })
                          }}
                        >
                          {selectedSkillMissing ? <option value="__missing__">Missing template ({rule.skill_id})</option> : null}
                          {skills.map((skill) => (
                            <option key={skill.id} value={skill.id}>{skill.name}</option>
                          ))}
                        </select>
                        {selectedSkillMissing ? (
                          <p className="mt-3 text-sm leading-6 text-semantic-warning">
                            This rule points to a missing template and will fall back to the default template.
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-end">
                        <FooterButton tone="secondary" onClick={() => onRemoveAppSkillDefault(rule.id)}>
                          Remove
                        </FooterButton>
                      </div>
                    </div>
                  </div>
                )
              }) : (
                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                  No target-specific defaults yet. Bring an app or browser tab frontmost, then add it here.
                </div>
              )}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Domain mode"
        icon={<SparkIcon size={18} />}
        description="Choose when the built-in Shipping and Medical packs should guide Smart. Detailed glossary, template, and import/export editing stays in Advanced."
        action={<StatusBadge label={`Mode: ${formatDomainMode(draftConfig.domains.mode)}`} tone={draftConfig.domains.mode === 'off' ? 'neutral' : 'good'} />}
      >
        <div className="grid gap-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {DOMAIN_MODES.map((mode) => {
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
                      mode: mode as DomainMode,
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
          <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
            Use the global dictionary for terms you want everywhere. Use a domain pack when you want Smart vocabulary, examples, and formatting rules to change only inside Shipping or Medical.
          </div>
          <div className="flex justify-end">
            <FooterButton tone="secondary" onClick={() => onNavigateToStep('advanced')}>
              Open domain customization
            </FooterButton>
          </div>
        </div>
      </SectionCard>
    </>
  )
}
