import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'

import { BACKEND_LOG_DISPLAY_PATH, DISPLAY_NAME, ELECTRON_LOG_DISPLAY_PATH } from '../shared/branding'
import { BrandedProgressLoader } from './components/BrandedProgressLoader'
import {
  ArrowRightIcon,
  CheckIcon,
  ErrorIcon,
  InfoIcon,
  KeyIcon,
  MicIcon,
  RefreshIcon,
  SetupIcon,
  ShieldIcon,
  SparkIcon,
  WarningIcon,
  WaveIcon,
} from './components/BrandIcons'
import { apiDelete, apiGet, apiPost, apiPut } from './lib/api'
import { getHistoryItemRerunNotice, isHistoryItemRerunnable } from './lib/historyRuns'
import { deriveLiveTranscriptionUiState, mapLiveTranscriptionControlValue } from './lib/liveTranscriptionSettings'
import { computeOnboardingState } from './lib/onboarding'
import { applyModelSelection, applyProviderSelection } from './lib/providerSettings'
import { selectActiveWorkState, selectOnboardingState, selectPrimaryAttentionIssue } from './lib/runtimeSelectors'
import { createLatestRequestController, responseData, retryRead, settleRecord, withSignal } from './lib/runtime'
import { refreshRuntimeLocalEnvironment, refreshRuntimeProviderModels, refreshRuntimeStatus, useRuntimeStore } from './lib/runtimeStore'
import {
  useBackendBootStateSubscription,
  useLaunchContextState,
  useMlxInstallStateSubscription,
  useSemanticMemoryInstallStateSubscription,
} from './hooks/useDesktopBridgeState'
import type {
  AppDomainDefault,
  AppSkillDefault,
  AppConfig,
  AudioDevice,
  BackendStatus,
  BackendBootState,
  DictionaryEntry,
  DomainMode,
  DomainPackDetail,
  DomainPackSummary,
  HistoryItem,
  KeyStatusMap,
  LearnedMemory,
  MlxInstallState,
  PrivacyPane,
  ProviderModel,
  ProviderModels,
  ProviderOption,
  ReplacementEntry,
  SensitiveTargetRule,
  SemanticMemoryInstallState,
  Skill,
  SnippetEntry,
  SmartContext,
  UsageStats,
  WritingToolsSnapshot,
} from './types'

type StepId = 'voice' | 'rewrite' | 'privacy' | 'advanced'
type OnboardingStepId = 'install' | 'microphone' | 'accessibility' | 'providers' | 'dictation_test' | 'complete'
type SettingsViewCache = {
  remoteConfig: AppConfig
  draftConfig: AppConfig
  providerModels: ProviderModels
  domainPacks: DomainPackSummary[]
  domainDetails: DomainPackDetail[]
  writingTools: WritingToolsSnapshot
  audioDevices: AudioDevice[]
  skills: Skill[]
  historyItems: HistoryItem[]
  memories: LearnedMemory[]
}
type SupportedLanguageOption = {
  code: string
  label: string
}
type WritingToolDraft = {
  source_text?: string
  canonical_text?: string
  aliases_text?: string
  replacement_text?: string
  trigger?: string
  expansion?: string
  match_type?: 'exact' | 'inline'
}
type DirtySectionMap = Record<StepId, boolean>
type ConfigReducerState = {
  appliedConfig: AppConfig | null
  draftConfig: AppConfig | null
  dirtySections: DirtySectionMap
}
type ConfigReducerAction =
  | { type: 'hydrate'; config: AppConfig }
  | { type: 'setDraft'; config: AppConfig }
  | { type: 'updateDraft'; updater: (current: AppConfig) => AppConfig }

let settingsViewCache: SettingsViewCache | null = null

const DEFAULT_BOOT_STATE: BackendBootState = {
  phase: 'booting_backend',
  label: `Preparing ${DISPLAY_NAME}`,
  detail: 'Getting things ready.',
  progress: 16,
}

const DEFAULT_MLX_INSTALL_STATE: MlxInstallState = {
  supported: false,
  installed: false,
  ffmpeg_available: false,
  phase: 'idle',
  label: 'Local STT not installed',
  detail: 'Install MLX Whisper in the backend virtualenv to enable local speech recognition.',
  progress: null,
  logs: [],
  can_install: false,
  venv_available: false,
}

const DEFAULT_SEMANTIC_MEMORY_INSTALL_STATE: SemanticMemoryInstallState = {
  supported: true,
  installed: false,
  python_available: false,
  python_compatible: false,
  runtime_source: 'none',
  python_version: null,
  python_path: null,
  sqlite_module: 'unknown',
  sqlite_version: null,
  vec_version: null,
  error_code: null,
  log_path: null,
  runtime_path: null,
  phase: 'fallback',
  label: 'Fallback active',
  detail: `${DISPLAY_NAME} is using lexical local memory. Install the optional semantic runtime to improve paraphrase recall.`,
  progress: null,
  logs: [],
  can_install: false,
}

const EMPTY_CONTEXT: SmartContext = {
  app_name: 'Unknown',
  bundle_id: null,
  window_title: null,
  page_title: null,
  url_host: null,
  url_path: null,
  focused_field_role: null,
  focused_field_subrole: null,
  focused_field_label: null,
  focused_field_placeholder: null,
  code_file_name: null,
  code_file_extension: null,
  surface_kind: null,
}

const STEPS: Array<{ id: StepId; label: string; eyebrow: string }> = [
  { id: 'voice', label: 'Voice', eyebrow: 'Capture' },
  { id: 'rewrite', label: 'Smart', eyebrow: 'Output' },
  { id: 'privacy', label: 'Privacy', eyebrow: 'Control' },
  { id: 'advanced', label: 'Advanced', eyebrow: 'Utility' },
]

const STEP_DETAILS: Record<StepId, { title: string; description: string }> = {
  voice: {
    title: 'Voice',
    description: 'Permissions, dictation provider, mic, and cues.',
  },
  rewrite: {
    title: 'Smart',
    description: 'Models, templates, and routing.',
  },
  privacy: {
    title: 'Privacy',
    description: 'Context access and sensitive-target rules.',
  },
  advanced: {
    title: 'Advanced',
    description: 'Diagnostics, domains, history, and recovery.',
  },
}

const PROVIDERS: { llm: ProviderOption[]; stt: ProviderOption[] } = {
  llm: [
    { id: 'lmstudio', name: 'LM Studio', desc: 'Local Smart models over LM Studio (default)', requiresKey: false },
    { id: 'groq', name: 'Groq', desc: 'Fastest response', requiresKey: true },
    { id: 'openai', name: 'OpenAI', desc: 'GPT models', requiresKey: true },
    { id: 'anthropic', name: 'Anthropic', desc: 'Claude models', requiresKey: true },
    { id: 'gemini', name: 'Gemini', desc: 'Google Gemini models', requiresKey: true },
    { id: 'nvidia', name: 'NVIDIA', desc: 'Hosted NIM and partner models', requiresKey: true },
    { id: 'sarvam', name: 'Sarvam', desc: 'Indic-first multilingual chat models', requiresKey: true },
  ],
  stt: [
    { id: 'mlx-whisper', name: 'MLX Whisper', desc: 'Local speech recognition on Apple Silicon (default)', requiresKey: false },
    { id: 'groq', name: 'Groq', desc: 'Whisper on Groq', requiresKey: true },
    { id: 'openai', name: 'OpenAI', desc: 'OpenAI Whisper', requiresKey: true },
    { id: 'deepgram', name: 'Deepgram', desc: 'Nova models', requiresKey: true },
    { id: 'nvidia', name: 'NVIDIA', desc: 'Hosted Riva speech models', requiresKey: true },
    { id: 'sarvam', name: 'Sarvam', desc: 'Indic-first speech recognition', requiresKey: true },
  ],
}
const API_KEY_PROVIDERS = ['groq', 'openai', 'anthropic', 'deepgram', 'gemini', 'nvidia', 'sarvam'] as const
type ApiKeyProviderId = typeof API_KEY_PROVIDERS[number]
const EMPTY_WRITING_TOOLS: WritingToolsSnapshot = {
  dictionary: [],
  replacements: [],
  snippets: [],
}
const WHISPER_LANGUAGE_OPTIONS: SupportedLanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'ur', label: 'Urdu' },
  { code: 'ar', label: 'Arabic' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
]
const WHISPER_LANGUAGE_LABELS = new Map(WHISPER_LANGUAGE_OPTIONS.map((option) => [option.code, option.label]))
const DICTIONARY_EXAMPLES = [
  { spoken: 'sea quay well', saved: 'SQL' },
  { spoken: 'med gemma', saved: 'MedGemma' },
  { spoken: 'bill of lading', saved: 'B/L' },
] as const
const PROVIDER_OPTIONS_BY_ID = new Map<string, ProviderOption>([
  ...PROVIDERS.llm,
  ...PROVIDERS.stt,
].map((option) => [option.id, option]))

type ApiKeyUsageItem = {
  laneLabel: string
  providerId: string
  modelLabel: string
}

function formatAliases(aliases: string[]) {
  return aliases.join(', ')
}

function parseAliases(value: string) {
  return value
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function isApiKeyProviderId(value: string): value is ApiKeyProviderId {
  return API_KEY_PROVIDERS.includes(value as ApiKeyProviderId)
}

function formatProviderName(providerId: string) {
  return PROVIDER_OPTIONS_BY_ID.get(providerId)?.name
    || (providerId ? `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}` : 'Unknown')
}

function ApiKeyWorkbench({
  apiProvider,
  apiKey,
  keysSet,
  keyStatus,
  providerIntro,
  onProviderSelect,
  onApiKeyChange,
  onSave,
  onClear,
}: {
  apiProvider: ApiKeyProviderId
  apiKey: string
  keysSet: KeyStatusMap
  keyStatus: 'idle' | 'saving' | 'success' | 'error'
  providerIntro: string
  onProviderSelect: (provider: ApiKeyProviderId) => void
  onApiKeyChange: (value: string) => void
  onSave: () => void
  onClear: () => void
}) {
  const providerLabel = formatProviderName(apiProvider)
  const providerMeta = PROVIDER_OPTIONS_BY_ID.get(apiProvider)
  const providerStored = Boolean(keysSet[apiProvider])
  const statusLabel = keyStatus === 'saving'
    ? 'Saving key'
    : keyStatus === 'success'
      ? 'Saved'
      : keyStatus === 'error'
        ? 'Save failed'
        : providerStored
          ? 'Stored securely'
          : 'No key saved'
  const statusTone = keyStatus === 'error'
    ? 'danger'
    : keyStatus === 'success' || providerStored
      ? 'good'
      : 'neutral'

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,380px)]">
      <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
        <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Choose provider</div>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{providerIntro}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {API_KEY_PROVIDERS.map((provider) => {
            const active = apiProvider === provider
            const providerOption = PROVIDER_OPTIONS_BY_ID.get(provider)
            return (
              <button
                key={provider}
                type="button"
                aria-pressed={active}
                onClick={() => onProviderSelect(provider)}
                className={`h-full overflow-hidden rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#091018] ${active
                  ? 'border-accent-primary/25 bg-accent-primary/12'
                  : 'border-white/6 bg-black/20 hover:border-white/12 hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex h-full min-w-0 flex-col gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary">{formatProviderName(provider)}</div>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">{providerOption?.desc || 'Cloud provider'}</p>
                  </div>
                  <div className="mt-auto flex min-w-0 flex-wrap gap-2">
                    {provider === 'groq' ? <StatusBadge label="Recommended" tone="good" /> : null}
                    <StatusBadge label={keysSet[provider] ? 'Key saved' : 'No key'} tone={keysSet[provider] ? 'good' : 'neutral'} />
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Save secret</div>
            <div className="mt-2 text-lg font-semibold tracking-[-0.02em] text-text-primary">{providerLabel} API key</div>
            <p className="mt-2 max-w-sm text-sm leading-6 text-text-secondary">
              {providerMeta?.desc
                ? `${providerMeta.desc}. Paste the secret you want ${DISPLAY_NAME} to use when ${providerLabel} is selected.`
                : `Paste the secret you want ${DISPLAY_NAME} to use when ${providerLabel} is selected.`}
            </p>
          </div>
          <StatusBadge label={statusLabel} tone={statusTone} />
        </div>

        <div className="mt-5 rounded-2xl border border-white/6 bg-black/20 p-4">
          <label className="block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">API key value</label>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder={providerStored ? 'Paste a new key to replace the stored one' : 'Paste your API key'}
            className="mt-3 w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
          />
          <p className="mt-3 text-xs leading-5 text-text-secondary">
            {providerStored
              ? 'Entering a new value replaces the existing stored key.'
              : 'The key is stored locally and only used when this provider is active.'}
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {providerStored ? (
            <FooterButton tone="secondary" size="compact" onClick={onClear} disabled={keyStatus === 'saving'}>
              Clear key
            </FooterButton>
          ) : null}
          <FooterButton size="compact" onClick={onSave} disabled={!apiKey || keyStatus === 'saving'}>
            {keyStatus === 'saving' ? 'Saving…' : keyStatus === 'success' ? 'Saved' : keyStatus === 'error' ? 'Try again' : 'Save key'}
          </FooterButton>
        </div>
      </div>
    </div>
  )
}

function ProviderLaneSummaryPanel({
  title,
  items,
}: {
  title: string
  items: ApiKeyUsageItem[]
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{title}</div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-white/6 bg-black/20">
        {items.map((item, index) => (
          <div
            key={item.laneLabel}
            className={`flex flex-wrap items-center justify-between gap-4 px-4 py-3 ${index > 0 ? 'border-t border-white/6' : ''}`}
          >
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">{item.laneLabel}</div>
              <div className="mt-1.5 text-sm font-medium text-text-primary">{formatProviderName(item.providerId)}</div>
            </div>
            <div className="max-w-full text-right text-xs leading-5 text-text-secondary">{item.modelLabel}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function buildDomainGuidance(domainId: 'shipping' | 'medical') {
  if (domainId === 'shipping') {
    return {
      vocabulary: 'Add carrier names, shipment terms, ports, and internal abbreviations. Aliases should be the spoken form or the common mishearing. The saved term is the final wording you want pasted.',
      template: 'Use templates for repeated outputs like delay notices, shift handoffs, and customer updates.',
      example: 'Use examples to show the tone and structure a strong shipping update should follow.',
      sampleTerms: ['Spoken as `blue anchor`, save as `Blue Anchor Lines`', 'Spoken as `B O L`, save as `B/L`'],
    }
  }

  return {
    vocabulary: 'Add drug names, departments, shorthand, and note phrases. Aliases should capture how you say the term or how speech recognition often misses it.',
    template: 'Use templates for recurring note shapes like follow-up summaries, care team updates, and discharge drafts.',
    example: 'Use examples to demonstrate the exact level of structure and documentation style you want.',
    sampleTerms: ['Spoken as `med gemma`, save as `MedGemma`', 'Spoken as `ROS`, save as `ROS` and list any expanded aliases you use aloud'],
  }
}

const STEP_MOTION = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1] as const,
}

function parseSettingsStep(value: string | null): StepId {
  if (value === 'rewrite' || value === 'privacy' || value === 'advanced') return value
  return 'voice'
}

function createDirtySections(): DirtySectionMap {
  return {
    voice: false,
    rewrite: false,
    privacy: false,
    advanced: false,
  }
}

function stableStringify(value: unknown) {
  return JSON.stringify(value)
}

function deriveDirtySections(appliedConfig: AppConfig | null, draftConfig: AppConfig | null): DirtySectionMap {
  if (!appliedConfig || !draftConfig) return createDirtySections()

  return {
    voice: stableStringify(appliedConfig.stt) !== stableStringify(draftConfig.stt)
      || stableStringify(appliedConfig.audio) !== stableStringify(draftConfig.audio),
    rewrite: stableStringify(appliedConfig.llm) !== stableStringify(draftConfig.llm)
      || stableStringify(appliedConfig.hotkeys) !== stableStringify(draftConfig.hotkeys)
      || stableStringify(appliedConfig.domains) !== stableStringify(draftConfig.domains),
    privacy: stableStringify(appliedConfig.privacy) !== stableStringify(draftConfig.privacy),
    advanced: stableStringify(appliedConfig.debug) !== stableStringify(draftConfig.debug)
      || stableStringify(appliedConfig.actions) !== stableStringify(draftConfig.actions)
      || stableStringify(appliedConfig.memory) !== stableStringify(draftConfig.memory),
  }
}

function createConfigReducerState(appliedConfig: AppConfig | null, draftConfig: AppConfig | null): ConfigReducerState {
  return {
    appliedConfig,
    draftConfig,
    dirtySections: deriveDirtySections(appliedConfig, draftConfig),
  }
}

function formatPlannerResolverLabel(lastSmartRun: { planner_resolver: 'local' | 'model'; planner_provider: string | null; planner_model: string | null }) {
  if (lastSmartRun.planner_resolver !== 'model') return 'Local rules'
  const provider = lastSmartRun.planner_provider?.trim()
  const model = lastSmartRun.planner_model?.trim()
  if (provider && model) return `${provider} • ${model}`
  if (model) return model
  return 'Model-assisted'
}

function configReducer(state: ConfigReducerState, action: ConfigReducerAction): ConfigReducerState {
  if (action.type === 'hydrate') {
    return createConfigReducerState(action.config, action.config)
  }

  if (!state.draftConfig) {
    return state
  }

  if (action.type === 'setDraft') {
    return createConfigReducerState(state.appliedConfig, action.config)
  }

  return createConfigReducerState(state.appliedConfig, action.updater(state.draftConfig))
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'data' in error) {
    const detail = (error as { data?: unknown }).data
    if (typeof detail === 'string' && detail.trim()) return detail
    if (detail && typeof detail === 'object') {
      const message = 'detail' in detail
        ? detail.detail
        : 'message' in detail
          ? detail.message
          : null
      if (typeof message === 'string' && message.trim()) return message
    }
  }

  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function surfaceTone(tone: 'good' | 'warn' | 'danger' | 'neutral') {
  if (tone === 'good') {
    return 'border-semantic-success/20 bg-semantic-success/8 text-semantic-success'
  }
  if (tone === 'warn') {
    return 'border-semantic-warning/20 bg-semantic-warning/8 text-semantic-warning'
  }
  if (tone === 'danger') {
    return 'border-semantic-error/20 bg-semantic-error/10 text-semantic-error'
  }
  return 'border-white/8 bg-white/[0.03] text-text-secondary'
}

function StatusBadge({ label, tone }: { label: string; tone: 'good' | 'warn' | 'danger' | 'neutral' }) {
  return (
    <div
      title={label}
      className={`inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-medium leading-none ${surfaceTone(tone)}`}
    >
      <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{label}</span>
    </div>
  )
}

function resolveConfiguredDevice(audioConfig: AppConfig['audio'], devices: AudioDevice[]) {
  const safeDevices = Array.isArray(devices) ? devices : []

  if (audioConfig.input_device_id) {
    const byId = safeDevices.find((device) => device.id === audioConfig.input_device_id)
    if (byId) return byId
  }

  const fallbackLabel = audioConfig.input_device_label || audioConfig.input_device
  if (!fallbackLabel) return null

  return safeDevices.find((device) => device.label === fallbackLabel) || null
}

function formatProviderModelLabel(model: ProviderModel, provider: string) {
  if (provider !== 'lmstudio') return model.name

  const suffixes: string[] = []
  if (model.recommended_for_smart) {
    suffixes.push('recommended')
  } else if (model.smart_capable === false) {
    suffixes.push('limited for Smart')
  }
  if (model.loaded === false) {
    suffixes.push('not loaded')
  }
  return suffixes.length ? `${model.name} (${suffixes.join(', ')})` : model.name
}

function formatLanguageLabel(code: string | null | undefined) {
  const normalized = code?.trim().toLowerCase() || ''
  if (!normalized) return 'English'
  return WHISPER_LANGUAGE_LABELS.get(normalized) || `Saved language (${normalized.toUpperCase()})`
}

function describeSemanticMemoryUi(
  enabled: boolean,
  state: SemanticMemoryInstallState,
): { label: string; tone: 'good' | 'warn' | 'danger' | 'neutral'; detail: string } {
  if (!enabled) {
    return {
      label: 'Disabled',
      tone: 'neutral',
      detail: 'Lexical local memory remains available, but semantic retrieval is turned off in Settings.',
    }
  }
  if (state.phase === 'ready' && state.installed) {
    return {
      label: 'Ready',
      tone: 'good',
      detail: 'Semantic retrieval is installed and will improve paraphrase matching for local memory.',
    }
  }
  if (state.phase === 'repair_needed') {
    return {
      label: 'Repair needed',
      tone: 'warn',
      detail: state.detail,
    }
  }
  if (state.phase === 'error') {
    return {
      label: 'Error',
      tone: 'danger',
      detail: state.detail,
    }
  }
  if (state.phase === 'installing' || state.phase === 'preparing_model' || state.phase === 'provisioning_runtime' || state.phase === 'checking') {
    return {
      label: state.phase === 'provisioning_runtime' ? 'Provisioning runtime' : 'Installing',
      tone: 'warn',
      detail: state.detail,
    }
  }
  return {
    label: 'Fallback',
    tone: 'warn',
    detail: state.detail,
  }
}

function formatSemanticMemoryInstallerLabel(state: SemanticMemoryInstallState) {
  if (state.runtime_source === 'managed') {
    return state.python_version ? `Managed Python ${state.python_version}` : 'Managed runtime'
  }
  if (state.runtime_source === 'development') {
    return state.python_version ? `Dev Python ${state.python_version}` : 'Development runtime'
  }
  if (!state.python_available) return 'Managed fallback available'
  if (!state.python_compatible) return state.python_version ? `Python ${state.python_version} unsupported` : 'Python unsupported'
  if (state.python_version) return `System Python ${state.python_version}`
  return 'Python ready'
}

function buildSemanticMemoryDiagnostics(state: SemanticMemoryInstallState) {
  return [
    `Semantic retrieval status: ${state.label}`,
    `Phase: ${state.phase}`,
    `Runtime source: ${state.runtime_source}`,
    `Python version: ${state.python_version ?? 'unknown'}`,
    `Python path: ${state.python_path ?? 'not set'}`,
    `SQLite module: ${state.sqlite_module}`,
    `SQLite version: ${state.sqlite_version ?? 'unknown'}`,
    `sqlite-vec version: ${state.vec_version ?? 'unknown'}`,
    `Error code: ${state.error_code ?? 'none'}`,
    `Detail: ${state.detail}`,
    `Runtime path: ${state.runtime_path ?? 'not set'}`,
    `Log path: ${state.log_path ?? 'not set'}`,
    '',
    'Recent semantic logs:',
    ...(state.logs.length ? state.logs : ['No semantic runtime logs recorded yet.']),
  ].join('\n')
}

function buildLanguageOptions(selectedCodes: string[]) {
  const knownCodes = new Set(WHISPER_LANGUAGE_OPTIONS.map((option) => option.code))
  const extras = selectedCodes
    .map((value) => value.trim().toLowerCase())
    .filter((value, index, items) => Boolean(value) && items.indexOf(value) === index && !knownCodes.has(value))
    .map((code) => ({ code, label: formatLanguageLabel(code) }))

  return [...extras, ...WHISPER_LANGUAGE_OPTIONS]
}

function normalizeAudioDevices(value: unknown): AudioDevice[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((device): device is AudioDevice => (
      Boolean(device)
      && typeof device === 'object'
      && typeof (device as AudioDevice).id === 'string'
      && typeof (device as AudioDevice).label === 'string'
    ))
    .map((device) => ({
      id: device.id,
      label: device.label,
      is_default: Boolean(device.is_default),
      group_id: device.group_id ?? null,
    }))
}

function SidebarSectionButton({
  active,
  collapsed,
  icon,
  label,
  summary,
  onClick,
}: {
  active: boolean
  collapsed: boolean
  icon: ReactNode
  label: string
  summary: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      aria-pressed={active}
      aria-label={collapsed ? label : undefined}
      className={`settings-sidebar-item flex items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${active
          ? 'settings-sidebar-item-active'
          : 'text-text-secondary hover:text-text-primary'
        } ${collapsed ? 'justify-center' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920]`}
    >
      <div
        className={`widget-control flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${active
            ? 'text-text-primary'
            : 'text-text-muted'
          }`}
      >
        {icon}
      </div>
      {!collapsed ? (
        <div className="min-w-0">
          <div className={`truncate text-sm font-medium ${active ? 'text-text-primary' : 'text-text-primary'}`}>{label}</div>
          {summary ? <div className="mt-1 truncate text-[11px] text-text-muted">{summary}</div> : null}
        </div>
      ) : null}
    </button>
  )
}

function InfoDisclosure({
  label = 'More info',
  children,
  align = 'right',
}: {
  label?: string
  children: ReactNode
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ top: number; left: number; width: number; placement: 'top' | 'bottom' } | null>(null)

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || typeof window === 'undefined') return

    const rect = trigger.getBoundingClientRect()
    const width = Math.min(288, Math.max(220, window.innerWidth - 24))
    let left = align === 'left' ? rect.left : rect.right - width
    left = Math.min(Math.max(12, left), window.innerWidth - width - 12)

    const panelHeight = panelRef.current?.offsetHeight ?? 140
    const spaceBelow = window.innerHeight - rect.bottom - 12
    const spaceAbove = rect.top - 12
    const placement = spaceBelow < panelHeight && spaceAbove > spaceBelow ? 'top' : 'bottom'
    const top = placement === 'top'
      ? Math.max(12, rect.top - 12)
      : Math.min(window.innerHeight - 12, rect.bottom + 12)

    setPosition({ top, left, width, placement })
  }, [align])

  useEffect(() => {
    if (!open) return undefined

    const frameId = window.requestAnimationFrame(() => {
      updatePosition()
    })

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return
      }
      setOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    const handleLayoutChange = () => {
      updatePosition()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleLayoutChange)
    window.addEventListener('scroll', handleLayoutChange, true)

    return () => {
      window.cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleLayoutChange)
      window.removeEventListener('scroll', handleLayoutChange, true)
    }
  }, [open, updatePosition])

  return (
    <>
      <div className="shrink-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((current) => !current)}
          title={label}
          aria-label={label}
          aria-expanded={open}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] ${open
            ? 'border-white/14 bg-white/[0.08] text-text-primary'
            : 'border-white/8 bg-white/[0.03] text-text-muted hover:border-white/12 hover:bg-white/[0.05] hover:text-text-primary'
            }`}
        >
          <InfoIcon size={14} />
        </button>
      </div>

      {open && position && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              width: position.width,
              transform: position.placement === 'top' ? 'translateY(-100%)' : undefined,
            }}
            className="z-[120] rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(35,39,47,0.96),rgba(19,22,28,0.98))] p-3 text-xs leading-6 text-text-secondary shadow-[0_18px_36px_rgba(0,0,0,0.28)] backdrop-blur-xl"
          >
            {children}
          </div>,
          document.body,
        )
        : null}
    </>
  )
}

