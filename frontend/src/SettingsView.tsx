import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'

import { BACKEND_LOG_DISPLAY_PATH, DISPLAY_NAME, ELECTRON_LOG_DISPLAY_PATH } from '../shared/branding'
import { BrandedProgressLoader } from './components/BrandedProgressLoader'
import {
  ArrowRightIcon,
  CheckIcon,
  ErrorIcon,
  KeyIcon,
  MicIcon,
  RefreshIcon,
  ShieldIcon,
  SparkIcon,
  WarningIcon,
} from './components/BrandIcons'
import { apiDelete, apiGet, apiPost, apiPut } from './lib/api'
import { getHistoryItemRerunNotice, isHistoryItemRerunnable } from './lib/historyRuns'
import { deriveLiveTranscriptionUiState } from './lib/liveTranscriptionSettings'
import { computeOnboardingState } from './lib/onboarding'
import { formatProviderDisplayName, providerRequiresKey } from './lib/providerLabels'
import { applyProviderSelection } from './lib/providerSettings'
import { parseSettingsStepRoute } from './lib/routes'
import { selectActiveWorkState, selectOnboardingState, selectPrimaryAttentionIssue } from './lib/runtimeSelectors'
import { createLatestRequestController, responseData, retryRead, settleRecord, withSignal } from './lib/runtime'
import { refreshRuntimeLocalEnvironment, refreshRuntimeProviderModels, refreshRuntimeStatus, useRuntimeStore } from './lib/runtimeStore'
import {
  FooterButton,
  LogPathCard,
  SidebarSectionButton,
  StatusBadge,
} from './settings/primitives'
import { resolveConfiguredDevice } from './settings/audioDevices'
import {
  API_KEY_PROVIDERS,
  PROVIDERS,
  STEP_DETAILS,
  STEPS,
  type ApiKeyProviderId,
  type OnboardingStepId,
  type StepId,
} from './settings/constants'
import {
  configReducer,
  createConfigReducerState,
  stableStringify,
} from './settings/configState'
import { AccessSection } from './settings/sections/AccessSection'
import { AdvancedSection } from './settings/sections/AdvancedSection'
import { PrivacySection } from './settings/sections/PrivacySection'
import { SmartSection } from './settings/sections/SmartSection'
import { VoiceSection } from './settings/sections/VoiceSection'
import {
  buildAppDomainLabel,
  createAppDomainDefaultId,
  createAppSkillDefaultId,
  createManualAppDomainDefault,
  createSensitiveTargetRuleId,
  findMatchingAppDomainDefaultIndex,
  findMatchingAppSkillDefaultIndex,
  findMatchingSensitiveTargetIndex,
  hostMatches,
  normalizeHost,
} from './settings/utils'
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
  DesktopLogKind,
  DesktopLogSnapshot,
  DictionaryEntry,
  DomainPackDetail,
  DomainPackSummary,
  HistoryItem,
  LearnedMemory,
  MlxInstallState,
  PrivacyPane,
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
type WritingToolDraft = {
  source_text?: string
  canonical_text?: string
  aliases_text?: string
  replacement_text?: string
  trigger?: string
  expansion?: string
  match_type?: 'exact' | 'inline'
}

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

const DEFAULT_LIVE_LOG_SNAPSHOTS: Record<DesktopLogKind, DesktopLogSnapshot> = {
  backend: {
    kind: 'backend',
    path: BACKEND_LOG_DISPLAY_PATH,
    exists: false,
    updated_at: null,
    content: '',
    truncated: false,
    error: null,
  },
  electron: {
    kind: 'electron',
    path: ELECTRON_LOG_DISPLAY_PATH,
    exists: false,
    updated_at: null,
    content: '',
    truncated: false,
    error: null,
  },
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
const EMPTY_WRITING_TOOLS: WritingToolsSnapshot = {
  dictionary: [],
  replacements: [],
  snippets: [],
}
const PROVIDER_OPTIONS_BY_ID = new Map<string, ProviderOption>([
  ...PROVIDERS.llm,
  ...PROVIDERS.stt,
].map((option) => [option.id, option]))

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
    || formatProviderDisplayName(providerId)
}

