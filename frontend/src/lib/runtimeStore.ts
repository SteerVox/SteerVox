import { useSyncExternalStore } from 'react'

import { apiGet, getBackendRequestContext } from './api'
import { getErrorMessage } from './errors'
import { createFetchRuntimeEventStream, type RuntimeEventStream, type RuntimeEventStreamFactory } from './runtimeEventStream'
import { createLatestRequestController, delay, responseData, retryRead, settleRecord } from './runtime'
import type {
  BackendStatus,
  KeyStatusMap,
  LocalEnvironmentState,
  LocalEnvironmentVerificationTarget,
  MicrophonePermissionStatus,
  ProviderModels,
  RuntimeEventEnvelope,
  RuntimeEventType,
  RuntimeInvalidateScope,
  RuntimeRevisionMap,
  RuntimeSnapshot,
  RuntimeStoreState,
  SmartContextAccessStatus,
  UsageStats,
  AppConfig,
} from '../types'

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 5000] as const
const EVENT_TYPES: RuntimeEventType[] = [
  'snapshot',
  'status',
  'usage',
  'pending_paste',
  'notification',
  'smart_preview',
  'pending_action_review',
  'live_transcription',
  'history_invalidated',
  'inbox_invalidated',
  'skills_invalidated',
  'domains_invalidated',
  'writing_tools_invalidated',
  'config_changed',
  'providers_changed',
  'heartbeat',
]

type RuntimeSnapshotPayload = {
  status: BackendStatus | null
  usage: UsageStats | null
  config: AppConfig | null
  keys_set: KeyStatusMap
  revisions: RuntimeRevisionMap
}

type RefreshLocalEnvironmentOptions = {
  mode?: 'check' | 'verify'
  target?: LocalEnvironmentVerificationTarget
  quiet?: boolean
  promptContext?: boolean
}

const INITIAL_REVISIONS: RuntimeRevisionMap = {
  config: 0,
  providers: 0,
  history: 0,
  inbox: 0,
  skills: 0,
  domains: 0,
  writing_tools: 0,
  usage: 0,
}

const INITIAL_INVALIDATION_TOKENS: Record<RuntimeInvalidateScope, number> = {
  config: 0,
  providers: 0,
  history: 0,
  inbox: 0,
  skills: 0,
  domains: 0,
  writing_tools: 0,
  usage: 0,
}

const INITIAL_SNAPSHOT: RuntimeSnapshot = {
  status: null,
  config: null,
  keysSet: {},
  providerModels: null,
  usageStats: null,
  revisions: INITIAL_REVISIONS,
}

const INITIAL_CONTEXT_ACCESS: SmartContextAccessStatus = {
  status: 'unavailable',
  message: 'Checking context access…',
  context: null,
}

const INITIAL_LOCAL_ENVIRONMENT: LocalEnvironmentState = {
  status: 'idle',
  error: null,
  updatedAt: null,
  microphoneAccess: 'unknown',
  accessibilityTrusted: false,
  contextAccess: INITIAL_CONTEXT_ACCESS,
  verifyingTarget: null,
}

const ENVIRONMENT_VERIFY_DELAYS_MS = [350, 800, 1500] as const

const INITIAL_STATE: RuntimeStoreState = {
  connectionState: 'connecting',
  connectionError: null,
  hasSnapshot: false,
  lastEventAt: null,
  connectedAt: null,
  lastAppliedSeq: 0,
  invalidationTokens: INITIAL_INVALIDATION_TOKENS,
  snapshot: INITIAL_SNAPSHOT,
  localEnvironment: INITIAL_LOCAL_ENVIRONMENT,
}

type Listener = () => void

function cloneInvalidationTokens(tokens: Record<RuntimeInvalidateScope, number>) {
  return {
    config: tokens.config,
    providers: tokens.providers,
    history: tokens.history,
    inbox: tokens.inbox,
    skills: tokens.skills,
    domains: tokens.domains,
    writing_tools: tokens.writing_tools,
    usage: tokens.usage,
  }
}

function createEnvironmentState(overrides?: Partial<LocalEnvironmentState>): LocalEnvironmentState {
  return {
    status: 'idle',
    error: null,
    updatedAt: null,
    microphoneAccess: 'unknown',
    accessibilityTrusted: false,
    contextAccess: INITIAL_CONTEXT_ACCESS,
    verifyingTarget: null,
    ...overrides,
  }
}