function SwitchControl({
  checked,
  onChange,
  label,
  size = 'default',
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  size?: 'default' | 'compact'
  disabled?: boolean
}) {
  const compact = size === 'compact'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        onChange(!checked)
      }}
      className={`relative inline-flex shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] ${compact ? 'h-6 w-10' : 'h-7 w-12'} ${checked
        ? 'border-accent-primary/30 bg-accent-primary/30'
        : 'border-white/10 bg-white/[0.05] hover:border-white/16 hover:bg-white/[0.08]'
        } ${disabled ? 'cursor-not-allowed opacity-45 hover:border-white/10 hover:bg-white/[0.05]' : ''}`}
    >
      <span
        className={`absolute rounded-full bg-white shadow-[0_6px_16px_rgba(0,0,0,0.28)] transition-transform ${compact ? 'h-[18px] w-[18px]' : 'h-5 w-5'} ${checked
          ? compact ? 'translate-x-[18px]' : 'translate-x-[22px]'
          : 'translate-x-[3px]'
          }`}
      />
    </button>
  )
}

function ToggleCard({
  title,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className={`flex items-start justify-between gap-4 rounded-2xl border border-white/6 bg-white/[0.02] p-4 ${disabled ? 'opacity-70' : ''}`}>
      <div>
        <div className="text-sm font-medium text-text-primary">{title}</div>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{checked ? 'On' : 'Off'}</span>
        <SwitchControl checked={checked} onChange={onChange} label={title} disabled={disabled} />
      </div>
    </div>
  )
}

function InlineSwitch({
  checked,
  onChange,
  label = 'Enabled',
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
}) {
  return (
    <div className="inline-flex items-center gap-3 text-sm text-text-secondary">
      <span>{label}</span>
      <SwitchControl checked={checked} onChange={onChange} label={label} size="compact" />
    </div>
  )
}

function SectionCard({
  title,
  icon,
  children,
  description,
  action,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string
  icon: ReactNode
  children: ReactNode
  description?: string
  action?: ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="glass-card p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 text-sm font-semibold text-text-primary">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/8 bg-white/[0.035] text-text-primary/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              {icon}
            </div>
            <span>{title}</span>
            {description ? (
              <InfoDisclosure label={`${title} help`}>
                <p>{description}</p>
              </InfoDisclosure>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {collapsible ? (
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/[0.03] text-text-muted transition-colors hover:border-white/12 hover:bg-white/[0.05] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920]"
              title={open ? 'Collapse section' : 'Expand section'}
            >
              <ArrowRightIcon size={14} className={`transition-transform duration-200 ${open ? 'rotate-90' : 'rotate-0'}`} />
            </button>
          ) : null}
        </div>
      </div>
      {(!collapsible || open) ? children : null}
    </section>
  )
}

function LogPathCard({
  label,
  path,
}: {
  label: string
  path: string
}) {
  const copyPath = () => {
    void window.windowControls?.writeClipboardText?.(path)
  }

  return (
    <div className="group relative rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.26em] text-text-muted">{label}</div>
      <code className="mt-3 block break-all rounded-xl bg-black/35 px-3 py-2 text-xs text-text-primary">{path}</code>
      <button
        type="button"
        onClick={copyPath}
        className="absolute right-4 top-4 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-text-secondary opacity-0 transition-opacity hover:bg-white/10 hover:text-text-primary group-hover:opacity-100"
      >
        Copy
      </button>
    </div>
  )
}

function PermissionCard({
  title,
  subtitle,
  statusLabel,
  tone,
  action,
}: {
  title: string
  subtitle: string
  statusLabel: string
  tone: 'good' | 'warn' | 'danger' | 'neutral'
  action?: ReactNode
}) {
  return (
    <div className="section-intro-panel h-full rounded-2xl border border-white/6 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          <p className="mt-1.5 text-sm leading-6 text-text-secondary">{subtitle}</p>
        </div>
        <StatusBadge label={statusLabel} tone={tone} />
      </div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

function ProviderPicker({
  label,
  value,
  options,
  availableKeys,
  onChange,
}: {
  label: string
  value: string
  options: ProviderOption[]
  availableKeys: KeyStatusMap
  onChange: (provider: string) => void
}) {
  return (
    <div>
      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">{label}</label>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        {options.map((option) => {
          const active = option.id === value
          const requiresKey = option.requiresKey !== false
          const keyReady = Boolean(availableKeys[option.id])
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.id)}
              title={`${option.name}: ${option.desc}`}
              className={`h-full overflow-hidden rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] ${active
                  ? 'border-white/14 bg-white/[0.08] shadow-[0_10px_24px_rgba(0,0,0,0.12)]'
                  : 'border-white/6 bg-white/[0.02] hover:border-white/12 hover:bg-white/[0.04]'
                }`}
            >
              <div className="flex h-full min-w-0 flex-col gap-3">
                <div className="min-w-0 text-sm font-medium text-text-primary">{option.name}</div>
                <div className="mt-auto flex min-w-0 flex-wrap gap-2">
                  {requiresKey
                    ? (keyReady ? <StatusBadge label="Key ready" tone="good" /> : <StatusBadge label="No key" tone="neutral" />)
                    : <StatusBadge label="Local" tone="good" />}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ContextField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{label}</div>
      <div className="mt-2 break-all font-mono text-sm text-text-primary">{value || 'Unknown'}</div>
    </div>
  )
}

function OptionalContextField({
  label,
  value,
  emptyLabel,
}: {
  label: string
  value: string | null | undefined
  emptyLabel: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{label}</div>
      <div className="mt-2 break-all font-mono text-sm text-text-primary">{value || emptyLabel}</div>
    </div>
  )
}

function normalizeAppName(value: string | null | undefined) {
  if (!value) return ''
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeHost(value: string | null | undefined) {
  if (!value) return ''
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')[0] || ''
}

function hostMatches(ruleHost: string | null | undefined, contextHost: string | null | undefined) {
  const normalizedRuleHost = normalizeHost(ruleHost)
  const normalizedContextHost = normalizeHost(contextHost)
  if (!normalizedRuleHost || !normalizedContextHost) return false
  return normalizedContextHost === normalizedRuleHost || normalizedContextHost.endsWith(`.${normalizedRuleHost}`)
}

function createAppSkillDefaultId(appName: string) {
  const slug = normalizeAppName(appName).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'app'
  const randomId = globalThis.crypto?.randomUUID?.()
  const suffix = randomId ? randomId.slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${slug}_${suffix}`
}

function createAppDomainDefaultId(appName: string) {
  const slug = normalizeAppName(appName).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'domain'
  const randomId = globalThis.crypto?.randomUUID?.()
  const suffix = randomId ? randomId.slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${slug}_${suffix}`
}

function buildAppDomainLabel(appName: string, urlHost?: string | null) {
  const normalizedAppName = appName.trim() || 'Manual target'
  const normalizedHost = normalizeHost(urlHost)
  return normalizedHost ? `${normalizedAppName} • ${normalizedHost}` : normalizedAppName
}

function createManualAppDomainDefault(): AppDomainDefault {
  return {
    id: createAppDomainDefaultId('manual'),
    app_label: 'Manual target',
    bundle_id: null,
    url_host: null,
    app_name: '',
    domain_id: 'shipping',
    enabled: true,
  }
}

function createSensitiveTargetRuleId(appName: string) {
  const slug = normalizeAppName(appName).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'privacy'
  const randomId = globalThis.crypto?.randomUUID?.()
  const suffix = randomId ? randomId.slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${slug}_${suffix}`
}

function findMatchingAppSkillDefaultIndex(appSkillDefaults: AppSkillDefault[], context: SmartContext) {
  const bundleId = context.bundle_id?.trim() || null
  if (bundleId) {
    const bundleMatchIndex = appSkillDefaults.findIndex((rule) => rule.bundle_id === bundleId)
    if (bundleMatchIndex >= 0) return bundleMatchIndex
  }

  const urlHost = context.url_host?.trim() || null
  if (urlHost) {
    const hostMatchIndex = appSkillDefaults.findIndex((rule) => hostMatches(rule.url_host, urlHost))
    if (hostMatchIndex >= 0) return hostMatchIndex
  }

  const normalizedAppName = normalizeAppName(context.app_name)
  if (!normalizedAppName) return -1

  return appSkillDefaults.findIndex((rule) => !rule.bundle_id && !rule.url_host && normalizeAppName(rule.app_name) === normalizedAppName)
}

function findMatchingAppDomainDefaultIndex(appDomainDefaults: AppDomainDefault[], context: SmartContext) {
  const bundleId = context.bundle_id?.trim() || null
  if (bundleId) {
    const bundleMatchIndex = appDomainDefaults.findIndex((rule) => rule.bundle_id === bundleId)
    if (bundleMatchIndex >= 0) return bundleMatchIndex
  }

  const urlHost = context.url_host?.trim() || null
  if (urlHost) {
    const hostMatchIndex = appDomainDefaults.findIndex((rule) => hostMatches(rule.url_host, urlHost))
    if (hostMatchIndex >= 0) return hostMatchIndex
  }

  const normalizedAppName = normalizeAppName(context.app_name)
  if (!normalizedAppName) return -1

  return appDomainDefaults.findIndex((rule) => !rule.bundle_id && !rule.url_host && normalizeAppName(rule.app_name) === normalizedAppName)
}

function findMatchingSensitiveTargetIndex(rules: SensitiveTargetRule[], context: SmartContext) {
  const bundleId = context.bundle_id?.trim() || null
  if (bundleId) {
    const bundleMatchIndex = rules.findIndex((rule) => rule.bundle_id === bundleId)
    if (bundleMatchIndex >= 0) return bundleMatchIndex
  }

  const urlHost = context.url_host?.trim() || null
  if (urlHost) {
    const hostMatchIndex = rules.findIndex((rule) => hostMatches(rule.url_host, urlHost))
    if (hostMatchIndex >= 0) return hostMatchIndex
  }

  const normalizedAppName = normalizeAppName(context.app_name)
  if (!normalizedAppName) return -1

  return rules.findIndex((rule) => !rule.bundle_id && !rule.url_host && normalizeAppName(rule.app_name) === normalizedAppName)
}

function ReadOnlyShortcut({
  title,
  shortcut,
  description,
}: {
  title: string
  shortcut: string
  description: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        <kbd className="rounded-xl border border-white/10 bg-white/[0.05] px-2.5 py-1 font-mono text-xs text-text-primary">
          {shortcut}
        </kbd>
      </div>
      <p className="mt-3 text-sm leading-6 text-text-secondary">{description}</p>
    </div>
  )
}

function InspectorField({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{label}</div>
      <div className="mt-2 break-all text-sm leading-6 text-text-primary">{value}</div>
    </div>
  )
}

function UsageMetricCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{label}</div>
      <div className="mt-2 text-xl font-semibold tracking-[-0.03em] text-text-primary">{value}</div>
      {hint ? <div className="mt-2 text-xs leading-5 text-text-secondary">{hint}</div> : null}
    </div>
  )
}

function FooterButton({
  children,
  tone = 'primary',
  size = 'default',
  disabled,
  onClick,
}: {
  children: ReactNode
  tone?: 'primary' | 'secondary'
  size?: 'default' | 'compact'
  disabled?: boolean
  onClick: () => void
}) {
  const classes = tone === 'primary'
    ? 'border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0.08))] text-text-primary hover:bg-[linear-gradient(180deg,rgba(255,255,255,0.2),rgba(255,255,255,0.1))]'
    : 'border-white/8 bg-white/[0.03] text-text-primary hover:bg-white/[0.06]'
  const sizeClasses = size === 'compact'
    ? 'rounded-xl px-3 py-2 text-xs'
    : 'rounded-2xl px-4 py-2.5 text-sm font-medium'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#161920] disabled:cursor-not-allowed disabled:opacity-45 ${sizeClasses} ${classes}`}
    >
      {children}
    </button>
  )
}

function hasUsefulContext(context: SmartContext | null | undefined) {
  if (!context) return false
  return Boolean(
    (context.app_name && context.app_name !== 'Unknown')
    || context.window_title
    || context.page_title
    || context.url_host
    || context.url_path
  )
}

function hasUsableAppContext(context: SmartContext | null | undefined) {
  if (!context) return false
  return Boolean(context.app_name && context.app_name !== 'Unknown')
}

function formatQualityLabel(quality: BackendStatus['captured_context_quality']) {
  if (quality === 'full') return 'Ready'
  if (quality === 'app_only') return 'App only'
  if (quality === 'transcript_only') return 'Transcript only'
  return 'Not available'
}

function formatQualityTone(quality: BackendStatus['captured_context_quality']) {
  if (quality === 'full') return 'good' as const
  if (quality === 'app_only') return 'warn' as const
  if (quality === 'transcript_only') return 'danger' as const
  return 'neutral' as const
}

function formatTargetType(targetType: string | null | undefined) {
  if (!targetType) return 'Generic'
  return targetType.replace(/_/g, ' ')
}

function formatCapturedAt(value: string | null | undefined) {
  if (!value) return 'Not available'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return 'Not used'
  return `${value} ms`
}

function formatDomainMode(value: DomainMode) {
  if (value === 'off') return 'Off'
  if (value === 'auto') return 'Auto'
  if (value === 'shipping') return 'Shipping'
  return 'Medical'
}

function formatDomainSource(value: 'none' | 'app_override' | 'global_pin' | 'system_rule') {
  if (value === 'app_override') return 'Per-target override'
  if (value === 'global_pin') return 'Pinned domain'
  if (value === 'system_rule') return 'Starter rule'
  return 'No active domain'
}