const STEP_MOTION = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1] as const,
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

function formatDuration(value: number | null | undefined) {
  if (value == null) return 'Not used'
  return `${value} ms`
}

function formatDomainLabel(value: string | null | undefined) {
  if (value === 'shipping') return 'Shipping'
  if (value === 'medical') return 'Medical'
  return 'None'
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
  const [activeLogTab, setActiveLogTab] = useState<DesktopLogKind>('backend')
  const [liveLogs, setLiveLogs] = useState<Record<DesktopLogKind, DesktopLogSnapshot>>(DEFAULT_LIVE_LOG_SNAPSHOTS)
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

  const activeStep = parseSettingsStepRoute(searchParams.get('step'))
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
    if (step === 'access') {
      nextParams.delete('step')
    } else {
      nextParams.set('step', step)
    }
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])
  const openAccessStep = useCallback((provider?: string | null) => {
    if (provider && isApiKeyProviderId(provider)) {
      setApiProvider(provider)
    }
    navigateToStep('access')
  }, [navigateToStep])

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

  const refreshLiveLogs = useCallback(async () => {
    const readLogTail = window.windowControls?.readLogTail
    if (!readLogTail) return
    try {
      const [backend, electron] = await Promise.all([
        readLogTail('backend'),
        readLogTail('electron'),
      ])
      setLiveLogs({
        backend,
        electron,
      })
    } catch {
      // Keep the current snapshots if the bridge is temporarily unavailable.
    }
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
  const voiceConfigDirty = dirtySections.voice
  const rewriteConfigDirty = dirtySections.rewrite
  const smartConfigDirty = voiceConfigDirty || rewriteConfigDirty
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
    if (activeStep !== 'advanced') return

    let cancelled = false
    const pump = async () => {
      if (cancelled) return
      await refreshLiveLogs()
    }

    void pump()
    const intervalId = window.setInterval(() => {
      void pump()
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [activeStep, refreshLiveLogs])

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
  const displayedLlmModels = llmModels
  const sttModels = providerModels.stt?.[draftConfig.stt.provider] || []
  const visionModels = providerModels.vision?.lmstudio || []
  const selectedVisionModel = draftConfig.vision.model || '__reuse__'
  const selectedLlmModel = llmModels.find((model) => model.id === draftConfig.llm.model) || null
  const explicitVisionModel = visionModels.find((model) => model.id === draftConfig.vision.model) || null
  const detectedVisionModels = visionModels.filter((model) => model.discovered !== false)
  const loadedVisionModelCount = detectedVisionModels.filter((model) => model.loaded !== false).length
  const selectedVisionModelUnavailable = Boolean(draftConfig.vision.model && explicitVisionModel && explicitVisionModel.loaded === false)
  const reusedVisionModelUnavailable = (
    draftConfig.vision.model == null
    && draftConfig.llm.provider === 'lmstudio'
    && Boolean(selectedLlmModel?.vision)
    && selectedLlmModel?.loaded === false
  )
  const visionAvailabilityMessage = selectedVisionModelUnavailable
    ? explicitVisionModel?.discovered === false
      ? `${explicitVisionModel?.name || draftConfig.vision.model} is selected for local vision, but LM Studio is not currently reachable. Start LM Studio or refresh the local catalog first.`
      : null
    : reusedVisionModelUnavailable
      ? null
      : null
  const detectedLmStudioSmartModels = llmModels.filter((model) => model.discovered !== false)
  const lmStudioSmartModelCount = detectedLmStudioSmartModels.length
  const loadedLmStudioSmartModelCount = detectedLmStudioSmartModels.filter((model) => model.loaded !== false).length
  const selectedLmStudioModelNotLoaded = draftConfig.llm.provider === 'lmstudio' && Boolean(selectedLlmModel) && selectedLlmModel?.loaded === false
  const selectedLmStudioModelUndiscovered = draftConfig.llm.provider === 'lmstudio' && Boolean(selectedLlmModel) && selectedLlmModel?.discovered === false
  const selectedLmStudioModelAutoLoadReady = draftConfig.llm.provider === 'lmstudio'
    && Boolean(selectedLlmModel)
    && selectedLlmModel?.discovered !== false
  const lmStudioSmartModelMessage = selectedLmStudioModelUndiscovered
    ? `${selectedLlmModel?.name || draftConfig.llm.model} is selected, but LM Studio is not currently reachable. Start LM Studio and refresh the local catalog.`
    : selectedLmStudioModelNotLoaded && !selectedLmStudioModelAutoLoadReady
      ? `${selectedLlmModel?.name || draftConfig.llm.model} is downloaded in LM Studio but not currently loaded. ${DISPLAY_NAME} will ask LM Studio to load it automatically when Smart starts.`
      : draftConfig.llm.provider === 'lmstudio' && !loadedLmStudioSmartModelCount
        ? selectedLmStudioModelAutoLoadReady
          ? null
          : lmStudioSmartModelCount
          ? `No LM Studio model is currently loaded, but ${DISPLAY_NAME} can auto-load the selected local model on first use.`
          : 'No LM Studio model is available right now. Start LM Studio, download a local model, and refresh the local catalog.'
        : null
  const activeSkill = skills.find((skill) => skill.id === draftConfig.hotkeys.default_skill_id) ?? null
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
  const lastSmartRun = status?.last_smart_run ?? null
  const appliedOnboardingState = selectOnboardingState(runtime)
    ?? computeOnboardingState(
      remoteConfig,
      keysSet,
      microphoneAccess,
      accessibilityTrusted,
      usageStats,
      providerModels,
      status,
      localEnvironment.mlxInstallState,
    )
  const primaryAttentionIssue = selectPrimaryAttentionIssue(runtime)
  const activeWorkState = selectActiveWorkState(runtime)
  const voiceEnvironmentPending = localEnvironment.status === 'checking'
    || (localEnvironment.status === 'verifying' && localEnvironment.verifyingTarget !== 'context')
  const privacyEnvironmentPending = localEnvironment.status === 'checking'
    || (localEnvironment.status === 'verifying' && localEnvironment.verifyingTarget === 'context')
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
  const currentSttProviderReady = appliedOnboardingState.dictationProviderReady
  const currentLlmProviderReady = appliedOnboardingState.rewriteProviderReady
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
  const providerLabel = !currentSttProviderReady
    ? 'Dictation provider needed'
    : !currentLlmProviderReady
      ? 'Smart provider needed'
      : 'Providers ready'
  const providerTone = !currentSttProviderReady ? 'warn' : !currentLlmProviderReady ? 'warn' : 'good'
  const liveTranscriptionMode = draftConfig.audio.live_transcription_mode || 'auto'
  const liveTranscriptionUi = deriveLiveTranscriptionUiState({
    provider: draftConfig.stt.provider,
    rawMode: liveTranscriptionMode,
  })
  const developerMode = Boolean(draftConfig.debug.developer_mode)
  const showActionBar = dirty || saving || saved || Boolean(saveError)
  const totalUsageRuns = (usageStats?.dictation_runs || 0) + (usageStats?.smart_runs || 0)
  const hasUsageStats = totalUsageRuns > 0
  const packagedInstallReady = !launchContext?.is_packaged || launchContext.install_location === 'applications'
  const onboardingReady = appliedOnboardingState.completed && packagedInstallReady
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
            : !appliedOnboardingState.rewriteProviderReady
              ? 'smart_provider'
              : !appliedOnboardingState.smartTested
                ? 'smart_test'
                : 'complete'
  const onboardingStepOrder: OnboardingStepId[] = ['install', 'microphone', 'accessibility', 'providers', 'dictation_test', 'smart_provider', 'smart_test', 'complete']
  const onboardingStepIndex = onboardingStepOrder.indexOf(onboardingStep)
  const onboardingActionableStepCount = onboardingStepOrder.length - 1
  const onboardingDisplayStep = Math.min(onboardingStepIndex + 1, onboardingActionableStepCount)
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
    smart_provider: 'Configure a Smart provider',
    smart_test: 'Test Smart once',
    complete: 'Finish setup',
  }
  const onboardingStepDescriptions: Record<OnboardingStepId, string> = {
    install: 'Website builds should be opened from the DMG once, moved into /Applications, then reopened from /Applications before you trust the final setup state.',
    microphone: 'Allow microphone access so Dictate and Smart can record.',
    accessibility: 'Enable Accessibility for shortcuts and reliable paste handoff.',
    providers: 'Choose the Dictation path you want to use first. If the local path is ready, keep it local. Otherwise save access for a cloud provider and switch to it here.',
    dictation_test: 'Run one real Dictate pass so you know capture, transcription, and paste are working end to end.',
    smart_provider: `Choose the Smart provider and model you want ${DISPLAY_NAME} to use after transcription. Local LM Studio works when a supported model is loaded.`,
    smart_test: 'Run one real Smart pass so you know the Smart route works end to end with your current model and template.',
    complete: 'Dictation and Smart are both ready on this Mac.',
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
  const primaryAutoLanguage = draftConfig.stt.preferred_languages[0] || draftConfig.stt.language || 'en'
  const autoSecondaryLanguages = draftConfig.stt.preferred_languages.filter((code) => code !== primaryAutoLanguage)
  const historySkillOptions = skills.filter((skill) => skill.id !== 'system_dictation')
  const savedProviderAccessCount = API_KEY_PROVIDERS.filter((provider) => Boolean(keysSet[provider])).length
  const draftDictationProviderNeedsAccess = providerRequiresKey(draftConfig.stt.provider)
  const draftSmartProviderNeedsAccess = providerRequiresKey(draftConfig.llm.provider)
  const sectionSummaries: Record<StepId, string> = {
    voice: `${formatProviderName(draftConfig.stt.provider)} • ${configuredDeviceLabel || 'System mic'}`,
    rewrite: `${formatProviderName(draftConfig.llm.provider)} • ${activeSkill?.name || 'No mode selected'}`,
    access: savedProviderAccessCount ? `${savedProviderAccessCount} saved key${savedProviderAccessCount === 1 ? '' : 's'}` : 'No saved keys',
    privacy: contextAccess.status === 'full' ? 'Context ready' : contextAccess.status === 'app-only' ? 'App-only context' : 'Context limited',
    advanced: 'Actions, domains, history, and logs',
  }
  const activeStepDeferredMessages = (
    activeStep === 'voice'
      ? [deferredErrors.audioDevices, deferredErrors.usage]
      : activeStep === 'rewrite'
        ? [deferredErrors.skills]
        : activeStep === 'access'
          ? []
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

  const activeStepContent = activeStep === 'voice' ? (
    <VoiceSection
      draftConfig={draftConfig}
      keysSet={keysSet}
      sttModels={sttModels}
      displayedLlmModels={displayedLlmModels}
      audioDevices={audioDevices}
      configuredDevice={configuredDevice}
      refreshingDevices={refreshingDevices}
      testRecording={testRecording}
      testResult={testResult}
      launchContext={launchContext}
      mlxInstallState={mlxInstallState}
      showMlxLogs={showMlxLogs}
      liveTranscriptionUi={liveTranscriptionUi}
      microphoneAccess={microphoneAccess}
      accessibilityTrusted={accessibilityTrusted}
      microphoneTone={microphoneTone}
      accessibilityTone={accessibilityTone}
      microphoneBadgeLabel={microphoneBadgeLabel}
      accessibilityBadgeLabel={accessibilityBadgeLabel}
      microphonePermissionLabel={microphonePermissionLabel}
      accessibilityPermissionLabel={accessibilityPermissionLabel}
      microphoneActionLabel={microphoneActionLabel}
      microphoneDetail={microphoneDetail}
      microphoneDeviceHint={microphoneDeviceHint}
      voiceConfigDirty={voiceConfigDirty}
      rewriteConfigDirty={rewriteConfigDirty}
      smartConfigDirty={smartConfigDirty}
      currentSttProviderReady={currentSttProviderReady}
      currentLlmProviderReady={currentLlmProviderReady}
      saving={saving}
      refreshingLmStudioModels={refreshingLmStudioModels}
      draftDictationProviderNeedsAccess={draftDictationProviderNeedsAccess}
      draftSmartProviderNeedsAccess={draftSmartProviderNeedsAccess}
      showPackagedOnboarding={showPackagedOnboarding}
      onboardingReady={onboardingReady}
      onboardingStep={onboardingStep}
      onboardingStepOrder={onboardingStepOrder}
      onboardingStepIndex={onboardingStepIndex}
      onboardingDisplayStep={onboardingDisplayStep}
      onboardingActionableStepCount={onboardingActionableStepCount}
      onboardingStepTitles={onboardingStepTitles}
      onboardingStepDescriptions={onboardingStepDescriptions}
      appliedOnboardingState={appliedOnboardingState}
      primaryAutoLanguage={primaryAutoLanguage}
      autoSecondaryLanguages={autoSecondaryLanguages}
      usingMlxWhisper={usingMlxWhisper}
      selectedSttModel={selectedSttModel}
      usingTinyMlxModel={usingTinyMlxModel}
      usingHeavyMlxModel={usingHeavyMlxModel}
      packagedLocalSttStatus={packagedLocalSttStatus}
      packagedLocalSttBadgeLabel={packagedLocalSttBadgeLabel}
      packagedLocalSttBadgeTone={packagedLocalSttBadgeTone}
      developerMode={developerMode}
      onSetDraftConfig={setDraftConfig}
      onUpdateProvider={updateProvider}
      onOpenAccessStep={openAccessStep}
      onNavigateToStep={(step) => navigateToStep(step)}
      onSaveConfig={saveConfig}
      onStartTestRecording={() => { void startTestRecording() }}
      onStopTestRecording={() => { void stopTestRecording() }}
      onRefreshDevices={() => { void refreshDevices() }}
      onRequestMicrophone={() => { void requestMicrophone() }}
      onRequestAccessibility={() => { void requestAccessibility() }}
      onOpenPrivacySettings={openPrivacySettings}
      onRefreshLmStudioModels={() => { void refreshLmStudioModels() }}
      onDismissPackagedOnboarding={() => { void dismissPackagedOnboarding() }}
      onCompletePackagedOnboarding={() => { void completePackagedOnboarding() }}
      onRefreshRuntimeStatus={() => { void refreshRuntimeStatus() }}
      onInstallMlxWhisper={() => { void window.windowControls?.installMlxWhisper?.() }}
      onCheckMlxWhisperInstallation={() => { void window.windowControls?.checkMlxWhisperInstallation?.() }}
      onToggleShowMlxLogs={() => setShowMlxLogs((value) => !value)}
    />
  ) : activeStep === 'access' ? (
    <AccessSection
      apiKey={apiKey}
      apiProvider={apiProvider}
      apiProviders={API_KEY_PROVIDERS}
      dirty={dirty}
      draftConfig={draftConfig}
      keyStatus={keyStatus}
      keysSet={keysSet}
      providerMetaById={PROVIDER_OPTIONS_BY_ID}
      readinessState={appliedOnboardingState}
      remoteConfig={remoteConfig}
      savedProviderAccessCount={savedProviderAccessCount}
      onApiKeyChange={setApiKey}
      onClearApiKey={clearApiKey}
      onNavigateToStep={navigateToStep}
      onProviderSelect={(provider) => {
        if (isApiKeyProviderId(provider)) {
          setApiProvider(provider)
        }
      }}
      onSaveApiKey={saveApiKey}
    />
  ) : activeStep === 'rewrite' ? (
    <SmartSection
      draftConfig={draftConfig}
      keysSet={keysSet}
      displayedLlmModels={displayedLlmModels}
      activeSkill={activeSkill}
      skills={skills}
      refreshingLmStudioModels={refreshingLmStudioModels}
      lmStudioRefreshMessage={lmStudioRefreshMessage}
      selectedLmStudioModelUndiscovered={selectedLmStudioModelUndiscovered}
      loadedLmStudioSmartModelCount={loadedLmStudioSmartModelCount}
      lmStudioSmartModelCount={lmStudioSmartModelCount}
      selectedLmStudioModelAutoLoadReady={selectedLmStudioModelAutoLoadReady}
      lmStudioSmartModelMessage={lmStudioSmartModelMessage}
      draftSmartProviderNeedsAccess={draftSmartProviderNeedsAccess}
      visionModels={visionModels}
      loadedVisionModelCount={loadedVisionModelCount}
      selectedVisionModel={selectedVisionModel}
      visionAvailabilityMessage={visionAvailabilityMessage}
      appSkillDefaults={appSkillDefaults}
      canUseCurrentFrontmostApp={canUseCurrentFrontmostApp}
      liveContextPreview={liveContextPreview}
      onUpdateProvider={(provider) => updateProvider('llm', provider)}
      onRefreshLmStudioModels={() => { void refreshLmStudioModels() }}
      onSetDraftConfig={setDraftConfig}
      onOpenAccessStep={openAccessStep}
      onUpsertCurrentFrontmostAppDefault={upsertCurrentFrontmostAppDefault}
      onUpdateAppSkillDefault={updateAppSkillDefault}
      onRemoveAppSkillDefault={removeAppSkillDefault}
      onNavigateToStep={(step) => navigateToStep(step)}
    />
  ) : activeStep === 'privacy' ? (
    <PrivacySection
      canUseCurrentFrontmostApp={canUseCurrentFrontmostApp}
      contextAccessMessage={contextAccess.message}
      contextAccessStatus={contextAccess.status}
      contextStatusLabel={contextStatusLabel}
      contextTone={contextTone}
      contextWarning={status?.context_warning ?? null}
      draftConfig={draftConfig}
      hasLastCapture={hasLastCapture}
      hasUsefulLiveContext={hasUsefulContext(liveContextPreview)}
      lastCaptureMeta={{
        capturedAtLabel: formatCapturedAt(status?.captured_context_at),
        qualityLabel: status ? formatQualityLabel(status.captured_context_quality) : 'Not available',
        qualityTone: status ? formatQualityTone(status.captured_context_quality) : 'neutral',
        targetTypeLabel: formatTargetType(status?.target_type),
      }}
      lastCapturePreview={lastCapturePreview}
      liveContextPreview={liveContextPreview}
      privacyEnvironmentPending={privacyEnvironmentPending}
      onRequestSmartContext={requestSmartContext}
      onSetMinimizeSensitiveContext={(checked) => setDraftConfig({
        ...draftConfig,
        privacy: {
          ...draftConfig.privacy,
          minimize_sensitive_context: checked,
        },
      })}
      onSetRestoreClipboardAfterPaste={(checked) => setDraftConfig({
        ...draftConfig,
        privacy: {
          ...draftConfig.privacy,
          restore_clipboard_after_paste: checked,
        },
      })}
      onRemoveSensitiveTargetRule={removeSensitiveTargetRule}
      onUpdateSensitiveTargetRule={updateSensitiveTargetRule}
      onUpsertCurrentSensitiveTargetRule={upsertCurrentSensitiveTargetRule}
    />
  ) : (
    <AdvancedSection
      draftConfig={draftConfig}
      developerMode={developerMode}
      semanticMemoryInstallState={semanticMemoryInstallState}
      showSemanticMemoryLogs={showSemanticMemoryLogs}
      memories={memories}
      memoryBusy={memoryBusy}
      memoryError={deferredErrors.memory}
      onSetDraftConfig={setDraftConfig}
      onToggleShowSemanticMemoryLogs={() => setShowSemanticMemoryLogs((value) => !value)}
      onSetMemoryEnabled={(memoryId, enabled) => { void setMemoryEnabled(memoryId, enabled) }}
      onDeleteMemory={(memoryId) => { void deleteMemory(memoryId) }}
      onRebuildMemories={() => { void rebuildMemories() }}
      onClearAllMemories={() => { void clearAllMemories() }}
      writingTools={writingTools}
      activeWritingTab={activeWritingTab}
      writingToolDraft={writingToolDraft}
      editingWritingToolId={editingWritingToolId}
      writingToolBusy={writingToolBusy}
      onSetActiveWritingTab={setActiveWritingTab}
      onSetWritingToolDraft={setWritingToolDraft}
      onResetWritingToolDraft={resetWritingToolDraft}
      onBeginEditWritingTool={beginEditWritingTool}
      onSaveWritingTool={() => { void saveWritingTool() }}
      onDeleteWritingTool={(tab, id) => { void deleteWritingTool(tab, id) }}
      orderedDomainPacks={orderedDomainPacks}
      orderedDomainDetails={orderedDomainDetails}
      domainActionState={domainActionState}
      expandedDomainId={expandedDomainId}
      onSetExpandedDomainId={setExpandedDomainId}
      canUseCurrentFrontmostApp={canUseCurrentFrontmostApp}
      liveContextPreview={liveContextPreview}
      appDomainDefaults={appDomainDefaults}
      onUpdateAppDomainDefault={updateAppDomainDefault}
      onUpdateAppDomainIdentity={updateAppDomainIdentity}
      onRemoveAppDomainDefault={removeAppDomainDefault}
      onAddManualAppDomainDefault={addManualAppDomainDefault}
      onUpsertCurrentFrontmostDomainDefault={upsertCurrentFrontmostDomainDefault}
      onImportDomainOverlay={(domainId) => { void importDomainOverlay(domainId) }}
      onExportDomainOverlay={(domainId) => { void exportDomainOverlay(domainId) }}
      onSaveDomainEditor={(domainId) => { void saveDomainEditor(domainId) }}
      onUpdateDomainDetail={updateDomainDetail}
      lastSmartRun={lastSmartRun}
      hasUsageStats={hasUsageStats}
      usageMetrics={[
        {
          label: 'Dictation uses',
          value: String(usageStats?.dictation_runs ?? 0),
          hint: 'Successful paste-ready dictation runs.',
        },
        {
          label: 'Smart uses',
          value: String(usageStats?.smart_runs ?? 0),
          hint: 'Successful Smart paste or saved-note runs.',
        },
        {
          label: 'Fastest Dictation',
          value: formatDuration(usageStats?.fastest_dictation_stt_ms),
          hint: 'Best STT stage time so far.',
        },
        {
          label: 'Fastest Smart',
          value: formatDuration(usageStats?.fastest_smart_stt_ms),
          hint: 'Best STT stage time so far.',
        },
        {
          label: 'Time saved',
          value: formatTimeSaved(usageStats?.time_saved_seconds_total ?? 0),
          hint: 'Estimated from output length versus speaking and processing time.',
        },
      ]}
      resettingUsage={resettingUsage}
      trackingLabel={formatTrackingDate(usageStats?.tracking_started_at)}
      onResetUsageStats={() => { void resetUsageStats() }}
      historyItems={historyItems}
      historySkillOptions={historySkillOptions}
      resettingHistory={resettingHistory}
      resolveHistorySkillSelection={resolveHistorySkillSelection}
      canHistoryItemRerun={isHistoryItemRerunnable}
      getHistoryItemRerunNotice={getHistoryItemRerunNotice}
      onClearAllHistory={() => { void clearAllHistory() }}
      onCopyOutput={(output) => { void window.windowControls?.writeClipboardText?.(output) }}
      onDeleteHistoryEntry={(id) => { void deleteHistoryEntry(id) }}
      onHistorySkillSelectionChange={(id, skillId) => {
        setHistorySkillSelections((current) => ({
          ...current,
          [id]: skillId,
        }))
      }}
      onReprocessHistoryItem={(id, skillId) => { void reprocessHistoryItem(id, skillId) }}
      onReuseHistoryTranscript={(transcript) => { void reuseHistoryTranscript(transcript) }}
      launchContext={launchContext}
      backgroundOnly={Boolean(launchContext?.background_only)}
      onSetBackgroundOnly={(checked) => { void setBackgroundOnly(checked) }}
      activeLogTab={activeLogTab}
      liveLogs={{
        backend: {
          ...liveLogs.backend,
          path: liveLogs.backend.path || launchContext?.log_paths.backend || BACKEND_LOG_DISPLAY_PATH,
        },
        electron: {
          ...liveLogs.electron,
          path: liveLogs.electron.path || launchContext?.log_paths.electron || ELECTRON_LOG_DISPLAY_PATH,
        },
      }}
      onRefreshLogs={() => {
        void refreshLiveLogs()
        void refreshRuntimeLocalEnvironment({ quiet: true })
        void fetchDeferred()
      }}
      onSelectLogTab={setActiveLogTab}
    />
  )


  return (
    <motion.div
      className="relative flex h-full flex-col overflow-hidden"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="soft-divider border-b px-5 py-3 lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Settings</div>
            <h1 className="mt-1 text-[22px] font-semibold text-text-primary">Settings</h1>
            <p className="mt-1 max-w-xl text-[13px] leading-5 text-text-secondary">Voice, Smart, privacy, and advanced controls.</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge label={backendLabel} tone={backendTone} />
            <StatusBadge label={providerLabel} tone={providerTone} />
          </div>
        </div>
        {hasBackendAttention ? (
          <div className="mt-4 rounded-xl border border-semantic-error/18 bg-[linear-gradient(180deg,rgba(57,17,23,0.56),rgba(21,12,16,0.84))] px-4 py-3.5 shadow-[0_10px_28px_rgba(0,0,0,0.18)]">
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

      <div className="min-h-0 flex-1 overflow-hidden px-5 py-4 lg:px-7">
        <div className="mx-auto flex h-full max-w-7xl gap-3">
          <aside
            className={`settings-sidebar flex shrink-0 flex-col overflow-hidden rounded-xl border border-white/7 p-2 transition-[width] duration-200 ${sidebarCollapsed ? 'w-[76px]' : 'w-[238px]'
              }`}
          >
            <div className={`mb-2 flex items-center ${sidebarCollapsed ? 'justify-center' : 'justify-between'} gap-2 px-2`}>
              {!sidebarCollapsed ? (
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Sections</div>
                  <div className="mt-1 text-sm font-medium text-text-primary">Settings</div>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => setSidebarCollapsed((current) => !current)}
                className="settings-sidebar-toggle flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 text-text-secondary transition-colors hover:bg-white/[0.06] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-focus/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#091018]"
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
                        step.id === 'access' ? <KeyIcon size={15} /> :
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

          <div className="settings-content-shell min-w-0 flex-1 overflow-hidden rounded-xl border border-white/7">
            <div className={`h-full overflow-y-auto px-1 ${showActionBar ? 'pb-8' : 'pb-0'}`}>
              <div className="flex flex-col gap-4 px-4 py-3.5 lg:px-5">
                <section className="section-intro-panel rounded-xl border border-white/6 px-4 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{STEPS.find((step) => step.id === activeStep)?.eyebrow}</div>
                      <div className="mt-1 text-[15px] font-semibold text-text-primary">{activeStepDetail.title}</div>
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
                      <section className="rounded-xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-4">
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
                    {activeStepContent}
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