function hasImpossibleDeliveryState(status: BackendStatus | null) {
  if (!status || status.phase !== 'preparing_paste') {
    return false
  }

  return !status.is_processing && !status.pending_paste && !status.pending_notification && !status.pending_action_review
}

export class RuntimeStore {
  private state: RuntimeStoreState = INITIAL_STATE
  private listeners = new Set<Listener>()
  private started = false
  private eventStream: RuntimeEventStream | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private providerModelsRequest: Promise<void> | null = null
  private statusResyncRequest: Promise<void> | null = null
  private environmentRequests = createLatestRequestController()
  private windowListenersAttached = false
  private readonly handleWindowFocus = () => {
    void this.refreshLocalEnvironment({ quiet: true })
  }
  private readonly handleVisibilityChange = () => {
    if (!document.hidden) {
      void this.refreshLocalEnvironment({ quiet: true })
    }
  }
  private readonly createEventStream: RuntimeEventStreamFactory

  constructor(createEventStream: RuntimeEventStreamFactory = createFetchRuntimeEventStream) {
    this.createEventStream = createEventStream
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener)
    if (!this.started) {
      this.started = true
      this.attachWindowListeners()
      void this.refreshLocalEnvironment()
      void this.connect()
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.state

  dispose() {
    this.started = false
    this.clearReconnectTimer()
    this.closeEventStream()
    this.reconnectAttempt = 0
    this.providerModelsRequest = null
    this.statusResyncRequest = null
    this.environmentRequests.cancel()
    this.detachWindowListeners()
    this.state = INITIAL_STATE
  }

  private emit() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private setState(updater: RuntimeStoreState | ((current: RuntimeStoreState) => RuntimeStoreState)) {
    this.state = typeof updater === 'function' ? updater(this.state) : updater
    this.emit()
  }

  private attachWindowListeners() {
    if (this.windowListenersAttached || typeof window === 'undefined') {
      return
    }

    window.addEventListener('focus', this.handleWindowFocus)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.windowListenersAttached = true
  }

  private detachWindowListeners() {
    if (!this.windowListenersAttached || typeof window === 'undefined') {
      return
    }

    window.removeEventListener('focus', this.handleWindowFocus)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.windowListenersAttached = false
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private closeEventStream() {
    if (this.eventStream) {
      this.eventStream.close()
      this.eventStream = null
    }
  }

  private scheduleReconnect(error: unknown) {
    this.closeEventStream()
    this.clearReconnectTimer()

    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt += 1
    const message = getErrorMessage(error, 'Realtime connection lost. Reconnecting…')

    this.setState((current) => ({
      ...current,
      connectionState: current.hasSnapshot ? 'stale' : 'error',
      connectionError: message,
    }))

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private shouldApplyEnvelope(envelope: RuntimeEventEnvelope) {
    if (envelope.type === 'heartbeat') {
      return true
    }

    return envelope.seq > this.state.lastAppliedSeq
  }

  private normalizeLocalEnvironment(
    settled: {
      microphoneAccess: { status: 'fulfilled'; value: string } | { status: 'rejected'; reason: unknown }
      accessibilityTrusted: { status: 'fulfilled'; value: boolean } | { status: 'rejected'; reason: unknown }
      contextAccess: { status: 'fulfilled'; value: SmartContextAccessStatus } | { status: 'rejected'; reason: unknown }
    },
    current: LocalEnvironmentState,
  ): LocalEnvironmentState {
    const microphoneAccess = settled.microphoneAccess.status === 'fulfilled'
      ? (settled.microphoneAccess.value || 'unknown') as MicrophonePermissionStatus
      : current.microphoneAccess
    const accessibilityTrusted = settled.accessibilityTrusted.status === 'fulfilled'
      ? Boolean(settled.accessibilityTrusted.value)
      : current.accessibilityTrusted
    const contextAccess = settled.contextAccess.status === 'fulfilled'
      ? settled.contextAccess.value || INITIAL_CONTEXT_ACCESS
      : current.contextAccess

    return createEnvironmentState({
      status: 'ready',
      error: null,
      updatedAt: Date.now(),
      microphoneAccess,
      accessibilityTrusted,
      contextAccess,
      verifyingTarget: null,
    })
  }

  private isVerificationSatisfied(state: LocalEnvironmentState, target: LocalEnvironmentVerificationTarget) {
    switch (target) {
      case 'microphone':
        return state.microphoneAccess === 'granted'
      case 'accessibility':
        return state.accessibilityTrusted
      case 'context':
        return state.contextAccess.status !== 'unavailable'
      case 'all':
        return state.microphoneAccess === 'granted' && state.accessibilityTrusted && state.contextAccess.status !== 'unavailable'
      default:
        return true
    }
  }

  async refreshLocalEnvironment(options?: RefreshLocalEnvironmentOptions) {
    const mode = options?.mode ?? 'check'
    const target = options?.target ?? null
    const quiet = options?.quiet ?? false
    const promptContext = options?.promptContext ?? false
    const request = this.environmentRequests.begin()

    this.setState((current) => ({
      ...current,
      localEnvironment: createEnvironmentState({
        ...current.localEnvironment,
        status: mode === 'verify' ? 'verifying' : 'checking',
        error: quiet ? current.localEnvironment.error : null,
        verifyingTarget: mode === 'verify' ? target : null,
      }),
    }))

    const maxAttempts = mode === 'verify' ? ENVIRONMENT_VERIFY_DELAYS_MS.length + 1 : 1

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const settled = await retryRead(async () => (
          settleRecord({
            microphoneAccess: window.windowControls?.getCapturePermissionStatus?.() ?? Promise.resolve('unknown'),
            accessibilityTrusted: window.windowControls?.checkAccessibility?.() ?? Promise.resolve(false),
            contextAccess: promptContext
              ? window.windowControls?.promptSmartContextAccess?.() ?? Promise.resolve(INITIAL_CONTEXT_ACCESS)
              : window.windowControls?.checkSmartContextAccess?.() ?? Promise.resolve(INITIAL_CONTEXT_ACCESS),
          })
        ), { signal: request.signal })

        if (!this.environmentRequests.isLatest(request.token)) {
          return
        }

        const nextEnvironment = this.normalizeLocalEnvironment(settled, this.state.localEnvironment)
        this.setState((current) => ({
          ...current,
          localEnvironment: nextEnvironment,
        }))

        if (mode !== 'verify' || this.isVerificationSatisfied(nextEnvironment, target) || attempt === maxAttempts - 1) {
          return nextEnvironment
        }

        await delay(ENVIRONMENT_VERIFY_DELAYS_MS[attempt], request.signal)
      } catch (error) {
        if (request.signal.aborted) {
          return null
        }

        const hasLastKnown = Boolean(this.state.localEnvironment.updatedAt)
        this.setState((current) => ({
          ...current,
          localEnvironment: createEnvironmentState({
            ...current.localEnvironment,
            status: hasLastKnown ? 'stale' : 'error',
            error: getErrorMessage(error, 'Unable to refresh local permissions right now.'),
            verifyingTarget: null,
          }),
        }))
        return null
      }
    }

    return null
  }

  async refreshStatus(minSeq = this.state.lastAppliedSeq) {
    if (this.statusResyncRequest) {
      return this.statusResyncRequest
    }

    this.statusResyncRequest = retryRead(async (signal) => {
      const status = await apiGet<BackendStatus>('/status', { timeout: 10000, signal }).then(responseData)
      this.setState((current) => {
        if (current.lastAppliedSeq > minSeq) {
          return current
        }

        return {
          ...current,
          snapshot: {
            ...current.snapshot,
            status,
          },
        }
      })
    }).finally(() => {
      this.statusResyncRequest = null
    })

    return this.statusResyncRequest
  }

  private mergeRevisions(nextRevisions: RuntimeRevisionMap) {
    this.setState((current) => {
      const nextTokens = cloneInvalidationTokens(current.invalidationTokens)
      let tokensChanged = false

      ;(Object.keys(nextRevisions) as RuntimeInvalidateScope[]).forEach((scope) => {
        if ((current.snapshot.revisions[scope] ?? 0) !== nextRevisions[scope]) {
          nextTokens[scope] += 1
          tokensChanged = true
        }
      })

      return {
        ...current,
        invalidationTokens: tokensChanged ? nextTokens : current.invalidationTokens,
        snapshot: {
          ...current.snapshot,
          revisions: nextRevisions,
        },
      }
    })
  }

  private applySnapshot(payload: RuntimeSnapshotPayload, seq: number) {
    this.setState((current) => ({
      ...current,
      hasSnapshot: true,
      connectionState: 'connected',
      connectionError: null,
      connectedAt: current.connectedAt ?? Date.now(),
      lastEventAt: Date.now(),
      lastAppliedSeq: Math.max(current.lastAppliedSeq, seq),
      snapshot: {
        ...current.snapshot,
        status: payload.status,
        config: payload.config,
        keysSet: payload.keys_set || {},
        usageStats: payload.usage,
      },
    }))
    this.mergeRevisions(payload.revisions || INITIAL_REVISIONS)
    if (hasImpossibleDeliveryState(payload.status)) {
      void this.refreshStatus(seq)
    }
    if (!this.state.snapshot.providerModels) {
      void this.refreshProviderModels()
    }
  }

  private applyInvalidation(scope: RuntimeInvalidateScope, revision: number) {
    this.mergeRevisions({
      ...this.state.snapshot.revisions,
      [scope]: revision,
    })
    if (scope === 'providers') {
      void this.refreshProviderModels()
    }
  }

  private applyEvent(envelope: RuntimeEventEnvelope) {
    if (!this.shouldApplyEnvelope(envelope)) {
      return
    }

    if (envelope.type === 'heartbeat') {
      this.setState((current) => ({
        ...current,
        lastEventAt: Date.now(),
      }))
      return
    }

    this.setState((current) => ({
      ...current,
      connectionState: 'connected',
      connectionError: null,
      hasSnapshot: current.hasSnapshot || envelope.type === 'snapshot',
      lastEventAt: Date.now(),
      connectedAt: current.connectedAt ?? Date.now(),
      lastAppliedSeq: Math.max(current.lastAppliedSeq, envelope.seq),
    }))

    switch (envelope.type) {
      case 'snapshot':
        this.applySnapshot(envelope.data as RuntimeSnapshotPayload, envelope.seq)
        return
      case 'status':
        this.setState((current) => ({
          ...current,
          snapshot: {
            ...current.snapshot,
            status: envelope.data as BackendStatus,
          },
        }))
        if (hasImpossibleDeliveryState(envelope.data as BackendStatus)) {
          void this.refreshStatus(envelope.seq)
        }
        return
      case 'pending_paste':
      case 'notification':
        return
      case 'smart_preview':
        this.setState((current) => ({
          ...current,
          snapshot: {
            ...current.snapshot,
            status: current.snapshot.status
              ? {
                  ...current.snapshot.status,
                  smart_preview: envelope.data as BackendStatus['smart_preview'],
                }
              : current.snapshot.status,
          },
        }))
        return
      case 'pending_action_review':
        this.setState((current) => ({
          ...current,
          snapshot: {
            ...current.snapshot,
            status: current.snapshot.status
              ? {
                  ...current.snapshot.status,
                  pending_action_review: envelope.data as BackendStatus['pending_action_review'],
                }
              : current.snapshot.status,
          },
        }))
        return
      case 'live_transcription':
        this.setState((current) => ({
          ...current,
          snapshot: {
            ...current.snapshot,
            status: current.snapshot.status
              ? {
                  ...current.snapshot.status,
                  live_transcription: envelope.data as BackendStatus['live_transcription'],
                }
              : current.snapshot.status,
          },
        }))
        return
      case 'usage': {
        const payload = envelope.data as { usage: UsageStats | null; revision: number }
        this.setState((current) => ({
          ...current,
          snapshot: {
            ...current.snapshot,
            usageStats: payload.usage,
          },
        }))
        this.applyInvalidation('usage', payload.revision)
        return
      }
      case 'config_changed': {
        const payload = envelope.data as { config: AppConfig | null; revision: number }
        this.setState((current) => ({
          ...current,
          snapshot: {
            ...current.snapshot,
            config: payload.config,
          },
        }))
        this.applyInvalidation('config', payload.revision)
        return
      }
      case 'providers_changed': {
        const payload = envelope.data as { keys_set: KeyStatusMap; revision: number }
        this.setState((current) => ({
          ...current,
          snapshot: {
            ...current.snapshot,
            keysSet: payload.keys_set || {},
          },
        }))
        this.applyInvalidation('providers', payload.revision)
        return
      }
      case 'history_invalidated':
        this.applyInvalidation('history', Number((envelope.data as { revision?: number })?.revision || 0))
        return
      case 'inbox_invalidated':
        this.applyInvalidation('inbox', Number((envelope.data as { revision?: number })?.revision || 0))
        return
      case 'skills_invalidated':
        this.applyInvalidation('skills', Number((envelope.data as { revision?: number })?.revision || 0))
        return
      case 'domains_invalidated':
        this.applyInvalidation('domains', Number((envelope.data as { revision?: number })?.revision || 0))
        return
      case 'writing_tools_invalidated':
        this.applyInvalidation('writing_tools', Number((envelope.data as { revision?: number })?.revision || 0))
        return
    }
  }

  async refreshProviderModels() {
    if (this.providerModelsRequest) {
      return this.providerModelsRequest
    }

    this.providerModelsRequest = retryRead(async (signal) => {
      const models = await apiGet<ProviderModels>('/providers/models', { timeout: 10000, signal }).then(responseData)
      this.setState((current) => ({
        ...current,
        snapshot: {
          ...current.snapshot,
          providerModels: models,
        },
      }))
    }).catch((error) => {
      this.setState((current) => ({
        ...current,
        connectionError: current.connectionError || getErrorMessage(error, 'Provider models could not refresh right now.'),
      }))
    }).finally(() => {
      this.providerModelsRequest = null
    })

    return this.providerModelsRequest
  }

  private async connect() {
    this.clearReconnectTimer()
    this.closeEventStream()

    this.setState((current) => ({
      ...current,
      connectionState: current.hasSnapshot ? 'stale' : 'connecting',
      connectionError: current.connectionState === 'error' ? current.connectionError : null,
    }))

    try {
      const requestContext = await getBackendRequestContext()
      const nextStream = await this.createEventStream(requestContext)
      this.eventStream = nextStream

      nextStream.onopen = () => {
        if (this.eventStream !== nextStream) return
        const shouldResyncStatus = this.state.hasSnapshot
        this.reconnectAttempt = 0
        this.setState((current) => ({
          ...current,
          connectionState: 'connected',
          connectionError: null,
          connectedAt: Date.now(),
        }))
        if (shouldResyncStatus) {
          void this.refreshStatus(this.state.lastAppliedSeq)
        }
        void this.refreshLocalEnvironment({ quiet: true })
      }

      const handleMessage = (event: MessageEvent<string>) => {
        if (this.eventStream !== nextStream) return
        try {
          const envelope = JSON.parse(event.data) as RuntimeEventEnvelope
          this.applyEvent(envelope)
        } catch (error) {
          this.scheduleReconnect(error)
        }
      }

      EVENT_TYPES.forEach((eventType) => {
        nextStream.addEventListener(eventType, handleMessage as EventListener)
      })

      nextStream.onerror = () => {
        if (this.eventStream !== nextStream) return
        this.scheduleReconnect(new Error('Realtime connection interrupted.'))
      }
    } catch (error) {
      this.scheduleReconnect(error)
    }
  }
}

export function createRuntimeStore(createEventStream?: RuntimeEventStreamFactory) {
  return new RuntimeStore(createEventStream)
}

const runtimeStore = createRuntimeStore()

export function useRuntimeStore<T>(selector: (state: RuntimeStoreState) => T) {
  return useSyncExternalStore(runtimeStore.subscribe, () => selector(runtimeStore.getSnapshot()))
}

export function getRuntimeStoreState() {
  return runtimeStore.getSnapshot()
}

export function refreshRuntimeLocalEnvironment(options?: RefreshLocalEnvironmentOptions) {
  return runtimeStore.refreshLocalEnvironment(options)
}

export function refreshRuntimeStatus(minSeq?: number) {
  return runtimeStore.refreshStatus(minSeq)
}

export function refreshRuntimeProviderModels() {
  return runtimeStore.refreshProviderModels()
}