function formatDomainLabel(value: string | null | undefined) {
  if (value === 'shipping') return 'Shipping'
  if (value === 'medical') return 'Medical'
  return 'None'
}

function formatDomainFormat(value: 'auto' | 'bullets' | 'paragraph' | 'table') {
  if (value === 'bullets') return 'Bullets'
  if (value === 'paragraph') return 'Paragraph'
  if (value === 'table') return 'Table'
  return 'Auto'
}

function formatDomainSurfaceBehavior(value: 'auto' | 'email' | 'note' | 'summary') {
  if (value === 'email') return 'Email'
  if (value === 'note') return 'Note'
  if (value === 'summary') return 'Summary'
  return 'Auto'
}

function describeDomainMode(value: DomainMode) {
  if (value === 'off') return 'No domain memory or templates are applied.'
  if (value === 'auto') return `${DISPLAY_NAME} infers Shipping or Medical from the active app, site, or window title.`
  if (value === 'shipping') return 'Shipping stays active until you switch back, regardless of the current app.'
  return 'Medical stays active until you switch back. This pack is documentation assistance only.'
}

function formatTimeSaved(seconds: number) {
  if (seconds <= 0) return '0 min'
  if (seconds < 60) return '<1 min'

  const totalMinutes = Math.round(seconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} min`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

function formatTrackingDate(value: string | null | undefined) {
  if (!value) return 'today'
  try {
    return new Date(value).toLocaleDateString()
  } catch {
    return value
  }
}

function formatSkillSource(value: 'global_default' | 'app_override' | 'system_rule' | 'domain_forced' | 'history_override') {
  if (value === 'domain_forced') return 'Domain pack'
  if (value === 'history_override') return 'History rerun'
  if (value === 'app_override') return 'Per-target override'
  if (value === 'system_rule') return 'Starter routing rule'
  return 'Global default'
}

function formatActionRoute(value: 'pass_through' | 'save_note' | 'transform_then_paste' | 'transform_then_save_note') {
  if (value === 'save_note') return 'Save note'
  if (value === 'transform_then_save_note') return 'Transform then save'
  if (value === 'transform_then_paste') return 'Transform then paste'
  return 'Pass through'
}

function formatExternalContextSource(value: 'selection' | 'clipboard' | 'none') {
  if (value === 'selection') return 'Selection'
  if (value === 'clipboard') return 'Clipboard'
  return 'None'
}

export const SettingsView = () => {
  const runtime = useRuntimeStore((state) => state)
  const runtimeSnapshot = runtime.snapshot
  const runtimeInvalidations = runtime.invalidationTokens
  const connectionState = runtime.connectionState === 'error'
    ? 'error'
    : runtimeSnapshot.config && runtimeSnapshot.status
      ? 'connected'
      : 'connecting'
  const [searchParams, setSearchParams] = useSearchParams()
  const cachedView = settingsViewCache
  const [bootState] = useBackendBootStateSubscription(DEFAULT_BOOT_STATE)
  const [mlxInstallState] = useMlxInstallStateSubscription(DEFAULT_MLX_INSTALL_STATE)
  const [semanticMemoryInstallState] = useSemanticMemoryInstallStateSubscription(DEFAULT_SEMANTIC_MEMORY_INSTALL_STATE)
  const [showMlxLogs, setShowMlxLogs] = useState(false)
  const [showSemanticMemoryLogs, setShowSemanticMemoryLogs] = useState(false)
  const [launchContext, setLaunchContext] = useLaunchContextState()

  const [configState, dispatchConfig] = useReducer(
    configReducer,
    createConfigReducerState(cachedView?.remoteConfig ?? null, cachedView?.draftConfig ?? cachedView?.remoteConfig ?? null),
  )
  const [domainPacks, setDomainPacks] = useState<DomainPackSummary[]>(cachedView?.domainPacks ?? [])
  const [domainDetails, setDomainDetails] = useState<DomainPackDetail[]>(cachedView?.domainDetails ?? [])
  const [writingTools, setWritingTools] = useState<WritingToolsSnapshot>(cachedView?.writingTools ?? EMPTY_WRITING_TOOLS)
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>(normalizeAudioDevices(cachedView?.audioDevices))
  const [skills, setSkills] = useState<Skill[]>(cachedView?.skills ?? [])
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>(cachedView?.historyItems ?? [])
  const [memories, setMemories] = useState<LearnedMemory[]>(cachedView?.memories ?? [])
  const [historySkillSelections, setHistorySkillSelections] = useState<Record<number, string>>({})
  const [deferredErrors, setDeferredErrors] = useState<Record<'audioDevices' | 'skills' | 'domains' | 'usage' | 'history' | 'writingTools' | 'memory', string | null>>({
    audioDevices: null,
    skills: null,
    domains: null,
    usage: null,
    history: null,
    writingTools: null,
    memory: null,
  })

  const activeStep = parseSettingsStep(searchParams.get('step'))
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [resettingUsage, setResettingUsage] = useState(false)
  const [resettingHistory, setResettingHistory] = useState(false)
  const [refreshingLmStudioModels, setRefreshingLmStudioModels] = useState(false)
  const [lmStudioRefreshMessage, setLmStudioRefreshMessage] = useState<string | null>(null)
  const [domainActionState, setDomainActionState] = useState<{ type: 'idle' | 'importing' | 'exporting' | 'saving'; domainId: string | null; message: string | null; error: string | null }>({
    type: 'idle',
    domainId: null,
    message: null,
    error: null,
  })

  const [apiKey, setApiKey] = useState('')
  const [apiProvider, setApiProvider] = useState<ApiKeyProviderId>('groq')
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle')

  const [refreshingDevices, setRefreshingDevices] = useState(false)
  const [testRecording, setTestRecording] = useState(false)
  const [testResult, setTestResult] = useState<{ transcript?: string; time?: number; error?: string; fallback_notice?: string | null } | null>(null)
  const [activeWritingTab, setActiveWritingTab] = useState<'dictionary' | 'replacements' | 'snippets'>('dictionary')
  const [writingToolDraft, setWritingToolDraft] = useState<WritingToolDraft>({
    source_text: '',
    canonical_text: '',
    aliases_text: '',
    replacement_text: '',
    trigger: '',
    expansion: '',
    match_type: 'inline',
  })
  const [writingToolBusy, setWritingToolBusy] = useState<string | null>(null)
  const [editingWritingToolId, setEditingWritingToolId] = useState<number | null>(null)
  const [memoryBusy, setMemoryBusy] = useState<string | null>(null)
  const [expandedDomainId, setExpandedDomainId] = useState<'shipping' | 'medical' | null>(null)
  const autoRefreshedDevicesRef = useRef(false)
  const deferredRequestsRef = useRef(createLatestRequestController())

  const remoteConfig = configState.appliedConfig
  const draftConfig = configState.draftConfig
  const dirtySections = configState.dirtySections
  const providerModels = runtimeSnapshot.providerModels ?? cachedView?.providerModels ?? null
  const keysSet = runtimeSnapshot.keysSet
  const status = runtimeSnapshot.status
  const usageStats = runtimeSnapshot.usageStats
  const localEnvironment = runtime.localEnvironment
  const microphoneAccess = localEnvironment.microphoneAccess
  const accessibilityTrusted = localEnvironment.accessibilityTrusted
  const contextAccess = localEnvironment.contextAccess
  const setDraftConfig = useCallback((nextConfig: AppConfig | ((current: AppConfig) => AppConfig)) => {
    if (typeof nextConfig === 'function') {
      dispatchConfig({ type: 'updateDraft', updater: nextConfig })
      return
    }
    dispatchConfig({ type: 'setDraft', config: nextConfig })
  }, [])
  const hydrateConfigState = useCallback((config: AppConfig) => {
    dispatchConfig({ type: 'hydrate', config })
  }, [])
  const navigateToStep = useCallback((step: StepId) => {
    const nextParams = new URLSearchParams(searchParams)
    if (step === 'voice') nextParams.delete('step')
    else nextParams.set('step', step)
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  const fetchDeferred = useCallback(async (quiet = false) => {
    const request = deferredRequestsRef.current.begin()
    if (!quiet) {
      setDeferredErrors({
        audioDevices: null,
        skills: null,
        domains: null,
        history: null,
        writingTools: null,
        usage: null,
        memory: null,
      })
    }

    const settled = await retryRead(async (signal) => (
      settleRecord<{
        domains: Promise<{ packs: DomainPackSummary[]; details: DomainPackDetail[] }>
        devices: Promise<unknown>
        skills: Promise<{ skills: Skill[] }>
        writingTools: Promise<WritingToolsSnapshot>
        history: Promise<{ items: HistoryItem[] }>
        memories: Promise<{ items: LearnedMemory[] }>
      }>({
        domains: apiGet<{ packs: DomainPackSummary[]; details: DomainPackDetail[] }>('/domains', withSignal({ timeout: 30000 }, signal)).then(responseData),
        devices: Promise.resolve(window.windowControls?.getCaptureDevices?.() ?? Promise.resolve([])),
        skills: apiGet<{ skills: Skill[] }>('/skills', withSignal({ timeout: 30000 }, signal)).then(responseData),
        writingTools: apiGet<WritingToolsSnapshot>('/writing-tools', withSignal({ timeout: 30000 }, signal)).then(responseData),
        history: apiGet<{ items: HistoryItem[] }>('/history', withSignal({ timeout: 30000 }, signal)).then(responseData),
        memories: apiGet<{ items: LearnedMemory[] }>('/memories', withSignal({ timeout: 30000 }, signal)).then(responseData),
      })
    ), { signal: request.signal })

    if (!deferredRequestsRef.current.isLatest(request.token)) return

    const nextErrors = {
      audioDevices: settled.devices.status === 'rejected' ? getErrorMessage(settled.devices.reason, 'Unable to load audio devices.') : null,
      skills: settled.skills.status === 'rejected' ? getErrorMessage(settled.skills.reason, 'Unable to load templates.') : null,
      domains: settled.domains.status === 'rejected' ? getErrorMessage(settled.domains.reason, 'Unable to load domain packs.') : null,
      usage: null,
      history: settled.history.status === 'rejected' ? getErrorMessage(settled.history.reason, 'Unable to load recent runs.') : null,
      writingTools: settled.writingTools.status === 'rejected' ? getErrorMessage(settled.writingTools.reason, 'Unable to load writing tools.') : null,
      memory: settled.memories.status === 'rejected' ? getErrorMessage(settled.memories.reason, 'Unable to load local memory.') : null,
    }

    if (settled.domains.status === 'fulfilled') {
      setDomainPacks(settled.domains.value.packs || [])
      setDomainDetails(settled.domains.value.details || [])
    }
    if (settled.devices.status === 'fulfilled') {
      setAudioDevices(normalizeAudioDevices(settled.devices.value))
    }
    if (settled.skills.status === 'fulfilled') {
      setSkills(settled.skills.value.skills || [])
    }
    if (settled.writingTools.status === 'fulfilled') {
      setWritingTools(settled.writingTools.value || EMPTY_WRITING_TOOLS)
    }
    if (settled.history.status === 'fulfilled') {
      setHistoryItems(settled.history.value.items || [])
    }
    if (settled.memories.status === 'fulfilled') {
      setMemories(settled.memories.value.items || [])
    }

    setDeferredErrors(nextErrors)
  }, [])

  useEffect(() => {
    const deferredRequests = deferredRequestsRef.current
    void fetchDeferred(Boolean(settingsViewCache))
    return () => {
      deferredRequests.cancel()
    }
  }, [fetchDeferred])

  useEffect(() => {
    if (runtimeSnapshot.config && (!remoteConfig || stableStringify(remoteConfig) !== stableStringify(runtimeSnapshot.config))) {
      hydrateConfigState(runtimeSnapshot.config)
    }
  }, [hydrateConfigState, remoteConfig, runtimeSnapshot.config])

  useEffect(() => {
    if (!remoteConfig || !draftConfig || !providerModels) return

    settingsViewCache = {
      remoteConfig,
      draftConfig,
      providerModels,
      domainPacks,
      domainDetails,
      writingTools,
      audioDevices,
      skills,
      historyItems,
      memories,
    }
  }, [
    remoteConfig,
    draftConfig,
    providerModels,
    domainPacks,
    domainDetails,
    writingTools,
    audioDevices,
    skills,
    historyItems,
    memories,
  ])

  useEffect(() => {
    if (
      runtimeInvalidations.skills === 0
      && runtimeInvalidations.history === 0
      && runtimeInvalidations.domains === 0
      && runtimeInvalidations.writing_tools === 0
    ) {
      return
    }
    void fetchDeferred(true)
  }, [fetchDeferred, runtimeInvalidations.domains, runtimeInvalidations.history, runtimeInvalidations.skills, runtimeInvalidations.writing_tools])

  const saveConfig = async () => {
    if (!draftConfig) return
    setSaving(true)
    setSaveError(null)

    try {
      const res = await apiPost<{ status: string; config: AppConfig }>('/config', draftConfig)
      hydrateConfigState(res.data.config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2200)
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to save changes.'))
    } finally {
      setSaving(false)
    }
  }

  const setMemoryEnabled = async (memoryId: number, enabled: boolean) => {
    setMemoryBusy(`toggle:${memoryId}`)
    try {
      const res = await apiPut<{ status: string; item: LearnedMemory }>(`/memories/${memoryId}`, { enabled })
      setMemories((current) => current.map((item) => (item.id === memoryId ? res.data.item : item)))
    } catch (error: unknown) {
      setDeferredErrors((current) => ({
        ...current,
        memory: getErrorMessage(error, 'Could not update that memory.'),
      }))
    } finally {
      setMemoryBusy(null)
    }
  }

  const deleteMemory = async (memoryId: number) => {
    setMemoryBusy(`delete:${memoryId}`)
    try {
      await apiDelete(`/memories/${memoryId}`)
      setMemories((current) => current.filter((item) => item.id !== memoryId))
    } catch (error: unknown) {
      setDeferredErrors((current) => ({
        ...current,
        memory: getErrorMessage(error, 'Could not delete that memory.'),
      }))
    } finally {
      setMemoryBusy(null)
    }
  }

  const rebuildMemories = async () => {
    setMemoryBusy('rebuild')
    try {
      const res = await apiPost<{ status: string; items: LearnedMemory[] }>('/memories/rebuild')
      setMemories(res.data.items || [])
      setDeferredErrors((current) => ({ ...current, memory: null }))
    } catch (error: unknown) {
      setDeferredErrors((current) => ({
        ...current,
        memory: getErrorMessage(error, 'Could not rebuild local memory from history.'),
      }))
    } finally {
      setMemoryBusy(null)
    }
  }

  const clearAllMemories = async () => {
    setMemoryBusy('clear')
    try {
      await apiDelete('/memories')
      setMemories([])
      setDeferredErrors((current) => ({ ...current, memory: null }))
    } catch (error: unknown) {
      setDeferredErrors((current) => ({
        ...current,
        memory: getErrorMessage(error, 'Could not clear local memory.'),
      }))
    } finally {
      setMemoryBusy(null)
    }
  }

  const saveApiKey = async () => {
    setKeyStatus('saving')
    try {
      await apiPost('/secrets', { provider: apiProvider, key: apiKey })
      setApiKey('')
      setKeyStatus('success')
      setTimeout(() => setKeyStatus('idle'), 3000)
    } catch {
      setKeyStatus('error')
      setTimeout(() => setKeyStatus('idle'), 3000)
    }
  }

  const clearApiKey = async () => {
    setKeyStatus('saving')
    try {
      await apiDelete(`/secrets/${apiProvider}`)
      setApiKey('')
      setKeyStatus('idle')
    } catch {
      setKeyStatus('error')
      setTimeout(() => setKeyStatus('idle'), 3000)
    }
  }

  const refreshDevices = useCallback(async () => {
    setRefreshingDevices(true)
    try {
      const devices = await window.windowControls?.getCaptureDevices?.(true)
      setAudioDevices(normalizeAudioDevices(devices))
    } finally {
      setRefreshingDevices(false)
    }
  }, [])

  const startTestRecording = async () => {
    try {
      if (!draftConfig) return
      const selectedDevice = resolveConfiguredDevice(draftConfig.audio, audioDevices)
      await window.windowControls?.startMicTest?.(selectedDevice?.id ?? null, selectedDevice?.label ?? null)
      setTestRecording(true)
      setTestResult(null)
    } catch (error: unknown) {
      setTestResult({ error: getErrorMessage(error, 'Could not start voice preview.') })
    }
  }

  const stopTestRecording = async () => {
    setTestRecording(false)
    try {
      const res = await window.windowControls?.stopMicTest?.()
      if (res?.status === 'success') {
        setTestResult({ transcript: res.transcript, time: res.processing_time, fallback_notice: res.fallback_notice })
      } else {
        setTestResult({ error: res?.message || 'Could not finish voice preview.', fallback_notice: res?.fallback_notice })
      }
    } catch (error: unknown) {
      setTestResult({ error: getErrorMessage(error, 'Could not finish voice preview.') })
    }
  }

  const openPrivacySettings = (pane: PrivacyPane) => {
    window.windowControls?.openPrivacySettings?.(pane)
  }

  const requestMicrophone = async () => {
    const currentStatus = microphoneAccess
    if (currentStatus === 'denied' || currentStatus === 'restricted') {
      openPrivacySettings('microphone')
      await refreshRuntimeLocalEnvironment({ mode: 'verify', target: 'microphone' })
      return
    }

    const nextStatus = await window.windowControls?.requestCapturePermission?.() ?? 'unknown'
    const snapshot = await refreshRuntimeLocalEnvironment({ mode: 'verify', target: 'microphone' })

    if (nextStatus === 'granted' && snapshot?.microphoneAccess === 'granted') {
      await refreshDevices()
      return
    }

    if (nextStatus !== 'granted' || snapshot?.microphoneAccess !== 'granted') {
      openPrivacySettings('microphone')
    }
  }

  const requestAccessibility = async () => {
    window.windowControls?.promptAccessibility?.()
    openPrivacySettings('accessibility')
    void refreshRuntimeLocalEnvironment({ mode: 'verify', target: 'accessibility' })
  }

  const requestSmartContext = async () => {
    const snapshot = await refreshRuntimeLocalEnvironment({ mode: 'verify', target: 'context', promptContext: true })
    if (snapshot?.contextAccess.status === 'unavailable') {
      openPrivacySettings('automation')
    }
    return snapshot
  }

  const restartLocalEngine = async () => {
    try {
      await window.windowControls?.restartBackend?.()
      await refreshRuntimeLocalEnvironment({ quiet: true })
      void fetchDeferred(true)
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to restart the local engine.'))
    }
  }

  const resetUsageStats = async () => {
    setResettingUsage(true)
    try {
      await apiDelete<{ status: string; usage: UsageStats }>('/usage')
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to reset local usage stats.'))
    } finally {
      setResettingUsage(false)
    }
  }

  const dismissPackagedOnboarding = async () => {
    const nextContext = await window.windowControls?.dismissPackagedOnboarding?.()
    if (nextContext) {
      setLaunchContext(nextContext)
      setSaveError(null)
    }
  }

  const setBackgroundOnly = async (enabled: boolean) => {
    const nextContext = await window.windowControls?.setBackgroundOnly?.(enabled)
    if (nextContext) setLaunchContext(nextContext)
  }

  const completePackagedOnboarding = async () => {
    const nextContext = await window.windowControls?.completePackagedOnboarding?.()
    if (nextContext) {
      setLaunchContext(nextContext)
      setSaveError(nextContext.onboarding_blocker)
    }
  }

  const updateProvider = (section: 'llm' | 'stt', newProvider: string) => {
    if (!draftConfig || !providerModels) return
    setDraftConfig(applyProviderSelection(draftConfig, providerModels, section, newProvider))
  }

  const refreshLmStudioModels = async () => {
    setRefreshingLmStudioModels(true)
    setLmStudioRefreshMessage(null)
    try {
      await apiPost('/providers/models/refresh', { provider: 'lmstudio' })
      await refreshRuntimeProviderModels()
      setLmStudioRefreshMessage('LM Studio models refreshed.')
    } catch (error) {
      setLmStudioRefreshMessage(getErrorMessage(error, 'Unable to refresh LM Studio models right now.'))
    } finally {
      setRefreshingLmStudioModels(false)
    }
  }

  const updateAppSkillDefault = (ruleId: string, updates: Partial<AppSkillDefault>) => {
    if (!draftConfig) return
    const nextRules = (draftConfig.hotkeys.app_skill_defaults || []).map((rule) => (
      rule.id === ruleId ? { ...rule, ...updates } : rule
    ))

    setDraftConfig({
      ...draftConfig,
      hotkeys: {
        ...draftConfig.hotkeys,
        app_skill_defaults: nextRules,
      },
    })
  }

  const removeAppSkillDefault = (ruleId: string) => {
    if (!draftConfig) return
    setDraftConfig({
      ...draftConfig,
      hotkeys: {
        ...draftConfig.hotkeys,
        app_skill_defaults: (draftConfig.hotkeys.app_skill_defaults || []).filter((rule) => rule.id !== ruleId),
      },
    })
  }

  const upsertCurrentFrontmostAppDefault = () => {
    if (!draftConfig || !hasUsableAppContext(contextAccess.context)) return

    const currentContext = contextAccess.context as SmartContext
    const currentRules = draftConfig.hotkeys.app_skill_defaults || []
    const normalizedHost = normalizeHost(currentContext.url_host)
    const useHostScopedRule = Boolean(normalizedHost)
    const matchIndex = useHostScopedRule
      ? currentRules.findIndex((rule) => hostMatches(rule.url_host, normalizedHost))
      : findMatchingAppSkillDefaultIndex(currentRules, currentContext)
    const existingRule = matchIndex >= 0 ? currentRules[matchIndex] : null
    const nextRule: AppSkillDefault = {
      id: existingRule?.id || createAppSkillDefaultId(currentContext.app_name),
      app_label: useHostScopedRule ? `${currentContext.app_name} • ${normalizedHost}` : currentContext.app_name,
      bundle_id: useHostScopedRule ? null : currentContext.bundle_id,
      url_host: useHostScopedRule ? normalizedHost : null,
      app_name: currentContext.app_name,
      skill_id: existingRule?.skill_id || draftConfig.hotkeys.default_skill_id,
      enabled: existingRule?.enabled ?? true,
    }
    const nextRules = [...currentRules]

    if (matchIndex >= 0) {
      nextRules[matchIndex] = nextRule
    } else {
      nextRules.push(nextRule)
    }

    setDraftConfig({
      ...draftConfig,
      hotkeys: {
        ...draftConfig.hotkeys,
        app_skill_defaults: nextRules,
      },
    })
  }

  const updateAppDomainDefault = (ruleId: string, updates: Partial<AppDomainDefault>) => {
    if (!draftConfig) return
    const nextRules = (draftConfig.domains.app_domain_defaults || []).map((rule) => (
      rule.id === ruleId ? { ...rule, ...updates } : rule
    ))

    setDraftConfig({
      ...draftConfig,
      domains: {
        ...draftConfig.domains,
        app_domain_defaults: nextRules,
      },
    })
  }

  const updateAppDomainIdentity = (
    ruleId: string,
    field: 'app_name' | 'bundle_id' | 'url_host',
    value: string,
  ) => {
    if (!draftConfig) return

    const normalizedValue = field === 'url_host'
      ? normalizeHost(value) || null
      : value.trim() || null

    const nextRules = (draftConfig.domains.app_domain_defaults || []).map((rule) => {
      if (rule.id !== ruleId) return rule
      const nextRule = {
        ...rule,
        [field]: field === 'app_name' ? value : normalizedValue,
      }
      return {
        ...nextRule,
        app_label: buildAppDomainLabel(
          field === 'app_name' ? value : nextRule.app_name,
          field === 'url_host' ? normalizedValue : nextRule.url_host,
        ),
      }
    })

    setDraftConfig({
      ...draftConfig,
      domains: {
        ...draftConfig.domains,
        app_domain_defaults: nextRules,
      },
    })
  }

  const removeAppDomainDefault = (ruleId: string) => {
    if (!draftConfig) return
    setDraftConfig({
      ...draftConfig,
      domains: {
        ...draftConfig.domains,
        app_domain_defaults: (draftConfig.domains.app_domain_defaults || []).filter((rule) => rule.id !== ruleId),
      },
    })
  }

  const addManualAppDomainDefault = () => {
    if (!draftConfig) return
    setDraftConfig({
      ...draftConfig,
      domains: {
        ...draftConfig.domains,
        app_domain_defaults: [...(draftConfig.domains.app_domain_defaults || []), createManualAppDomainDefault()],
      },
    })
  }

  const upsertCurrentFrontmostDomainDefault = () => {
    if (!draftConfig || !hasUsableAppContext(contextAccess.context)) return

    const currentContext = contextAccess.context as SmartContext
    const currentRules = draftConfig.domains.app_domain_defaults || []
    const normalizedHost = normalizeHost(currentContext.url_host)
    const useHostScopedRule = Boolean(normalizedHost)
    const matchIndex = useHostScopedRule
      ? currentRules.findIndex((rule) => hostMatches(rule.url_host, normalizedHost))
      : findMatchingAppDomainDefaultIndex(currentRules, currentContext)
    const existingRule = matchIndex >= 0 ? currentRules[matchIndex] : null
    const nextRule: AppDomainDefault = {
      id: existingRule?.id || createAppDomainDefaultId(currentContext.app_name),
      app_label: useHostScopedRule ? `${currentContext.app_name} • ${normalizedHost}` : currentContext.app_name,
      bundle_id: useHostScopedRule ? null : currentContext.bundle_id,
      url_host: useHostScopedRule ? normalizedHost : null,
      app_name: currentContext.app_name,
      domain_id: existingRule?.domain_id || 'shipping',
      enabled: existingRule?.enabled ?? true,
    }
    const nextRules = [...currentRules]

    if (matchIndex >= 0) {
      nextRules[matchIndex] = nextRule
    } else {
      nextRules.push(nextRule)
    }

    setDraftConfig({
      ...draftConfig,
      domains: {
        ...draftConfig.domains,
        app_domain_defaults: nextRules,
      },
    })
  }

  const importDomainOverlay = async (domainId: 'shipping' | 'medical') => {
    setDomainActionState({ type: 'importing', domainId, message: null, error: null })
    try {
      const picked = await window.windowControls?.pickDomainPackFile?.()
      if (!picked || picked.status === 'cancelled') {
        setDomainActionState({ type: 'idle', domainId: null, message: null, error: null })
        return
      }
      if (picked.status === 'error') {
        throw new Error(picked.message)
      }

      const parsed = JSON.parse(picked.text)
      await apiPost<{ status: string; pack: DomainPackSummary }>('/domains/import', {
        domain_id: domainId,
        overlay: parsed,
      })
      await refreshDomains()
      setDomainActionState({
        type: 'idle',
        domainId: null,
        message: `${formatDomainLabel(domainId)} overlay imported successfully.`,
        error: null,
      })
    } catch (error: unknown) {
      setDomainActionState({
        type: 'idle',
        domainId: null,
        message: null,
        error: getErrorMessage(error, 'Failed to import domain overlay.'),
      })
    }
  }

  const exportDomainOverlay = async (domainId: 'shipping' | 'medical') => {
    setDomainActionState({ type: 'exporting', domainId, message: null, error: null })
    try {
      const res = await apiGet<{ domain_id: 'shipping' | 'medical'; overlay: unknown }>(`/domains/export/${domainId}`, { timeout: 10000 })
      const serialized = JSON.stringify(res.data.overlay, null, 2)
      const savedFile = await window.windowControls?.saveDomainPackFile?.(`${domainId}-domain-overlay.json`, serialized)
      if (!savedFile || savedFile.status === 'cancelled') {
        setDomainActionState({ type: 'idle', domainId: null, message: null, error: null })
        return
      }
      if (savedFile.status === 'error') {
        throw new Error(savedFile.message)
      }
      setDomainActionState({
        type: 'idle',
        domainId: null,
        message: `${formatDomainLabel(domainId)} overlay exported.`,
        error: null,
      })
    } catch (error: unknown) {
      setDomainActionState({
        type: 'idle',
        domainId: null,
        message: null,
        error: getErrorMessage(error, 'Failed to export domain overlay.'),
      })
    }
  }

  const refreshDomains = async () => {
    const res = await apiGet<{ packs: DomainPackSummary[]; details: DomainPackDetail[] }>('/domains', { timeout: 10000 })
    setDomainPacks(res.data.packs || [])
    setDomainDetails(res.data.details || [])
  }

  const refreshWritingTools = async () => {
    const res = await apiGet<WritingToolsSnapshot>('/writing-tools', { timeout: 10000 })
    setWritingTools(res.data || EMPTY_WRITING_TOOLS)
  }

  const refreshHistory = async () => {
    const res = await apiGet<{ items: HistoryItem[] }>('/history', { timeout: 10000 })
    setHistoryItems(res.data.items || [])
  }

  const updateSensitiveTargetRule = (ruleId: string, updates: Partial<SensitiveTargetRule>) => {
    if (!draftConfig) return
    setDraftConfig({
      ...draftConfig,
      privacy: {
        ...draftConfig.privacy,
        sensitive_targets: (draftConfig.privacy.sensitive_targets || []).map((rule) => (
          rule.id === ruleId ? { ...rule, ...updates } : rule
        )),
      },
    })
  }

  const removeSensitiveTargetRule = (ruleId: string) => {
    if (!draftConfig) return
    setDraftConfig({
      ...draftConfig,
      privacy: {
        ...draftConfig.privacy,
        sensitive_targets: (draftConfig.privacy.sensitive_targets || []).filter((rule) => rule.id !== ruleId),
      },
    })
  }

  const upsertCurrentSensitiveTargetRule = () => {
    if (!draftConfig || !hasUsableAppContext(contextAccess.context)) return

    const currentContext = contextAccess.context as SmartContext
    const currentRules = draftConfig.privacy.sensitive_targets || []
    const normalizedHost = normalizeHost(currentContext.url_host)
    const useHostScopedRule = Boolean(normalizedHost)
    const matchIndex = useHostScopedRule
      ? currentRules.findIndex((rule) => hostMatches(rule.url_host, normalizedHost))
      : findMatchingSensitiveTargetIndex(currentRules, currentContext)
    const existingRule = matchIndex >= 0 ? currentRules[matchIndex] : null
    const nextRule: SensitiveTargetRule = {
      id: existingRule?.id || createSensitiveTargetRuleId(currentContext.app_name),
      app_label: useHostScopedRule ? `${currentContext.app_name} • ${normalizedHost}` : currentContext.app_name,
      bundle_id: useHostScopedRule ? null : currentContext.bundle_id,
      url_host: useHostScopedRule ? normalizedHost : null,
      app_name: currentContext.app_name,
      mode: existingRule?.mode || 'minimize_context',
      enabled: existingRule?.enabled ?? true,
    }
    const nextRules = [...currentRules]
    if (matchIndex >= 0) nextRules[matchIndex] = nextRule
    else nextRules.push(nextRule)

    setDraftConfig({
      ...draftConfig,
      privacy: {
        ...draftConfig.privacy,
        sensitive_targets: nextRules,
      },
    })
  }

  const updateDomainDetail = (
    domainId: 'shipping' | 'medical',
    updater: (current: DomainPackDetail) => DomainPackDetail,
  ) => {
    setDomainDetails((prev) => prev.map((pack) => (pack.id === domainId ? updater(pack) : pack)))
  }

  const saveDomainEditor = async (domainId: 'shipping' | 'medical') => {
    const pack = domainDetails.find((item) => item.id === domainId)
    if (!pack) return

    setDomainActionState({ type: 'saving', domainId, message: null, error: null })
    try {
      await apiPost<{ status: string; pack: DomainPackSummary }>('/domains/import', {
        domain_id: domainId,
        overlay: {
          id: pack.id,
          label: pack.label,
          description: pack.description,
          documentation_only: pack.documentation_only,
          default_intent: pack.default_intent,
          glossary: pack.overlay.glossary,
          templates: pack.overlay.templates,
          examples: pack.overlay.examples,
          styles: pack.overlay.styles,
          controls: pack.overlay.controls,
        },
      })
      await refreshDomains()
      setDomainActionState({
        type: 'idle',
        domainId: null,
        message: `${formatDomainLabel(domainId)} changes saved locally.`,
        error: null,
      })
    } catch (error: unknown) {
      setDomainActionState({
        type: 'idle',
        domainId: null,
        message: null,
        error: getErrorMessage(error, 'Failed to save domain changes.'),
      })
    }
  }

  const resetWritingToolDraft = (tab: 'dictionary' | 'replacements' | 'snippets' = activeWritingTab) => {
    setWritingToolDraft({
      source_text: '',
      canonical_text: '',
      aliases_text: '',
      replacement_text: '',
      trigger: '',
      expansion: '',
      match_type: tab === 'snippets' ? 'exact' : 'inline',
    })
    setEditingWritingToolId(null)
  }

  const beginEditWritingTool = (tool: DictionaryEntry | ReplacementEntry | SnippetEntry) => {
    setEditingWritingToolId(tool.id)
    if ('canonical_text' in tool) {
      setActiveWritingTab('dictionary')
      setWritingToolDraft({ canonical_text: tool.canonical_text, aliases_text: formatAliases(tool.aliases) })
      return
    }
    if ('replacement_text' in tool) {
      setActiveWritingTab('replacements')
      setWritingToolDraft({ source_text: tool.source_text, replacement_text: tool.replacement_text, match_type: tool.match_type })
      return
    }
    setActiveWritingTab('snippets')
    setWritingToolDraft({ trigger: tool.trigger, expansion: tool.expansion, match_type: tool.match_type })
  }

  const saveWritingTool = async () => {
    setWritingToolBusy(activeWritingTab)
    setSaveError(null)
    try {
      if (activeWritingTab === 'dictionary') {
        const payload = {
          canonical_text: writingToolDraft.canonical_text || '',
          aliases: parseAliases(writingToolDraft.aliases_text || ''),
          enabled: true,
        }
        if (editingWritingToolId) await apiPut(`/writing-tools/dictionary/${editingWritingToolId}`, payload)
        else await apiPost('/writing-tools/dictionary', payload)
      } else if (activeWritingTab === 'replacements') {
        const payload = {
          source_text: writingToolDraft.source_text || '',
          replacement_text: writingToolDraft.replacement_text || '',
          match_type: writingToolDraft.match_type || 'inline',
          enabled: true,
        }
        if (editingWritingToolId) await apiPut(`/writing-tools/replacements/${editingWritingToolId}`, payload)
        else await apiPost('/writing-tools/replacements', payload)
      } else {
        const payload = {
          trigger: writingToolDraft.trigger || '',
          expansion: writingToolDraft.expansion || '',
          match_type: writingToolDraft.match_type || 'exact',
          enabled: true,
        }
        if (editingWritingToolId) await apiPut(`/writing-tools/snippets/${editingWritingToolId}`, payload)
        else await apiPost('/writing-tools/snippets', payload)
      }
      await refreshWritingTools()
      resetWritingToolDraft()
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to save writing tool.'))
    } finally {
      setWritingToolBusy(null)
    }
  }

  const deleteWritingTool = async (tab: 'dictionary' | 'replacements' | 'snippets', id: number) => {
    setWritingToolBusy(`${tab}-${id}`)
    try {
      const base = tab === 'dictionary' ? 'dictionary' : tab
      await apiDelete(`/writing-tools/${base}/${id}`)
      await refreshWritingTools()
      if (editingWritingToolId === id) resetWritingToolDraft()
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to delete writing tool.'))
    } finally {
      setWritingToolBusy(null)
    }
  }

  const reprocessHistoryItem = async (id: number, skillId?: string) => {
    setWritingToolBusy(`history-${id}`)
    try {
      await apiPost(`/history/${id}/reprocess`, skillId ? { skill_id: skillId } : {})
      await refreshHistory()
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to reprocess this history item.'))
    } finally {
      setWritingToolBusy(null)
    }
  }

  const deleteHistoryEntry = async (id: number) => {
    setWritingToolBusy(`history-delete-${id}`)
    try {
      await apiDelete(`/history/${id}`)
      await refreshHistory()
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to delete this history item.'))
    } finally {
      setWritingToolBusy(null)
    }
  }

  const clearAllHistory = async () => {
    setResettingHistory(true)
    try {
      await apiDelete('/history')
      setHistoryItems([])
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to clear history.'))
    } finally {
      setResettingHistory(false)
    }
  }

  const reuseHistoryTranscript = async (transcript: string) => {
    try {
      await window.windowControls?.writeClipboardText?.(transcript)
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, 'Failed to copy this transcript for reuse.'))
    }
  }

  const dirty = Object.values(dirtySections).some(Boolean)
  const packagedOnboardingVisible = Boolean(
    launchContext?.is_packaged
    && !launchContext.onboarding_completed
    && !launchContext.onboarding_dismissed
  )

  useEffect(() => {
    if (draftConfig?.stt.provider !== 'mlx-whisper') return
    if (launchContext?.is_packaged) {
      void refreshRuntimeStatus()
      return
    }
    void window.windowControls?.checkMlxWhisperInstallation?.()
  }, [draftConfig?.stt.provider, launchContext?.is_packaged])

  useEffect(() => {
    if (activeStep !== 'advanced') return
    if (!draftConfig?.memory.semantic_retrieval_enabled) return
    void window.windowControls?.checkSemanticMemoryInstallation?.()
  }, [activeStep, draftConfig?.memory.semantic_retrieval_enabled])

  useEffect(() => {
    if (microphoneAccess !== 'granted') {
      autoRefreshedDevicesRef.current = false
      return
    }
    if (activeStep !== 'voice') return
    if (audioDevices.length > 0 || refreshingDevices || autoRefreshedDevicesRef.current) return

    autoRefreshedDevicesRef.current = true
    void refreshDevices()
  }, [activeStep, audioDevices.length, microphoneAccess, refreshDevices, refreshingDevices])

  if (connectionState !== 'error' && (!draftConfig || !remoteConfig || !providerModels)) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <BrandedProgressLoader
          title={bootState.label}
          subtitle={bootState.detail}
          progress={bootState.progress}
        />
      </div>
    )
  }

  if (connectionState === 'error' && (!draftConfig || !remoteConfig || !providerModels)) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <div className="w-full max-w-xl rounded-[28px] border border-semantic-error/20 bg-[linear-gradient(180deg,rgba(42,11,18,0.75),rgba(11,8,12,0.9))] p-8 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
          <div className="flex items-center gap-3 text-semantic-error">
            <ErrorIcon size={22} />
            <h1 className="text-lg font-semibold text-text-primary">{`${DISPLAY_NAME} is not ready`}</h1>
          </div>
          <p className="mt-4 text-sm leading-7 text-text-secondary">
            {`${DISPLAY_NAME} could not finish starting. If this continues, check the logs below and try again.`}
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <LogPathCard label="Backend log" path={launchContext?.log_paths.backend || BACKEND_LOG_DISPLAY_PATH} />
            <LogPathCard label="Electron log" path={launchContext?.log_paths.electron || ELECTRON_LOG_DISPLAY_PATH} />
          </div>
          <div className="mt-6 flex gap-3">
            <FooterButton tone="secondary" onClick={restartLocalEngine}>{`Restart ${DISPLAY_NAME}`}</FooterButton>
            <FooterButton onClick={() => {
              void refreshRuntimeLocalEnvironment()
              void fetchDeferred()
            }}
            >
              Try again
            </FooterButton>
          </div>
        </div>
      </div>
    )
  }

  if (!draftConfig || !remoteConfig || !providerModels) {
    return null
  }

  const llmModels = providerModels.llm?.[draftConfig.llm.provider] || []
  const visibleLlmModels = draftConfig.llm.provider === 'lmstudio'
    ? llmModels.filter((model) => model.smart_capable !== false || model.id === draftConfig.llm.model)
    : llmModels
  const displayedLlmModels = visibleLlmModels.length ? visibleLlmModels : llmModels
  const sttModels = providerModels.stt?.[draftConfig.stt.provider] || []
  const visionModels = providerModels.vision?.lmstudio || []
  const selectedVisionModel = draftConfig.vision.model || '__reuse__'
  const selectedLlmModel = llmModels.find((model) => model.id === draftConfig.llm.model) || null
  const explicitVisionModel = visionModels.find((model) => model.id === draftConfig.vision.model) || null
  const loadedVisionModelCount = visionModels.filter((model) => model.loaded !== false).length
  const selectedVisionModelUnavailable = Boolean(draftConfig.vision.model && explicitVisionModel && explicitVisionModel.loaded === false)
  const reusedVisionModelUnavailable = (
    draftConfig.vision.model == null
    && draftConfig.llm.provider === 'lmstudio'
    && Boolean(selectedLlmModel?.vision)
    && selectedLlmModel?.loaded === false
  )
  const visionAvailabilityMessage = selectedVisionModelUnavailable
    ? `${explicitVisionModel?.name || draftConfig.vision.model} is listed in LM Studio but not currently loaded. Smart vision will skip it or fall back to another loaded vision model when one is available.`
    : reusedVisionModelUnavailable
      ? `${selectedLlmModel?.name || draftConfig.llm.model} supports vision but is not currently loaded in LM Studio. Smart vision will fall back to another loaded vision model when one is available.`
      : null
  const lmStudioSmartModelCount = llmModels.filter((model) => model.smart_capable !== false).length
  const loadedLmStudioSmartModelCount = llmModels.filter((model) => model.smart_capable !== false && model.loaded !== false).length
  const selectedLmStudioModelLimited = draftConfig.llm.provider === 'lmstudio' && Boolean(selectedLlmModel) && selectedLlmModel?.smart_capable === false
  const selectedLmStudioModelNotLoaded = draftConfig.llm.provider === 'lmstudio' && Boolean(selectedLlmModel) && selectedLlmModel?.loaded === false
  const lmStudioSmartModelMessage = selectedLmStudioModelLimited
    ? `${selectedLlmModel?.name || draftConfig.llm.model} is not tagged as a strong Smart model. Use a loaded instruct or tool-use model for better prompt, coding-agent, and architect outputs.`
    : selectedLmStudioModelNotLoaded
      ? `${selectedLlmModel?.name || draftConfig.llm.model} is not currently loaded in LM Studio. Smart mode can still fail over to a weaker local model unless you load a recommended model first.`
      : draftConfig.llm.provider === 'lmstudio' && !loadedLmStudioSmartModelCount
        ? 'No recommended loaded LM Studio Smart model is available right now. Load an instruct or tool-use model in LM Studio for stronger local Smart output.'
        : null
  const activeSkill = skills.find((skill) => skill.id === draftConfig.hotkeys.default_skill_id)
  const appSkillDefaults = draftConfig.hotkeys.app_skill_defaults || []
  const appDomainDefaults = draftConfig.domains.app_domain_defaults || []
  const orderedDomainPacks = [...domainPacks].sort((left, right) => {
    const rank = { shipping: 0, medical: 1 }
    return rank[left.id] - rank[right.id]
  })
  const orderedDomainDetails = orderedDomainPacks
    .map((summary) => domainDetails.find((detail) => detail.id === summary.id))
    .filter((pack): pack is DomainPackDetail => Boolean(pack))
  const liveContextPreview = contextAccess.context || EMPTY_CONTEXT
  const canUseCurrentFrontmostApp = hasUsableAppContext(contextAccess.context)
  const hasLastCapture = Boolean(status?.captured_context_at)
  const lastCapturePreview = status?.captured_context || EMPTY_CONTEXT
  const activeStepDetail = STEP_DETAILS[activeStep]
  const configuredDevice = resolveConfiguredDevice(draftConfig.audio, audioDevices)
  const configuredDeviceLabel = configuredDevice?.label || draftConfig.audio.input_device_label || draftConfig.audio.input_device || null
  const configuredDeviceAvailable = configuredDeviceLabel ? Boolean(configuredDevice) : true
  const lastSmartRun = status?.last_smart_run
  const appliedOnboardingState = selectOnboardingState(runtime)
    ?? computeOnboardingState(remoteConfig, keysSet, microphoneAccess, accessibilityTrusted, usageStats)
  const primaryAttentionIssue = selectPrimaryAttentionIssue(runtime)
  const activeWorkState = selectActiveWorkState(runtime)
  const voiceEnvironmentPending = localEnvironment.status === 'checking'
    || (localEnvironment.status === 'verifying' && localEnvironment.verifyingTarget !== 'context')
  const privacyEnvironmentPending = localEnvironment.status === 'checking'
    || (localEnvironment.status === 'verifying' && localEnvironment.verifyingTarget === 'context')
  const hasDictationTest = appliedOnboardingState.dictationTested
  const microphoneTone = voiceEnvironmentPending
    ? 'neutral'
    : microphoneAccess === 'granted'
      ? 'good'
      : microphoneAccess === 'denied' || microphoneAccess === 'restricted'
        ? 'danger'
        : 'warn'
  const accessibilityTone = voiceEnvironmentPending
    ? 'neutral'
    : accessibilityTrusted
      ? 'good'
      : 'danger'
  const contextTone = privacyEnvironmentPending
    ? 'neutral'
    : contextAccess.status === 'full'
      ? 'good'
      : contextAccess.status === 'app-only'
        ? 'warn'
        : 'danger'
  const currentSttKeyReady = appliedOnboardingState.dictationProviderReady
  const currentLlmKeyReady = appliedOnboardingState.rewriteProviderReady
  const hasBackendAttention = activeWorkState.kind === 'attention'
  const isActiveBackendPhase = activeWorkState.kind === 'processing'
  const backendAttentionTitle = hasBackendAttention
    ? activeWorkState.label || 'Last action failed'
    : null
  const backendAttentionDetail = hasBackendAttention
    ? activeWorkState.detail || `The last voice action did not finish cleanly. Open the ${DISPLAY_NAME} logs to inspect what happened.`
    : null
  const backendTone = hasBackendAttention
    ? 'danger'
    : isActiveBackendPhase
      ? 'neutral'
      : primaryAttentionIssue
        ? primaryAttentionIssue.tone
        : 'good'
  const backendLabel = hasBackendAttention
    ? 'Last action failed'
    : isActiveBackendPhase
      ? activeWorkState.label
    : primaryAttentionIssue?.label || 'Voice ready'
  const providerLabel = !currentSttKeyReady
    ? 'Dictation provider needed'
    : !currentLlmKeyReady
      ? 'Smart provider optional'
      : 'Providers ready'
  const providerTone = !currentSttKeyReady ? 'warn' : !currentLlmKeyReady ? 'neutral' : 'good'
  const liveTranscriptionMode = draftConfig.audio.live_transcription_mode || 'auto'
  const liveTranscriptionUi = deriveLiveTranscriptionUiState({
    provider: draftConfig.stt.provider,
    rawMode: liveTranscriptionMode,
  })
  const showActionBar = dirty || saving || saved || Boolean(saveError)
  const totalUsageRuns = (usageStats?.dictation_runs || 0) + (usageStats?.smart_runs || 0)
  const hasUsageStats = totalUsageRuns > 0
  const packagedInstallReady = !launchContext?.is_packaged || launchContext.install_location === 'applications'
  const onboardingReady = appliedOnboardingState.completed && packagedInstallReady
  const rewriteFollowUpNeeded = onboardingReady && !currentLlmKeyReady
  const showPackagedOnboarding = packagedOnboardingVisible
  const onboardingStep: OnboardingStepId = !packagedInstallReady
    ? 'install'
    : !appliedOnboardingState.microphoneReady
      ? 'microphone'
      : !appliedOnboardingState.accessibilityReady
        ? 'accessibility'
        : !appliedOnboardingState.dictationProviderReady
            ? 'providers'
            : !appliedOnboardingState.dictationTested
              ? 'dictation_test'
              : 'complete'
  const onboardingStepOrder: OnboardingStepId[] = ['install', 'microphone', 'accessibility', 'providers', 'dictation_test', 'complete']
  const onboardingStepIndex = onboardingStepOrder.indexOf(onboardingStep)
  const microphoneActionLabel = microphoneAccess === 'denied' || microphoneAccess === 'restricted'
    ? 'Open Microphone Settings'
    : 'Allow microphone'
  const microphoneBadgeLabel = voiceEnvironmentPending
    ? localEnvironment.status === 'verifying'
      ? 'Verifying microphone'
      : 'Checking microphone'
    : microphoneAccess === 'granted'
      ? 'Microphone ready'
      : 'Microphone pending'
  const accessibilityBadgeLabel = voiceEnvironmentPending
    ? localEnvironment.status === 'verifying'
      ? 'Verifying Accessibility'
      : 'Checking Accessibility'
    : accessibilityTrusted
      ? 'Accessibility ready'
      : 'Accessibility pending'
  const microphonePermissionLabel = voiceEnvironmentPending
    ? localEnvironment.status === 'verifying'
      ? 'Verifying'
      : 'Checking'
    : microphoneAccess === 'granted'
      ? 'Allowed'
      : microphoneAccess
  const accessibilityPermissionLabel = voiceEnvironmentPending
    ? localEnvironment.status === 'verifying'
      ? 'Verifying'
      : 'Checking'
    : accessibilityTrusted
      ? 'Allowed'
      : 'Needs access'
  const contextStatusLabel = privacyEnvironmentPending
    ? localEnvironment.status === 'verifying'
      ? 'Verifying context'
      : 'Checking context'
    : contextAccess.status === 'full'
      ? 'Ready'
      : contextAccess.status === 'app-only'
        ? 'App only'
        : 'Unavailable'
  const onboardingStepTitles: Record<OnboardingStepId, string> = {
    install: 'Move the beta into Applications',
    microphone: 'Allow microphone access',
    accessibility: 'Enable Accessibility access',
    providers: 'Configure a dictation provider',
    dictation_test: 'Test dictation once',
    complete: 'Finish setup',
  }
  const onboardingStepDescriptions: Record<OnboardingStepId, string> = {
    install: 'Website builds should be opened from the DMG once, moved into /Applications, then reopened from /Applications before you trust the final setup state.',
    microphone: 'Allow microphone access so Dictate and Smart can record.',
    accessibility: 'Enable Accessibility for shortcuts and reliable paste handoff.',
    providers: 'Choose one working speech provider. Use the bundled local path first when it is already ready; otherwise Groq is the simplest cloud path because it can also unlock Smart later.',
    dictation_test: 'Run one real Dictate pass so you know capture, transcription, and paste are working end to end.',
    complete: 'Dictation is ready. Smart is optional and can be added next.',
  }
  const microphoneDetail = 'This reflects the live macOS permission used by the app for recording.'
  const microphoneDeviceHint = configuredDeviceLabel && !configuredDeviceAvailable
    ? `The saved input device "${configuredDeviceLabel}" is not available right now. ${DISPLAY_NAME} will fall back to the system default microphone if the selected device stays silent.`
    : null
  const selectedSttModel = sttModels.find((model) => model.id === draftConfig.stt.model) || null
  const usingMlxWhisper = draftConfig.stt.provider === 'mlx-whisper'
  const usingTinyMlxModel = draftConfig.stt.model === 'mlx-community/whisper-tiny'
  const usingHeavyMlxModel = draftConfig.stt.model === 'mlx-community/whisper-large-v3-turbo'
  const packagedLocalSttStatus = launchContext?.is_packaged ? status?.local_stt ?? null : null
  const packagedLocalSttBadgeLabel = !packagedLocalSttStatus
    ? 'Checking runtime'
    : !packagedLocalSttStatus.runtime_ready
      ? 'Bundled runtime missing'
      : !packagedLocalSttStatus.ffmpeg_available
        ? 'ffmpeg missing'
        : packagedLocalSttStatus.ffmpeg_source === 'system'
          ? 'System ffmpeg fallback'
          : packagedLocalSttStatus.selected_model_ready
            ? 'Bundled local speech ready'
            : 'Model downloads on first use'
  const packagedLocalSttBadgeTone = !packagedLocalSttStatus
    ? 'neutral'
    : !packagedLocalSttStatus.runtime_ready || !packagedLocalSttStatus.ffmpeg_available
      ? 'danger'
      : packagedLocalSttStatus.ffmpeg_source === 'system' || !packagedLocalSttStatus.selected_model_ready
        ? 'warn'
        : 'good'
  const sttLanguageOptions = buildLanguageOptions([draftConfig.stt.language, ...draftConfig.stt.preferred_languages])
  const primaryAutoLanguage = draftConfig.stt.preferred_languages[0] || draftConfig.stt.language || 'en'
  const autoSecondaryLanguages = draftConfig.stt.preferred_languages.filter((code) => code !== primaryAutoLanguage)
  const historySkillOptions = skills.filter((skill) => skill.id !== 'system_dictation')
  const sectionSummaries: Record<StepId, string> = {
    voice: `${draftConfig.stt.provider} • ${configuredDeviceLabel || 'System mic'}`,
    rewrite: `${draftConfig.llm.provider} • ${activeSkill?.name || 'No template selected'}`,
    privacy: contextAccess.status === 'full' ? 'Context ready' : contextAccess.status === 'app-only' ? 'App-only context' : 'Context limited',
    advanced: 'Actions, domains, history, and logs',
  }
  const activeStepDeferredMessages = (
    activeStep === 'voice'
      ? [deferredErrors.audioDevices, deferredErrors.usage]
      : activeStep === 'rewrite'
        ? [deferredErrors.skills]
        : activeStep === 'privacy'
          ? []
          : [deferredErrors.domains, deferredErrors.history, deferredErrors.writingTools, deferredErrors.usage]
  ).filter((value): value is string => Boolean(value))

  const resolveHistorySkillSelection = (item: HistoryItem) => (
    historySkillSelections[item.id]
    || item.telemetry.skill_used?.id
    || (draftConfig.hotkeys.default_skill_id !== 'system_dictation' ? draftConfig.hotkeys.default_skill_id : null)
    || historySkillOptions[0]?.id
    || 'system_grammar'
  )

  const setSttLanguageMode = (mode: 'fixed' | 'auto') => {
    setDraftConfig({
      ...draftConfig,
      stt: {
        ...draftConfig.stt,
        language_mode: mode,
        preferred_languages: mode === 'auto'
          ? (draftConfig.stt.preferred_languages.length
            ? draftConfig.stt.preferred_languages
            : [draftConfig.stt.language || 'en'])
          : draftConfig.stt.preferred_languages,
      },
    })
  }

  const updateFixedLanguage = (language: string) => {
    const nextPreferred = draftConfig.stt.preferred_languages.includes(language)
      ? draftConfig.stt.preferred_languages
      : [language, ...draftConfig.stt.preferred_languages]

    setDraftConfig({
      ...draftConfig,
      stt: {
        ...draftConfig.stt,
        language,
        preferred_languages: nextPreferred,
      },
    })
  }

  const updatePrimaryAutoLanguage = (language: string) => {
    const remaining = draftConfig.stt.preferred_languages.filter((code) => code !== language)
    setDraftConfig({
      ...draftConfig,
      stt: {
        ...draftConfig.stt,
        preferred_languages: [language, ...remaining],
      },
    })
  }

  const toggleAutoSecondaryLanguage = (language: string) => {
    if (language === primaryAutoLanguage) return

    const remaining = draftConfig.stt.preferred_languages.filter((code) => code !== primaryAutoLanguage && code !== language)
    const nextSecondary = autoSecondaryLanguages.includes(language)
      ? remaining
      : [...remaining, language]

    setDraftConfig({
      ...draftConfig,
      stt: {
        ...draftConfig.stt,
        preferred_languages: [primaryAutoLanguage, ...nextSecondary],
      },
    })
  }


  return (
    <motion.div
      className="relative flex h-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="soft-divider border-b px-6 py-3.5 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-text-muted">Settings</div>
            <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.03em] text-text-primary">Settings</h1>
            <p className="mt-1 max-w-xl text-[13px] leading-5 text-text-secondary">Voice, Smart, privacy, and advanced controls.</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge label={backendLabel} tone={backendTone} />
            <StatusBadge label={providerLabel} tone={providerTone} />
          </div>
        </div>
        {hasBackendAttention ? (
          <div className="mt-4 rounded-[22px] border border-semantic-error/18 bg-[linear-gradient(180deg,rgba(57,17,23,0.56),rgba(21,12,16,0.84))] px-4 py-3.5 shadow-[0_14px_40px_rgba(0,0,0,0.2)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-semantic-error">
                  <WarningIcon size={16} />
                  <p className="text-sm font-semibold text-text-primary">{backendAttentionTitle}</p>
                </div>
                <p className="mt-1.5 text-sm leading-6 text-text-secondary">
                  {backendAttentionDetail}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <FooterButton tone="secondary" size="compact" onClick={() => void window.windowControls?.openLogsDirectory?.()}>
                  Open logs
                </FooterButton>
                <FooterButton size="compact" onClick={restartLocalEngine}>
                  Restart backend
                </FooterButton>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-6 py-4 lg:px-8">
        <div className="mx-auto flex h-full max-w-7xl gap-4">
          <aside
            className={`settings-sidebar flex shrink-0 flex-col overflow-hidden rounded-[24px] border border-white/7 p-2.5 transition-[width] duration-200 ${sidebarCollapsed ? 'w-[82px]' : 'w-[254px]'
              }`}
          >
            <div className={`mb-2 flex items-center ${sidebarCollapsed ? 'justify-center' : 'justify-between'} gap-2 px-2`}>
              {!sidebarCollapsed ? (
                <div>
                  <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Sections</div>
                  <div className="mt-1 text-sm font-medium text-text-primary">Settings</div>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setSidebarCollapsed((current) => !current)}
                className="settings-sidebar-toggle flex h-9 w-9 items-center justify-center rounded-full border border-white/8 text-text-secondary transition-colors hover:bg-white/[0.06] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#091018]"
                title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <ArrowRightIcon
                  size={14}
                  className={`transition-transform ${sidebarCollapsed ? 'rotate-0' : 'rotate-180'}`}
                />
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-1.5">
              {STEPS.map((step) => (
                <SidebarSectionButton
                  key={step.id}
                  active={activeStep === step.id}
                  collapsed={sidebarCollapsed}
                  icon={
                    step.id === 'voice' ? <MicIcon size={15} /> :
                      step.id === 'rewrite' ? <SparkIcon size={15} /> :
                        step.id === 'privacy' ? <ShieldIcon size={15} /> :
                          <RefreshIcon size={15} />
                  }
                  label={step.label}
                  summary={sectionSummaries[step.id]}
                  onClick={() => navigateToStep(step.id)}
                />
              ))}
            </div>

          </aside>

          <div className="settings-content-shell min-w-0 flex-1 overflow-hidden rounded-[26px] border border-white/7">
            <div className={`h-full overflow-y-auto px-1 ${showActionBar ? 'pb-8' : 'pb-0'}`}>
              <div className="flex flex-col gap-4 px-4 py-3.5 lg:px-5">
                <section className="section-intro-panel rounded-[20px] border border-white/6 px-4 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">{STEPS.find((step) => step.id === activeStep)?.eyebrow}</div>
                      <div className="mt-1 text-[15px] font-semibold tracking-[-0.02em] text-text-primary">{activeStepDetail.title}</div>
                    </div>
                    <StatusBadge label={STEPS.find((step) => step.id === activeStep)?.label || 'Section'} tone="neutral" />
                  </div>
                </section>

                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={activeStep}
                    initial={{ opacity: 0, x: 14 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={STEP_MOTION}
                    className="flex flex-col gap-5"
                  >
                    {activeStepDeferredMessages.length ? (
                      <section className="rounded-[22px] border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Partial refresh</div>
                            <div className="mt-1 text-sm font-medium text-text-primary">Some section data is temporarily stale</div>
                            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
                              {activeStepDeferredMessages.join(' ')}
                            </p>
                          </div>
                          <FooterButton tone="secondary" onClick={() => void fetchDeferred(true)}>Refresh section</FooterButton>
                        </div>
                      </section>
                    ) : null}
                    {activeStep === 'voice' ? (
                      <>
                        {showPackagedOnboarding ? (
                          <SectionCard
                            title="Getting started"
                            icon={<SetupIcon size={18} />}
                            description="Get to the first successful dictation before you worry about advanced setup."
                            action={<StatusBadge label={onboardingReady ? 'Dictation ready' : `Step ${Math.min(onboardingStepIndex + 1, 5)} of 5`} tone={onboardingReady ? 'good' : 'warn'} />}
                          >
                            <div className="grid gap-4 xl:grid-cols-[0.92fr_1.28fr]">
                              <div className="grid gap-3">
                                {(['install', 'microphone', 'accessibility', 'providers', 'dictation_test'] as OnboardingStepId[]).map((stepId, index) => {
                                  const completed = onboardingStepOrder.indexOf(stepId) < onboardingStepIndex
                                  const active = onboardingStep === stepId
                                  const tone = completed ? 'good' : active ? 'warn' : 'neutral'
                                  return (
                                    <div
                                      key={stepId}
                                      className={`rounded-2xl border px-4 py-3 ${active ? 'border-accent-primary/20 bg-accent-primary/10' : 'border-white/6 bg-white/[0.02]'}`}
                                    >
                                      <div className="flex items-center justify-between gap-3">
                                        <div>
                                          <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Step {index + 1}</div>
                                          <div className="mt-1.5 text-sm font-medium text-text-primary">{onboardingStepTitles[stepId]}</div>
                                        </div>
                                        <StatusBadge label={completed ? 'Done' : active ? 'In progress' : 'Up next'} tone={tone} />
                                      </div>
                                    </div>
                                  )
                                })}

                                <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                  <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Recommended path</div>
                                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                                    If the bundled local speech path is already ready, start there. Otherwise Groq is the shortest cloud setup because one key can cover both Dictate and Smart later.
                                  </p>
                                </div>
                              </div>

                              <div className="rounded-[24px] border border-white/7 bg-black/18 p-5">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div>
                                    <div className="text-[11px] uppercase tracking-[0.26em] text-text-muted">
                                      {onboardingStep === 'complete' ? 'Ready to go' : `Current step • ${Math.min(onboardingStepIndex + 1, 5)} of 5`}
                                    </div>
                                    <h3 className="mt-2 text-lg font-semibold text-text-primary">{onboardingStepTitles[onboardingStep]}</h3>
                                    <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">{onboardingStepDescriptions[onboardingStep]}</p>
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    <StatusBadge label="Public beta" tone="neutral" />
                                    <StatusBadge label={microphoneBadgeLabel} tone={microphoneTone} />
                                    <StatusBadge label={accessibilityBadgeLabel} tone={accessibilityTone} />
                                    <StatusBadge label={currentSttKeyReady ? 'Dictation provider ready' : 'Provider setup needed'} tone={currentSttKeyReady ? 'good' : 'warn'} />
                                  </div>
                                </div>

                                {launchContext?.should_prompt_move_to_applications ? (
                                  <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 p-4">
                                    <div className="text-sm font-medium text-text-primary">Move the app to Applications before finishing setup</div>
                                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                                      {DISPLAY_NAME} is running from {launchContext.install_location === 'disk_image' ? 'the mounted DMG' : 'outside /Applications'}. Drag it into <span className="font-medium text-text-primary">Applications</span>, then reopen it from there so permissions and helper paths stay stable for the unsigned beta.
                                    </p>
                                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                                      First launch on macOS may require the usual unsigned-beta workaround: open the app once from Finder, confirm the system prompt, then continue setup from the copy in Applications.
                                    </p>
                                    <div className="mt-4 flex flex-wrap gap-3">
                                      <FooterButton tone="secondary" onClick={() => window.windowControls?.revealAppInFinder?.()}>Reveal current app</FooterButton>
                                      <FooterButton tone="secondary" onClick={() => window.windowControls?.openApplicationsFolder?.()}>Open Applications</FooterButton>
                                    </div>
                                  </div>
                                ) : null}

                                {onboardingStep === 'install' ? (
                                  <div className="mt-5 space-y-4">
                                    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                      <div className="text-sm font-medium text-text-primary">Install location</div>
                                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                                        Current location: <span className="font-medium text-text-primary">{launchContext?.install_location === 'disk_image' ? 'Mounted DMG' : launchContext?.install_location === 'other' ? 'Outside /Applications' : launchContext?.install_location === 'applications' ? '/Applications' : 'Development'}</span>.
                                      </p>
                                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                                        Finish the beta funnel only after reopening the app from <span className="font-medium text-text-primary">/Applications</span>.
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                      <FooterButton tone="secondary" onClick={() => window.windowControls?.revealAppInFinder?.()}>Reveal current app</FooterButton>
                                      <FooterButton tone="secondary" onClick={() => window.windowControls?.openApplicationsFolder?.()}>Open Applications</FooterButton>
                                    </div>
                                  </div>
                                ) : null}

                                {onboardingStep === 'microphone' ? (
                                  <div className="mt-5 space-y-4">
                                    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                      <div className="text-sm font-medium text-text-primary">Microphone status</div>
                                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                                        macOS status: <span className="font-medium text-text-primary">{microphoneAccess}</span>.
                                      </p>
                                      <p className="mt-2 text-sm leading-6 text-text-secondary">{microphoneDetail}</p>
                                      {microphoneDeviceHint ? <p className="mt-2 text-sm leading-6 text-semantic-warning">{microphoneDeviceHint}</p> : null}
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                      <FooterButton onClick={requestMicrophone}>{microphoneActionLabel}</FooterButton>
                                      <FooterButton tone="secondary" onClick={() => openPrivacySettings('microphone')}>Open Microphone Settings</FooterButton>
                                    </div>
                                  </div>
                                ) : null}

                                {onboardingStep === 'accessibility' ? (
                                  <div className="mt-5 space-y-4">
                                    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                      <div className="text-sm font-medium text-text-primary">Accessibility status</div>
                                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                                        Accessibility is currently <span className="font-medium text-text-primary">{accessibilityTrusted ? 'enabled' : 'not enabled'}</span>. {DISPLAY_NAME} uses it for global shortcuts and reliable paste handoff.
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                      <FooterButton onClick={requestAccessibility}>Enable Accessibility</FooterButton>
                                      <FooterButton tone="secondary" onClick={() => openPrivacySettings('accessibility')}>Open Accessibility Settings</FooterButton>
                                    </div>
                                  </div>
                                ) : null}

                                {onboardingStep === 'providers' ? (
                                  <div className="mt-5 space-y-4">
                                    <ProviderLaneSummaryPanel
                                      title="Active provider"
                                      items={[
                                        {
                                          laneLabel: 'Dictate',
                                          providerId: draftConfig.stt.provider,
                                          modelLabel: draftConfig.stt.model,
                                        },
                                      ]}
                                    />
                                    <ApiKeyWorkbench
                                      apiProvider={apiProvider}
                                      apiKey={apiKey}
                                      keysSet={keysSet}
                                      keyStatus={keyStatus}
                                      providerIntro="Save a cloud speech provider key here without changing the active Dictate provider. This keeps setup predictable during onboarding."
                                      onProviderSelect={(provider) => {
                                        setApiProvider(provider)
                                      }}
                                      onApiKeyChange={setApiKey}
                                      onSave={saveApiKey}
                                      onClear={clearApiKey}
                                    />
                                  </div>
                                ) : null}

                                {onboardingStep === 'dictation_test' ? (
                                  <div className="mt-5 space-y-4">
                                    <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                      <div className="text-sm font-medium text-text-primary">Quick test</div>
                                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                                        Use Voice Preview below or start a live Dictate pass from the Home screen. Once a transcript comes through, setup is complete.
                                      </p>
                                      {hasDictationTest ? (
                                        <div className="mt-3 rounded-2xl border border-semantic-success/20 bg-semantic-success/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                                          Dictation test captured successfully.
                                        </div>
                                      ) : null}
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                      <FooterButton onClick={testRecording ? stopTestRecording : startTestRecording}>
                                        {testRecording ? 'Stop voice preview' : 'Start voice preview'}
                                      </FooterButton>
                                      <FooterButton tone="secondary" onClick={() => void window.windowControls?.toggleRecording?.('dictation')}>
                                        Start Dictate
                                      </FooterButton>
                                    </div>
                                    {testResult ? (
                                      <div className="rounded-2xl border border-white/6 bg-black/30 p-4">
                                        {testResult.error ? (
                                          <div className="text-sm text-semantic-error">{testResult.error}</div>
                                        ) : (
                                          <pre className="whitespace-pre-wrap text-sm leading-7 text-text-primary">{testResult.transcript || 'No speech detected.'}</pre>
                                        )}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}

                                {onboardingStep === 'complete' ? (
                                  <div className="mt-5 space-y-4">
                                    <div className="rounded-2xl border border-semantic-success/20 bg-semantic-success/8 p-4">
                                      <div className="text-sm font-medium text-text-primary">Dictation is ready</div>
                                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                                        You can start Dictate right away. Smart can be unlocked any time from the next section.
                                      </p>
                                    </div>
                                  </div>
                                ) : null}

                                {rewriteFollowUpNeeded ? (
                                  <div className="mt-5 rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                      <div>
                                        <div className="text-sm font-medium text-text-primary">Optional next step: unlock Smart</div>
                                        <p className="mt-2 text-sm leading-6 text-text-secondary">
                                          Add an LLM provider when you want summarized notes, drafted replies, and reusable templates.
                                        </p>
                                      </div>
                                      <FooterButton tone="secondary" onClick={() => navigateToStep('rewrite')}>Open Smart settings</FooterButton>
                                    </div>
                                  </div>
                                ) : null}

                                {launchContext?.onboarding_blocker ? (
                                  <div className="mt-5 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                                    {launchContext.onboarding_blocker}
                                  </div>
                                ) : null}

                                <div className="mt-5 flex flex-wrap gap-3">
                                  <FooterButton tone="secondary" onClick={dismissPackagedOnboarding}>Continue later</FooterButton>
                                  <FooterButton onClick={completePackagedOnboarding} disabled={!onboardingReady}>
                                    {onboardingReady ? 'Finish setup' : 'Finish after install and dictation'}
                                  </FooterButton>
                                </div>
                              </div>
                            </div>
                          </SectionCard>
                        ) : (
                          <>
                            <SectionCard
                              title="Readiness"
                              icon={<ShieldIcon size={18} />}
                              description="Quick access status for dictation."
                            >
                              <div className="grid gap-4 lg:grid-cols-3">
                                <PermissionCard
                                  title="Microphone"
                                  subtitle="Needed to record."
                                  statusLabel={microphonePermissionLabel}
                                  tone={microphoneTone}
                                  action={microphoneAccess !== 'granted' ? <FooterButton onClick={requestMicrophone}>{microphoneActionLabel}</FooterButton> : undefined}
                                />
                                <PermissionCard
                                  title="Accessibility"
                                  subtitle="Needed for shortcuts and paste."
                                  statusLabel={accessibilityPermissionLabel}
                                  tone={accessibilityTone}
                                  action={!accessibilityTrusted ? <FooterButton onClick={requestAccessibility}>Enable accessibility</FooterButton> : undefined}
                                />
                                <PermissionCard
                                  title="Dictation provider"
                                  subtitle="Needed for live speech recognition."
                                  statusLabel={currentSttKeyReady ? `${draftConfig.stt.provider} ready` : `${draftConfig.stt.provider} needs setup`}
                                  tone={currentSttKeyReady ? 'good' : 'warn'}
                                  action={!currentSttKeyReady && isApiKeyProviderId(draftConfig.stt.provider)
                                    ? <FooterButton size="compact" onClick={() => setApiProvider(draftConfig.stt.provider as ApiKeyProviderId)}>Add key</FooterButton>
                                    : undefined}
                                />
                              </div>
                              {microphoneDeviceHint ? (
                                <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                                  {microphoneDeviceHint}
                                </div>
                              ) : null}
                            </SectionCard>

                            <SectionCard
                              title="Active providers"
                              icon={<InfoIcon size={18} />}
                              description="Current provider and model for Dictate and Smart."
                            >
                              <ProviderLaneSummaryPanel
                                title="Current lanes"
                                items={[
                                  {
                                    laneLabel: 'Dictate',
                                    providerId: draftConfig.stt.provider,
                                    modelLabel: draftConfig.stt.model,
                                  },
                                  {
                                    laneLabel: 'Smart',
                                    providerId: draftConfig.llm.provider,
                                    modelLabel: draftConfig.llm.model,
                                  },
                                ]}
                              />
                            </SectionCard>

                            <SectionCard
                              title="Provider access"
                              icon={<KeyIcon size={18} />}
                              description="Save the keys used for cloud dictation and Smart."
                            >
                              <ApiKeyWorkbench
                                apiProvider={apiProvider}
                                apiKey={apiKey}
                                keysSet={keysSet}
                                keyStatus={keyStatus}
                                providerIntro="Store one cloud provider key at a time. Saving a key prepares that provider for later, but it does not change your current Dictate or Smart defaults."
                                onProviderSelect={setApiProvider}
                                onApiKeyChange={setApiKey}
                                onSave={saveApiKey}
                                onClear={clearApiKey}
                              />
                            </SectionCard>
                          </>
                        )}
                      </>
                    ) : null}

                    {activeStep === 'voice' ? (
                      <>
                        <SectionCard
                          title="Speech recognition"
                          icon={<WaveIcon size={18} />}
                          description="Choose the provider and model that power Dictate."
                        >
                          <div className="grid gap-5">
                            <ProviderPicker
                              label="STT provider"
                              value={draftConfig.stt.provider}
                              options={PROVIDERS.stt}
                              availableKeys={keysSet}
                              onChange={(provider) => updateProvider('stt', provider)}
                            />

                            <div>
                              <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">STT model</label>
                              <select
                                className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                value={draftConfig.stt.model}
                                onChange={(event) => setDraftConfig({ ...draftConfig, stt: { ...draftConfig.stt, model: event.target.value } })}
                              >
                                {sttModels.map((model) => (
                                  <option key={model.id} value={model.id}>{model.name}</option>
                                ))}
                              </select>
                            </div>

                            <div className="grid gap-5 lg:grid-cols-2">
                              <div>
                                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Recognition mode</label>
                                <select
                                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                  value={draftConfig.stt.language_mode}
                                  onChange={(event) => setSttLanguageMode(event.target.value as 'fixed' | 'auto')}
                                >
                                  <option value="fixed">One language</option>
                                  <option value="auto">Auto detect</option>
                                </select>
                              </div>
                              <div>
                                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">
                                  {draftConfig.stt.language_mode === 'auto' ? 'Main fallback language' : 'Main language'}
                                </label>
                                <select
                                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                  value={draftConfig.stt.language_mode === 'auto' ? primaryAutoLanguage : draftConfig.stt.language}
                                  onChange={(event) => {
                                    if (draftConfig.stt.language_mode === 'auto') {
                                      updatePrimaryAutoLanguage(event.target.value)
                                      return
                                    }
                                    updateFixedLanguage(event.target.value)
                                  }}
                                >
                                  {sttLanguageOptions.map((option) => (
                                    <option key={option.code} value={option.code}>{option.label}</option>
                                  ))}
                                </select>
                              </div>
                            </div>

                            {draftConfig.stt.language_mode === 'auto' ? (
                              <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div>
                                    <div className="text-sm font-medium text-text-primary">Also expect</div>
                                    <p className="mt-1.5 text-sm leading-6 text-text-secondary">
                                      Pick a few other languages you switch between often.
                                    </p>
                                  </div>
                                  <StatusBadge label={formatLanguageLabel(primaryAutoLanguage)} tone="neutral" />
                                </div>
                                <div className="mt-4 flex flex-wrap gap-2">
                                  {sttLanguageOptions.filter((option) => option.code !== primaryAutoLanguage).map((option) => {
                                    const selected = autoSecondaryLanguages.includes(option.code)
                                    return (
                                      <button
                                        key={option.code}
                                        type="button"
                                        onClick={() => toggleAutoSecondaryLanguage(option.code)}
                                        className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${selected
                                          ? 'border-white/14 bg-white/[0.08] text-text-primary'
                                          : 'border-white/8 bg-white/[0.03] text-text-secondary hover:border-white/12 hover:bg-white/[0.05] hover:text-text-primary'
                                          }`}
                                      >
                                        {option.label}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            ) : null}

                            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-6 text-text-secondary">
                              {draftConfig.stt.language_mode === 'auto'
                                ? `Auto detect uses the speech provider when it supports language detection. If not, ${DISPLAY_NAME} falls back to your main language first.`
                                : 'One language keeps recognition locked to the language you choose above.'}
                            </div>

                            {usingMlxWhisper ? (
                              <div className="space-y-3">
                                <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                      <div className="text-sm font-medium text-text-primary">Local STT requirements</div>
                                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                                        {launchContext?.is_packaged
                                          ? `${DISPLAY_NAME} ships local speech with the app bundle, then downloads the selected model into app-managed storage on first use if it is not already present.`
                                          : `MLX Whisper runs fully on your Mac and is installed only into ${DISPLAY_NAME}'s backend virtualenv.`}
                                      </p>
                                    </div>
                                    <StatusBadge
                                      label={launchContext?.is_packaged
                                        ? packagedLocalSttBadgeLabel
                                        : (
                                          mlxInstallState.installed
                                            ? (mlxInstallState.ffmpeg_available ? 'Installed locally' : 'Needs ffmpeg')
                                            : mlxInstallState.supported ? 'Optional add-on' : 'Unsupported'
                                        )}
                                      tone={launchContext?.is_packaged
                                        ? packagedLocalSttBadgeTone
                                        : (
                                          mlxInstallState.installed
                                            ? (mlxInstallState.ffmpeg_available ? 'good' : 'warn')
                                            : mlxInstallState.supported ? 'warn' : 'danger'
                                        )}
                                    />
                                  </div>
                                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                    <ContextField label="Apple Silicon" value={launchContext?.is_packaged ? 'Ready' : (mlxInstallState.supported ? 'Ready' : 'Not supported')} />
                                    {launchContext?.is_packaged ? (
                                      <>
                                        <ContextField label="Bundled runtime" value={packagedLocalSttStatus?.runtime_ready ? 'Ready' : 'Missing'} />
                                        <ContextField
                                          label="ffmpeg"
                                          value={
                                            !packagedLocalSttStatus
                                              ? 'Checking'
                                              : packagedLocalSttStatus.ffmpeg_source === 'bundled'
                                                ? 'Bundled'
                                                : packagedLocalSttStatus.ffmpeg_source === 'system'
                                                  ? 'System fallback'
                                                  : 'Missing'
                                          }
                                        />
                                        <ContextField label="Selected model" value={packagedLocalSttStatus?.selected_model_ready ? 'Ready' : 'Downloads on first use'} />
                                      </>
                                    ) : (
                                      <>
                                        <ContextField label="Backend .venv" value={mlxInstallState.venv_available ? 'Available' : 'Missing'} />
                                        <ContextField label="MLX runtime" value={mlxInstallState.installed ? 'Installed' : 'Not installed'} />
                                        <ContextField label="ffmpeg" value={mlxInstallState.ffmpeg_available ? 'Available' : 'Required'} />
                                      </>
                                    )}
                                    <ContextField label="First use" value="Model downloads on first transcription into app-managed storage" />
                                  </div>
                                  <div className="mt-4 text-sm leading-6 text-text-secondary">
                                    {launchContext?.is_packaged
                                      ? packagedLocalSttStatus?.detail || 'Checking bundled local speech runtime.'
                                      : mlxInstallState.detail}
                                  </div>
                                  {launchContext?.is_packaged ? (
                                    <div className="mt-4 flex flex-wrap gap-3">
                                      <FooterButton tone="secondary" onClick={() => void refreshRuntimeStatus()}>
                                        Refresh local speech status
                                      </FooterButton>
                                    </div>
                                  ) : mlxInstallState.can_install ? (
                                    <div className="mt-4 flex flex-wrap gap-3">
                                      <FooterButton onClick={() => void window.windowControls?.installMlxWhisper?.()}>
                                        Install MLX Whisper
                                      </FooterButton>
                                      <FooterButton tone="secondary" onClick={() => void window.windowControls?.checkMlxWhisperInstallation?.()}>
                                        Refresh local status
                                      </FooterButton>
                                    </div>
                                  ) : null}
                                  {!launchContext?.is_packaged && mlxInstallState.installed && !mlxInstallState.ffmpeg_available ? (
                                    <div className="mt-4 flex flex-wrap gap-3">
                                      <FooterButton tone="secondary" size="compact" onClick={() => void window.windowControls?.writeClipboardText?.('brew install ffmpeg')}>
                                        Copy ffmpeg install command
                                      </FooterButton>
                                    </div>
                                  ) : null}
                                  {!launchContext?.is_packaged && mlxInstallState.phase !== 'idle' && mlxInstallState.phase !== 'ready' ? (
                                    <div className="mt-5 rounded-2xl border border-white/6 bg-black/20 p-4">
                                      <BrandedProgressLoader
                                        compact
                                        title={mlxInstallState.label}
                                        subtitle={mlxInstallState.detail}
                                        progress={mlxInstallState.progress}
                                      />
                                    </div>
                                  ) : null}
                                  {!launchContext?.is_packaged && (mlxInstallState.logs.length > 0 || mlxInstallState.phase === 'error') ? (
                                    <div className="mt-4">
                                      <FooterButton tone="secondary" size="compact" onClick={() => setShowMlxLogs((value) => !value)}>
                                        {showMlxLogs ? 'Hide install logs' : 'Show install logs'}
                                      </FooterButton>
                                      {showMlxLogs ? (
                                        <div className="mt-3 rounded-2xl border border-white/6 bg-black/35 p-4">
                                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-text-secondary">
                                            {mlxInstallState.logs.join('\n') || 'No install logs yet.'}
                                          </pre>
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                                <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-6 text-text-secondary">
                                  {selectedSttModel
                                      ? `${selectedSttModel.name} is selected. ${launchContext?.is_packaged
                                        ? 'The packaged app ships the local runtime, and the model downloads into app-managed storage on first use if needed.'
                                        : `If MLX Whisper is not installed in the backend virtualenv, Voice Preview and Dictate will show a controlled local-runtime error instead of crashing. Downloaded local speech models are now stored under ${DISPLAY_NAME}'s app data instead of the shared Hugging Face cache.`}`
                                      : 'Select a local MLX Whisper model to use optional on-device speech recognition.'}
                                </div>
                                {usingTinyMlxModel ? (
                                  <div className="rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 p-4 text-sm leading-6 text-text-secondary">
                                    Whisper Tiny is the fastest local option, but it is less accurate for short commands and Smart requests. Whisper Base is the recommended local default.
                                  </div>
                                ) : null}
                                {usingHeavyMlxModel ? (
                                  <div className="rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 p-4 text-sm leading-6 text-text-secondary">
                                    Whisper Turbo is the heaviest local option. Expect a larger first download, slower initial setup, and higher memory use than Tiny or Base.
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </SectionCard>

                        <SectionCard
                          title="Microphone source"
                          icon={<MicIcon size={18} />}
                          description="Pick the default input device for Dictate and Smart. Refresh after plugging in a new microphone."
                          action={
                            <div className="flex items-center gap-2">
                              <StatusBadge label={audioDevices.length ? `${audioDevices.length} devices found` : 'System default only'} tone={audioDevices.length ? 'good' : 'warn'} />
                              <button
                                type="button"
                                onClick={refreshDevices}
                                className="inline-flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-white/[0.06] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#091018]"
                              >
                                <RefreshIcon size={14} className={refreshingDevices ? 'animate-spin' : ''} />
                                Refresh
                              </button>
                            </div>
                          }
                        >
                          <select
                            className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                            value={configuredDevice?.id || ''}
                            onChange={(event) => setDraftConfig({
                              ...draftConfig,
                              audio: {
                                ...draftConfig.audio,
                                input_device_id: event.target.value || null,
                                input_device_label: audioDevices.find((device) => device.id === event.target.value)?.label || null,
                                input_device: audioDevices.find((device) => device.id === event.target.value)?.label || null,
                              },
                            })}
                          >
                            <option value="">System default microphone</option>
                            {audioDevices.map((device) => (
                              <option key={device.id} value={device.id}>
                                {device.label}{device.is_default ? ' (Default)' : ''}
                              </option>
                            ))}
                          </select>
                          {audioDevices.length === 0 ? (
                            <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                              {`Only the fallback system microphone is available right now. ${DISPLAY_NAME} now refreshes the device list automatically after microphone access is granted, but you can also use Refresh if you just plugged in a device.`}
                            </div>
                          ) : null}
                        </SectionCard>

                        <SectionCard
                          title="Voice preview"
                          icon={<CheckIcon size={18} />}
                          description="Preview transcription without pasting anything."
                        >
                          <div className="flex flex-wrap items-center gap-3">
                            <FooterButton onClick={testRecording ? stopTestRecording : startTestRecording}>
                              {testRecording ? 'Stop and preview' : 'Start voice preview'}
                            </FooterButton>
                            <StatusBadge label={testRecording ? 'Listening' : 'Idle'} tone={testRecording ? 'warn' : 'neutral'} />
                          </div>

                          {testResult ? (
                            <div className="mt-5 rounded-2xl border border-white/6 bg-black/30 p-4">
                              {testResult.error ? (
                                <div className="space-y-3">
                                  <div className="text-sm text-semantic-error">{testResult.error}</div>
                                  {testResult.fallback_notice ? (
                                    <div className="text-sm text-semantic-warning">{testResult.fallback_notice}</div>
                                  ) : null}
                                </div>
                              ) : (
                                <>
                                  <div className="flex items-center justify-between gap-3 border-b border-white/6 pb-3 text-sm text-text-secondary">
                                    <span>Latest preview</span>
                                    <span>{testResult.time}s</span>
                                  </div>
                                  {testResult.fallback_notice ? (
                                    <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-3 py-2 text-sm text-text-secondary">
                                      {testResult.fallback_notice}
                                    </div>
                                  ) : null}
                                  <pre className="mt-4 whitespace-pre-wrap text-sm leading-7 text-text-primary">{testResult.transcript || 'No speech detected.'}</pre>
                                </>
                              )}
                            </div>
                          ) : null}
                        </SectionCard>

                        <SectionCard
                          title="Live transcript"
                          icon={<WaveIcon size={18} />}
                          description="Show a running transcript in VGet while Dictate or Smart is capturing audio."
                          action={<StatusBadge label={liveTranscriptionUi.capabilityLabel} tone={liveTranscriptionUi.capabilityTone} />}
                        >
                          <div className="grid gap-4 lg:grid-cols-[minmax(0,260px)_1fr]">
                            {liveTranscriptionUi.supportsLivePreview ? (
                              <div>
                                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">
                                  Preview
                                </label>
                                <select
                                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                  value={liveTranscriptionUi.controlValue}
                                  onChange={(event) => setDraftConfig({
                                    ...draftConfig,
                                    audio: {
                                      ...draftConfig.audio,
                                      live_transcription_mode: mapLiveTranscriptionControlValue(event.target.value as 'enabled' | 'off'),
                                    },
                                  })}
                                >
                                  <option value="enabled">Provider preview</option>
                                  <option value="off">Off</option>
                                </select>
                              </div>
                            ) : (
                              <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                                <div className="text-sm font-medium text-text-primary">Current provider uses final transcript only</div>
                                <p className="mt-2">{liveTranscriptionUi.detail}</p>
                              </div>
                            )}

                            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-6 text-text-secondary">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-text-primary">VGet capability</span>
                                <StatusBadge label={draftConfig.stt.provider} tone="neutral" />
                              </div>
                              <p className="mt-3">{liveTranscriptionUi.detail}</p>
                              <p className="mt-3">{liveTranscriptionUi.help}</p>
                            </div>
                          </div>
                        </SectionCard>

                        <SectionCard
                          title="Recording cues"
                          icon={<MicIcon size={18} />}
                          description="Optional short sounds when recording starts and stops."
                        >
                          <ToggleCard
                            title="Enable start and stop cues"
                            description="Keep this off for the default quiet experience, or turn it on if you rely on keyboard-driven dictation."
                            checked={draftConfig.audio.enable_recording_cues}
                            onChange={(checked) => setDraftConfig({
                              ...draftConfig,
                              audio: {
                                ...draftConfig.audio,
                                enable_recording_cues: checked,
                              },
                            })}
                          />
                        </SectionCard>
                      </>
                    ) : null}

                    {activeStep === 'rewrite' || activeStep === 'privacy' || activeStep === 'advanced' ? (
                      <>
                        {activeStep === 'rewrite' ? (
                        <SectionCard
                          title="Language model"
                          icon={<SparkIcon size={18} />}
                          description="Smart uses the selected LLM after transcription. The chosen default template shapes how the output behaves."
                        >
                          <div className="grid gap-5">
                            <ProviderPicker
                              label="LLM provider"
                              value={draftConfig.llm.provider}
                              options={PROVIDERS.llm}
                              availableKeys={keysSet}
                              onChange={(provider) => updateProvider('llm', provider)}
                            />

                            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-white/6 bg-white/[0.02] px-4 py-3">
                              <div className="text-sm leading-6 text-text-secondary">
                                Restarted LM Studio or added local models? Refresh the LM Studio catalog here without restarting {DISPLAY_NAME}.
                              </div>
                              <FooterButton tone="secondary" onClick={() => void refreshLmStudioModels()} disabled={refreshingLmStudioModels}>
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
                                  onChange={(event) => setDraftConfig(applyModelSelection(draftConfig, 'llm', event.target.value))}
                                >
                                  {displayedLlmModels.map((model) => (
                                    <option key={model.id} value={model.id}>{formatProviderModelLabel(model, draftConfig.llm.provider)}</option>
                                  ))}
                                </select>
                                {draftConfig.llm.provider === 'lmstudio' ? (
                                  <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <StatusBadge
                                      label={loadedLmStudioSmartModelCount ? `${loadedLmStudioSmartModelCount} loaded Smart-ready / ${lmStudioSmartModelCount} detected` : 'No loaded Smart-ready model'}
                                      tone={loadedLmStudioSmartModelCount ? 'good' : lmStudioSmartModelCount ? 'warn' : 'danger'}
                                    />
                                    <div className="text-xs leading-5 text-text-muted">
                                      Smart works best with loaded instruct or tool-use local models. Hidden reasoning is suppressed so only the final answer is shown.
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
                                  onChange={(event) => setDraftConfig({
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
                                  onChange={(checked) => setDraftConfig({
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
                                    onChange={(event) => setDraftConfig({
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
                                    onChange={(event) => setDraftConfig({
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
                                  <FooterButton tone="secondary" onClick={upsertCurrentFrontmostAppDefault} disabled={!canUseCurrentFrontmostApp}>
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
                                          onChange={(checked) => updateAppSkillDefault(rule.id, { enabled: checked })}
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
                                              updateAppSkillDefault(rule.id, { skill_id: event.target.value })
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
                                          <FooterButton tone="secondary" onClick={() => removeAppSkillDefault(rule.id)}>
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
                        ) : null}

                        {activeStep === 'advanced' ? (
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
                              onChange={(checked) => setDraftConfig({
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
                              onChange={(checked) => setDraftConfig({
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
                              onChange={(checked) => setDraftConfig({
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
                        ) : null}

                        {activeStep === 'advanced' ? (
                        <SectionCard
                          title="Local task shell"
                          icon={<SparkIcon size={18} />}
                          description="SteerVox-native reviewed command execution for local tasks. This lane stays local-only and blocks network-capable shell paths."
                          action={
                            <StatusBadge
                              label={
                                (draftConfig.actions.local_task_shell?.enabled ?? true)
                                  ? `Enabled · ${(draftConfig.actions.local_task_shell?.safety_mode || 'strict').replace('_', ' ')}`
                                  : 'Disabled'
                              }
                              tone={(draftConfig.actions.local_task_shell?.enabled ?? true) ? 'good' : 'warn'}
                            />
                          }
                        >
                          {(() => {
                            const localTaskShell = draftConfig.actions.local_task_shell ?? {
                              enabled: true,
                              safety_mode: 'strict' as const,
                              allowed_directories: [],
                            }
                            return (
                              <div className="grid gap-5">
                                <ToggleCard
                                  title="Enable local task shell"
                                  description="Allow SteerVox to run reviewed local tasks such as repo-local search, diff, and test commands after approval."
                                  checked={localTaskShell.enabled}
                                  onChange={(checked) => setDraftConfig({
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
                                    onChange={(event) => setDraftConfig({
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
                                    One absolute path per line. SteerVox always allows the current workspace root and app-home storage; use this list to add extra local roots explicitly.
                                  </p>
                                </label>
                              </div>
                            )
                          })()}
                        </SectionCard>
                        ) : null}

                        {activeStep === 'advanced' ? (
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
                              onChange={(checked) => setDraftConfig({
                                ...draftConfig,
                                memory: {
                                  ...draftConfig.memory,
                                  enabled: checked,
                                },
                              })}
                            />

                            <ToggleCard
                              title="Auto-learn from history"
                              description="Learn only from saved local history entries. No live transcript, clipboard, or screen-context learning is used."
                              checked={draftConfig.memory.auto_learn_from_history}
                              onChange={(checked) => setDraftConfig({
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
                              onChange={(checked) => setDraftConfig({
                                ...draftConfig,
                                memory: {
                                  ...draftConfig.memory,
                                  semantic_retrieval_enabled: checked,
                                },
                              })}
                            />

                            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                              {(() => {
                                const semanticMemoryUi = describeSemanticMemoryUi(
                                  draftConfig.memory.semantic_retrieval_enabled,
                                  semanticMemoryInstallState,
                                )
                                return (
                                  <>
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-medium text-text-primary">Semantic retrieval status</div>
                                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                                    {semanticMemoryUi.detail}
                                  </p>
                                </div>
                                <StatusBadge
                                  label={semanticMemoryUi.label}
                                  tone={semanticMemoryUi.tone}
                                />
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
                                <FooterButton
                                  tone="secondary"
                                  onClick={() => void window.windowControls?.writeClipboardText?.(buildSemanticMemoryDiagnostics(semanticMemoryInstallState))}
                                >
                                  Copy diagnostics
                                </FooterButton>
                                <FooterButton
                                  tone="secondary"
                                  onClick={() => void window.windowControls?.writeClipboardText?.(semanticMemoryInstallState.logs.join('\n') || 'No semantic runtime logs recorded yet.')}
                                >
                                  Copy logs
                                </FooterButton>
                                <FooterButton
                                  tone="secondary"
                                  onClick={() => void window.windowControls?.revealSemanticMemoryRuntime?.()}
                                >
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

                              {(semanticMemoryInstallState.logs.length > 0 || semanticMemoryInstallState.phase === 'error') ? (
                                <div className="mt-4">
                                  <FooterButton tone="secondary" size="compact" onClick={() => setShowSemanticMemoryLogs((value) => !value)}>
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
                                  </>
                                )
                              })()}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <FooterButton tone="secondary" onClick={() => void rebuildMemories()} disabled={memoryBusy !== null}>
                                {memoryBusy === 'rebuild' ? 'Rebuilding…' : 'Rebuild From History'}
                              </FooterButton>
                              <FooterButton tone="secondary" onClick={() => void clearAllMemories()} disabled={memoryBusy !== null || memories.length === 0}>
                                {memoryBusy === 'clear' ? 'Clearing…' : 'Clear All'}
                              </FooterButton>
                              <StatusBadge label={`${memories.length} learned`} tone={memories.length ? 'good' : 'neutral'} />
                            </div>

                            {deferredErrors.memory ? (
                              <div className="rounded-2xl border border-semantic-error/20 bg-semantic-error/10 px-4 py-3 text-sm leading-6 text-text-secondary">
                                {deferredErrors.memory}
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
                                          onChange={(checked) => void setMemoryEnabled(memory.id, checked)}
                                        />
                                        <FooterButton
                                          tone="secondary"
                                          size="compact"
                                          onClick={() => void deleteMemory(memory.id)}
                                          disabled={memoryBusy !== null}
                                        >
                                          Remove
                                        </FooterButton>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                                No learned memories yet. Keep auto-learn on and use Smart for a while, or rebuild from existing history to seed local memory now.
                              </div>
                            )}

                            <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                              Local memory is bounded and Smart-only. It learns from saved local history entries, including Smart runs, and it never changes Dictate output, desktop action planning, provider selection, or domain resolution.
                            </div>
                          </div>
                        </SectionCard>
                        ) : null}

                        {activeStep === 'advanced' ? (
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
                                      setActiveWritingTab(id)
                                      resetWritingToolDraft(id)
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
                                {(activeWritingTab === 'dictionary' ? writingTools.dictionary : activeWritingTab === 'replacements' ? writingTools.replacements : writingTools.snippets).length ? (
                                  (activeWritingTab === 'dictionary' ? writingTools.dictionary : activeWritingTab === 'replacements' ? writingTools.replacements : writingTools.snippets).map((item) => (
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
                                          <FooterButton tone="secondary" size="compact" onClick={() => beginEditWritingTool(item)}>
                                            Edit
                                          </FooterButton>
                                          <FooterButton
                                            tone="secondary"
                                            size="compact"
                                            onClick={() => void deleteWritingTool(activeWritingTab, item.id)}
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
                                        onChange={(event) => setWritingToolDraft((current) => (
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
                                        onChange={(event) => setWritingToolDraft((current) => ({ ...current, trigger: event.target.value }))}
                                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                      />
                                    </div>
                                  )}

                                  {activeWritingTab === 'dictionary' ? (
                                    <div>
                                      <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Spoken aliases</label>
                                      <textarea
                                        value={writingToolDraft.aliases_text || ''}
                                        onChange={(event) => setWritingToolDraft((current) => ({ ...current, aliases_text: event.target.value }))}
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
                                        onChange={(event) => setWritingToolDraft((current) => ({ ...current, replacement_text: event.target.value }))}
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
                                        onChange={(event) => setWritingToolDraft((current) => ({ ...current, expansion: event.target.value }))}
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
                                        onChange={(event) => setWritingToolDraft((current) => ({ ...current, match_type: event.target.value as 'exact' | 'inline' }))}
                                      >
                                        <option value="exact">Exact match</option>
                                        <option value="inline">Inline match</option>
                                      </select>
                                    </div>
                                  ) : null}
                                </div>

                                <div className="mt-4 flex flex-wrap gap-2">
                                  <FooterButton onClick={() => void saveWritingTool()} disabled={Boolean(writingToolBusy)}>
                                    {writingToolBusy === activeWritingTab ? 'Saving…' : editingWritingToolId ? 'Update' : 'Add'}
                                  </FooterButton>
                                  <FooterButton tone="secondary" onClick={resetWritingToolDraft}>
                                    Clear
                                  </FooterButton>
                                </div>
                              </div>
                            </div>
                          </div>
                        </SectionCard>
                        ) : null}

                        {activeStep === 'advanced' ? (
                        <SectionCard
                          title="Domains"
                          icon={<SparkIcon size={18} />}
                          description="Built-in Shipping and Medical packs add domain vocabulary, templates, examples, and privacy defaults."
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
                                      onClick={() => setDraftConfig({
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
                                const busy = domainActionState.domainId === pack.id && domainActionState.type !== 'idle'
                                if (!detail) return null
                                const overlay = detail.overlay
                                const effective = detail.effective
                                const guidance = buildDomainGuidance(pack.id)
                                return (
                                  <div key={pack.id} className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
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
                                        onClick={() => setExpandedDomainId((current) => current === pack.id ? null : pack.id)}
                                        className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-2 text-sm text-text-primary transition-colors hover:bg-white/[0.06]"
                                      >
                                        {expandedDomainId === pack.id ? 'Hide editor' : 'Edit local pack'}
                                      </button>
                                    </div>

                                    {expandedDomainId === pack.id ? (
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
                                                onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                              onChange={(checked) => updateDomainDetail(pack.id, (current) => ({
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
                                              onChange={(checked) => updateDomainDetail(pack.id, (current) => ({
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
                                            <FooterButton tone="secondary" size="compact" onClick={() => updateDomainDetail(pack.id, (current) => ({
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
                                                    onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                    onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                    onChange={(event) => updateDomainDetail(pack.id, (current) => ({
                                                      ...current,
                                                      overlay: {
                                                        ...current.overlay,
                                                        glossary: current.overlay.glossary.map((item, itemIndex) => itemIndex === index ? { ...item, priority: Number(event.target.value || 0) } : item),
                                                      },
                                                    }))}
                                                    placeholder="Priority"
                                                    className="rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                                  />
                                                  <FooterButton tone="secondary" size="compact" onClick={() => updateDomainDetail(pack.id, (current) => ({
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
                                            <FooterButton tone="secondary" size="compact" onClick={() => updateDomainDetail(pack.id, (current) => ({
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
                                                    onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                    onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                    <FooterButton tone="secondary" size="compact" onClick={() => updateDomainDetail(pack.id, (current) => ({
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
                                            <FooterButton tone="secondary" size="compact" onClick={() => updateDomainDetail(pack.id, (current) => ({
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
                                                    onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                    onChange={(event) => updateDomainDetail(pack.id, (current) => ({
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
                                                    <FooterButton tone="secondary" size="compact" onClick={() => updateDomainDetail(pack.id, (current) => ({
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
                                      {expandedDomainId === pack.id ? (
                                        <FooterButton
                                          onClick={() => void saveDomainEditor(pack.id)}
                                          disabled={domainActionState.type !== 'idle'}
                                        >
                                          {busy && domainActionState.type === 'saving' ? 'Saving…' : 'Save local changes'}
                                        </FooterButton>
                                      ) : null}
                                      <FooterButton
                                        onClick={() => void importDomainOverlay(pack.id)}
                                        disabled={domainActionState.type !== 'idle'}
                                      >
                                        {busy && domainActionState.type === 'importing' ? 'Importing…' : 'Import overlay'}
                                      </FooterButton>
                                      <FooterButton
                                        tone="secondary"
                                        onClick={() => void exportDomainOverlay(pack.id)}
                                        disabled={domainActionState.type !== 'idle'}
                                      >
                                        {busy && domainActionState.type === 'exporting' ? 'Exporting…' : 'Export overlay'}
                                      </FooterButton>
                                      <div className="min-w-full text-xs leading-5 text-text-muted">
                                        Edit inline for everyday vocabulary and writing changes. Import or export JSON when you want to move a local overlay between Macs or keep it under version control.
                                      </div>
                                    </div>
                                  </div>
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
                                  <FooterButton tone="secondary" onClick={addManualAppDomainDefault}>
                                    Add manual rule
                                  </FooterButton>
                                  <FooterButton tone="secondary" onClick={upsertCurrentFrontmostDomainDefault} disabled={!canUseCurrentFrontmostApp}>
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
                                          {rule.bundle_id ? ` with bundle id ${rule.bundle_id}` : ''}
                                          .
                                        </p>
                                      </div>
                                      <InlineSwitch
                                        checked={rule.enabled}
                                        onChange={(checked) => updateAppDomainDefault(rule.id, { enabled: checked })}
                                      />
                                    </div>

                                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                                      <div>
                                        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">App name</label>
                                        <input
                                          type="text"
                                          value={rule.app_name}
                                          onChange={(event) => updateAppDomainIdentity(rule.id, 'app_name', event.target.value)}
                                          placeholder="Microsoft Word"
                                          className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                        />
                                      </div>
                                      <div>
                                        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Bundle id</label>
                                        <input
                                          type="text"
                                          value={rule.bundle_id || ''}
                                          onChange={(event) => updateAppDomainIdentity(rule.id, 'bundle_id', event.target.value)}
                                          placeholder="com.microsoft.Word"
                                          className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                        />
                                      </div>
                                      <div>
                                        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Site host</label>
                                        <input
                                          type="text"
                                          value={rule.url_host || ''}
                                          onChange={(event) => updateAppDomainIdentity(rule.id, 'url_host', event.target.value)}
                                          placeholder="app.example.com"
                                          className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                        />
                                      </div>
                                      <div>
                                        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Domain override</label>
                                        <select
                                          className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                          value={rule.domain_id}
                                          onChange={(event) => updateAppDomainDefault(rule.id, { domain_id: event.target.value as 'shipping' | 'medical' })}
                                        >
                                          <option value="shipping">Shipping</option>
                                          <option value="medical">Medical</option>
                                        </select>
                                      </div>
                                      <div className="lg:col-span-2 flex items-center justify-end">
                                        <FooterButton tone="secondary" onClick={() => removeAppDomainDefault(rule.id)}>
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
                        ) : null}

                        {activeStep === 'privacy' ? (
                        <SectionCard
                          title="Privacy controls"
                          icon={<ShieldIcon size={18} />}
                          description="Keep Smart local-first and reduce context for sensitive apps or sites."
                          action={<StatusBadge label={draftConfig.privacy.restore_clipboard_after_paste ? 'Clipboard restore on' : 'Clipboard restore off'} tone={draftConfig.privacy.restore_clipboard_after_paste ? 'good' : 'warn'} />}
                          collapsible
                          defaultOpen={false}
                        >
                          <div className="grid gap-5">
                            <div className="grid gap-3 sm:grid-cols-2">
                              <ToggleCard
                                title="Restore clipboard after paste"
                                description={`Put your previous clipboard contents back right after ${DISPLAY_NAME} pastes the result.`}
                                checked={draftConfig.privacy.restore_clipboard_after_paste}
                                onChange={(checked) => setDraftConfig({
                                  ...draftConfig,
                                  privacy: {
                                    ...draftConfig.privacy,
                                    restore_clipboard_after_paste: checked,
                                  },
                                })}
                              />
                              <ToggleCard
                                title="Minimize sensitive context"
                                description="Trim browser titles, path, and field metadata when a sensitive-target rule asks for stricter privacy."
                                checked={draftConfig.privacy.minimize_sensitive_context}
                                onChange={(checked) => setDraftConfig({
                                  ...draftConfig,
                                  privacy: {
                                    ...draftConfig.privacy,
                                    minimize_sensitive_context: checked,
                                  },
                                })}
                              />
                            </div>

                            <div className="rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3 text-sm leading-6 text-text-secondary">
                              Password-like fields and clearly medical contexts already tighten privacy automatically. Use rules below only for extra app or site-specific control.
                            </div>

                            <div className="rounded-[22px] border border-white/6 bg-white/[0.02] p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-medium text-text-primary">Sensitive targets</div>
                                  <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
                                    Use these rules to reduce context or suppress selected text and clipboard text for specific apps or hosts.
                                  </p>
                                </div>
                                <FooterButton tone="secondary" onClick={upsertCurrentSensitiveTargetRule} disabled={!canUseCurrentFrontmostApp}>
                                  Use current frontmost target
                                </FooterButton>
                              </div>

                              <div className="mt-4 grid gap-4">
                                {(draftConfig.privacy.sensitive_targets || []).length ? draftConfig.privacy.sensitive_targets.map((rule) => (
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
                                        onChange={(checked) => updateSensitiveTargetRule(rule.id, { enabled: checked })}
                                      />
                                    </div>
                                    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                                      <div>
                                        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Rule mode</label>
                                        <select
                                          className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                          value={rule.mode}
                                          onChange={(event) => updateSensitiveTargetRule(rule.id, { mode: event.target.value as SensitiveTargetRule['mode'] })}
                                        >
                                          <option value="minimize_context">Minimize context</option>
                                          <option value="block_external_text">Block selected and clipboard text</option>
                                        </select>
                                      </div>
                                      <div className="flex items-end">
                                        <FooterButton tone="secondary" onClick={() => removeSensitiveTargetRule(rule.id)}>
                                          Remove
                                        </FooterButton>
                                      </div>
                                    </div>
                                  </div>
                                )) : (
                                  <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                                    No sensitive-target rules yet. Add the current app or host when you need stricter privacy.
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </SectionCard>
                        ) : null}

                        {activeStep === 'privacy' ? (
                        <SectionCard
                          title="Context"
                          icon={<SetupIcon size={18} />}
                          description="See what Smart can use right now and what it last captured."
                          action={<StatusBadge label={privacyEnvironmentPending ? contextStatusLabel : contextAccess.status === 'full' ? 'Ready' : contextAccess.status === 'app-only' ? 'Partial' : 'Transcript only'} tone={contextTone} />}
                          collapsible
                          defaultOpen={false}
                        >
                          <div className="grid gap-4 xl:grid-cols-2">
                            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-medium text-text-primary">Live context</div>
                                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                                    The current frontmost destination.
                                  </p>
                                </div>
                                <StatusBadge label={contextStatusLabel} tone={contextTone} />
                              </div>

                              <div className="mt-4 grid gap-4">
                                <ContextField label="App name" value={liveContextPreview.app_name} />
                                <ContextField label="Window title" value={liveContextPreview.window_title} />
                                <ContextField label="Page title" value={liveContextPreview.page_title} />
                                <ContextField label="Site host" value={liveContextPreview.url_host} />
                                <ContextField label="Page path" value={liveContextPreview.url_path} />
                                <OptionalContextField label="Code file" value={liveContextPreview.code_file_name} emptyLabel="Unavailable" />
                                <ContextField label="Surface kind" value={liveContextPreview.surface_kind} />
                                <OptionalContextField label="Focused field label" value={liveContextPreview.focused_field_label} emptyLabel="Unavailable" />
                                <OptionalContextField label="Focused field placeholder" value={liveContextPreview.focused_field_placeholder} emptyLabel="Unavailable" />
                              </div>

                              <div className="mt-4 rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                                {contextAccess.message}
                              </div>
                            </div>

                            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-medium text-text-primary">Last capture</div>
                                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                                    The last destination Smart captured at record start.
                                  </p>
                                </div>
                                <StatusBadge
                                  label={status ? formatQualityLabel(status.captured_context_quality) : 'Not available'}
                                  tone={status ? formatQualityTone(status.captured_context_quality) : 'neutral'}
                                />
                              </div>

                              <div className="mt-4 grid gap-4">
                                <OptionalContextField label="App name" value={lastCapturePreview.app_name} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
                                <OptionalContextField label="Window title" value={lastCapturePreview.window_title} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
                                <OptionalContextField label="Page title" value={lastCapturePreview.page_title} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
                                <OptionalContextField label="Site host" value={lastCapturePreview.url_host} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
                                <OptionalContextField label="Page path" value={lastCapturePreview.url_path} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
                                <OptionalContextField label="Code file" value={lastCapturePreview.code_file_name} emptyLabel={hasLastCapture ? 'Unavailable' : 'Not available'} />
                                <OptionalContextField label="Surface kind" value={lastCapturePreview.surface_kind} emptyLabel={hasLastCapture ? 'Unknown' : 'Not available'} />
                                <OptionalContextField label="Focused field label" value={lastCapturePreview.focused_field_label} emptyLabel={hasLastCapture ? 'Unavailable' : 'Not available'} />
                                <OptionalContextField label="Focused field placeholder" value={lastCapturePreview.focused_field_placeholder} emptyLabel={hasLastCapture ? 'Unavailable' : 'Not available'} />
                              </div>

                              <div className="mt-4 flex flex-wrap items-center gap-2">
                                <StatusBadge label={`Captured: ${formatCapturedAt(status?.captured_context_at)}`} tone="neutral" />
                                <StatusBadge label={`Target type: ${formatTargetType(status?.target_type)}`} tone="neutral" />
                              </div>

                              {!hasLastCapture ? (
                                <div className="mt-4 rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                                  No Smart capture yet. Run Smart once to populate this card.
                                </div>
                              ) : null}

                              {!hasLastCapture && hasUsefulContext(liveContextPreview) ? (
                                <div className="mt-4 rounded-2xl border border-accent-primary/14 bg-accent-primary/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                                  Live context is available. This card fills in after your first Smart run.
                                </div>
                              ) : null}
                            </div>
                          </div>

                          {status?.context_warning ? (
                            <div className="mt-5 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 p-4">
                              <div className="flex items-start gap-3">
                                <WarningIcon size={18} className="mt-0.5 text-semantic-warning" />
                                <div>
                                  <div className="text-sm font-medium text-text-primary">Limited context</div>
                                  <p className="mt-2 text-sm leading-6 text-text-secondary">{status.context_warning}</p>
                                  <div className="mt-4">
                                    <FooterButton onClick={requestSmartContext}>Retry context access</FooterButton>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : null}

                          <div className="mt-5 grid gap-4 lg:grid-cols-2">
                            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-7 text-text-secondary">
                              Smart captures the frontmost app and window when recording starts, then adds browser hostname, a sanitized page path, and focused field metadata like the field label or placeholder when available. Referential commands can also use selected text or clipboard text.
                            </div>
                            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-7 text-text-secondary">
                              {`Browser details are best-effort and fall back cleanly when unavailable. ${DISPLAY_NAME} does not read the existing contents of the focused field. Query strings, fragments, and full page content stay out of the Smart payload unless you explicitly work from selected or clipboard text.`}
                            </div>
                          </div>
                        </SectionCard>
                        ) : null}

                        {activeStep === 'advanced' ? (
                        <SectionCard
                          title="Recent Smart Run"
                          icon={<ShieldIcon size={18} />}
                          description="See the last route, context source, and timing."
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
                            <>
                              <div className="flex flex-wrap items-center gap-2">
                                {lastSmartRun.smart_profile === 'local_compact' ? (
                                  <StatusBadge label="Local Smart profile" tone="good" />
                                ) : null}
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
                                <InspectorField label="Smart profile" value={lastSmartRun.smart_profile === 'local_compact' ? 'Local Smart profile' : 'Default'} />
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
                            <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                              Run Smart once to populate this view.
                            </div>
                          )}
                        </SectionCard>
                        ) : null}
                      </>
                    ) : null}

                    {activeStep === 'voice' || activeStep === 'advanced' ? (
                      <>
                        {activeStep === 'voice' ? (
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
                        ) : null}

                        {activeStep === 'advanced' ? (
                        <SectionCard
                          title="Usage"
                          icon={<WaveIcon size={18} />}
                          description="Local counts and timing highlights from successful runs."
                          action={
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusBadge label="Local only" tone="neutral" />
                              <FooterButton tone="secondary" size="compact" onClick={resetUsageStats} disabled={resettingUsage || !hasUsageStats}>
                                {resettingUsage ? 'Resetting…' : 'Reset stats'}
                              </FooterButton>
                            </div>
                          }
                          collapsible
                          defaultOpen={false}
                        >
                          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-5">
                            <UsageMetricCard
                              label="Dictation uses"
                              value={String(usageStats?.dictation_runs ?? 0)}
                              hint="Successful paste-ready dictation runs."
                            />
                            <UsageMetricCard
                              label="Smart uses"
                              value={String(usageStats?.smart_runs ?? 0)}
                              hint="Successful Smart paste or saved-note runs."
                            />
                            <UsageMetricCard
                              label="Fastest Dictation"
                              value={formatDuration(usageStats?.fastest_dictation_stt_ms)}
                              hint="Best STT stage time so far."
                            />
                            <UsageMetricCard
                              label="Fastest Smart"
                              value={formatDuration(usageStats?.fastest_smart_stt_ms)}
                              hint="Best STT stage time so far."
                            />
                            <UsageMetricCard
                              label="Time saved"
                              value={formatTimeSaved(usageStats?.time_saved_seconds_total ?? 0)}
                              hint="Estimated from output length versus speaking and processing time."
                            />
                          </div>

                          <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3 text-sm leading-6 text-text-secondary">
                            {hasUsageStats
                              ? `Tracking locally since ${formatTrackingDate(usageStats?.tracking_started_at)}. These stats stay on this Mac and are never uploaded.`
                              : 'No local usage yet. Run Dictate or Smart once to start filling this card.'}
                          </div>
                        </SectionCard>
                        ) : null}

                        {activeStep === 'advanced' ? (
                        <SectionCard
                          title="History"
                          icon={<SetupIcon size={18} />}
                          description="Text-only local history for retrying, copying, and deleting previous runs."
                          action={
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusBadge label="No audio stored" tone="neutral" />
                              <FooterButton tone="secondary" size="compact" onClick={clearAllHistory} disabled={resettingHistory || historyItems.length === 0}>
                                {resettingHistory ? 'Clearing…' : 'Clear history'}
                              </FooterButton>
                            </div>
                          }
                          collapsible
                          defaultOpen={false}
                        >
                          <div className="grid gap-4">
                            {historyItems.length ? historyItems.map((item) => {
                              const canRerun = isHistoryItemRerunnable(item)
                              const rerunNotice = getHistoryItemRerunNotice(item)

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
                                    <FooterButton tone="secondary" size="compact" onClick={() => void reuseHistoryTranscript(item.transcript)}>
                                      Use transcript
                                    </FooterButton>
                                    <FooterButton tone="secondary" size="compact" onClick={() => void window.windowControls?.writeClipboardText?.(item.final_output)}>
                                      Copy output
                                    </FooterButton>
                                    {canRerun ? (
                                      <FooterButton size="compact" onClick={() => void reprocessHistoryItem(item.id)} disabled={writingToolBusy === `history-${item.id}`}>
                                        {writingToolBusy === `history-${item.id}` ? 'Reprocessing…' : 'Reprocess'}
                                      </FooterButton>
                                    ) : null}
                                    <FooterButton tone="secondary" size="compact" onClick={() => void deleteHistoryEntry(item.id)} disabled={writingToolBusy === `history-delete-${item.id}`}>
                                      Delete
                                    </FooterButton>
                                  </div>
                                </div>
                                {canRerun ? (
                                  <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
                                    <div>
                                      <label className="mb-2 block text-[11px] uppercase tracking-[0.24em] text-text-muted">Run with a different template</label>
                                      <select
                                        className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                                        value={resolveHistorySkillSelection(item)}
                                        onChange={(event) => setHistorySkillSelections((current) => ({
                                          ...current,
                                          [item.id]: event.target.value,
                                        }))}
                                      >
                                        {historySkillOptions.map((skill) => (
                                          <option key={skill.id} value={skill.id}>{skill.name}</option>
                                        ))}
                                      </select>
                                    </div>
                                    <div className="flex items-end">
                                      <FooterButton
                                        size="compact"
                                        onClick={() => void reprocessHistoryItem(item.id, resolveHistorySkillSelection(item))}
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
                        ) : null}

                        {activeStep === 'advanced' && !launchContext?.is_packaged ? (
                        <SectionCard
                          title="Window behavior"
                          icon={<SetupIcon size={18} />}
                          description={`Keep ${DISPLAY_NAME} as a tray-first background app unless you explicitly open a window.`}
                          collapsible
                          defaultOpen={false}
                        >
                          <div className="grid gap-4">
                            <ToggleCard
                              title="Background only"
                              description={`Hide the dock icon and keep ${DISPLAY_NAME} tray-first. Hotkeys stay active and windows only appear when you explicitly open them.`}
                              checked={Boolean(launchContext?.background_only)}
                              onChange={(checked) => {
                                void setBackgroundOnly(checked)
                              }}
                            />
                          </div>
                        </SectionCard>
                        ) : null}

                        {activeStep === 'advanced' ? (
                        <SectionCard
                          title="Logs"
                          icon={<RefreshIcon size={18} />}
                          description="Use these if something stops working."
                          action={<FooterButton onClick={() => {
                            void refreshRuntimeLocalEnvironment({ quiet: true })
                            void fetchDeferred()
                          }}
                          >
                            Refresh
                          </FooterButton>}
                          collapsible
                          defaultOpen={false}
                        >
                          <div className="grid gap-4 lg:grid-cols-2">
                            <LogPathCard label="Backend log" path={launchContext?.log_paths.backend || BACKEND_LOG_DISPLAY_PATH} />
                            <LogPathCard label="Electron log" path={launchContext?.log_paths.electron || ELECTRON_LOG_DISPLAY_PATH} />
                          </div>
                        </SectionCard>
                        ) : null}

                      </>
                    ) : null}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showActionBar ? (
        <div className="action-bar-shell soft-divider border-t px-6 py-4 lg:px-8">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                {saved ? <CheckIcon size={16} className="text-semantic-success" /> : <ArrowRightIcon size={16} className={saveError ? 'text-semantic-error' : 'text-accent-primary'} />}
                {saved ? 'Settings saved' : saveError ? 'Could not save changes' : 'Changes ready to apply'}
              </div>
              <p className="mt-1 text-sm text-text-secondary">
                {saveError || `Apply to restart ${DISPLAY_NAME} with your new settings.`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <FooterButton tone="secondary" onClick={() => setDraftConfig(remoteConfig)} disabled={!dirty || saving}>
                Reset
              </FooterButton>
              <FooterButton onClick={saveConfig} disabled={!dirty || saving}>
                {saving ? 'Applying…' : 'Apply'}
              </FooterButton>
            </div>
          </div>
        </div>
      ) : null}
    </motion.div>
  )
}
