import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { DISPLAY_NAME } from '../shared/branding'
import { BrandedProgressLoader } from './components/BrandedProgressLoader'
import { ArrowRightIcon, CheckIcon, InboxIcon, MicIcon, SparkIcon, WarningIcon } from './components/BrandIcons'
import { apiGet } from './lib/api'
import { getErrorMessage, isAbortError } from './lib/errors'
import { createLibraryItems, formatLibraryItemLabel, formatLibraryTimestamp } from './lib/library'
import { providerRequiresKey } from './lib/onboarding'
import { buildLibraryRoute, buildSettingsRoute } from './lib/routes'
import { selectOnboardingState, selectPrimaryAttentionIssue, selectReadinessState } from './lib/runtimeSelectors'
import { createLatestRequestController, responseData, retryRead, settleRecord, withSignal } from './lib/runtime'
import { refreshRuntimeLocalEnvironment, useRuntimeStore } from './lib/runtimeStore'
import { useCaptureStateSubscription, useLaunchContextState } from './hooks/useDesktopBridgeState'
import type {
  CaptureState,
  HistoryItem,
  InboxNote,
  SectionLoadState,
  RecordingMode,
} from './types'

type InboxResponse = { notes: InboxNote[] }
const EMPTY_CAPTURE_STATE: CaptureState = {
  is_recording: false,
  is_testing: false,
  mode: null,
  amplitude: 0,
  error: null,
  active_device_id: null,
  active_device_label: null,
  fallback_to_default: false,
  fallback_notice: null,
}

function toneClasses(tone: 'good' | 'warn' | 'danger' | 'neutral') {
  if (tone === 'good') return 'border-semantic-success/18 bg-semantic-success/10 text-semantic-success'
  if (tone === 'warn') return 'border-semantic-warning/18 bg-semantic-warning/10 text-semantic-warning'
  if (tone === 'danger') return 'border-semantic-error/18 bg-semantic-error/10 text-semantic-error'
  return 'border-white/8 bg-white/[0.04] text-text-secondary'
}

function StatusPill({
  label,
  tone,
}: {
  label: string
  tone: 'good' | 'warn' | 'danger' | 'neutral'
}) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] ${toneClasses(tone)}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}

function ActionButton({
  title,
  detail,
  icon,
  onClick,
}: {
  title: string
  detail: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-card group rounded-[28px] p-5 text-left transition-transform hover:-translate-y-0.5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="widget-control flex h-11 w-11 items-center justify-center rounded-2xl text-text-primary">
          {icon}
        </div>
        <ArrowRightIcon size={16} className="text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-text-primary" />
      </div>
      <div className="mt-5 text-lg font-semibold tracking-[-0.02em] text-text-primary">{title}</div>
      <p className="mt-2 text-sm leading-6 text-text-secondary">{detail}</p>
    </button>
  )
}

function QuickStatusCard({
  label,
  detail,
  tone,
}: {
  label: string
  detail: string
  tone: 'good' | 'warn' | 'danger' | 'neutral'
}) {
  return (
    <div className="section-intro-panel rounded-[22px] border border-white/6 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <StatusPill label={tone === 'good' ? 'Ready' : tone === 'warn' ? 'Attention' : tone === 'danger' ? 'Blocked' : 'Idle'} tone={tone} />
      </div>
      <p className="mt-2 text-sm leading-6 text-text-secondary">{detail}</p>
    </div>
  )
}

function ExampleCard({
  title,
  example,
}: {
  title: string
  example: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-black/22 p-4">
      <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{title}</div>
      <div className="mt-3 font-mono text-sm leading-7 text-text-primary">{example}</div>
    </div>
  )
}

function ChecklistRow({
  title,
  description,
  completed,
  action,
}: {
  title: string
  description: string
  completed: boolean
  action?: ReactNode
}) {
  return (
    <div className={`rounded-2xl border p-4 ${completed ? 'border-semantic-success/20 bg-semantic-success/8' : 'border-white/6 bg-white/[0.02]'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className={`flex h-8 w-8 items-center justify-center rounded-full ${completed ? 'bg-semantic-success/18 text-semantic-success' : 'bg-white/[0.05] text-text-muted'}`}>
              {completed ? <CheckIcon size={14} /> : <WarningIcon size={14} />}
            </div>
            <div className="text-sm font-medium text-text-primary">{title}</div>
          </div>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : <StatusPill label={completed ? 'Done' : 'Pending'} tone={completed ? 'good' : 'warn'} />}
      </div>
    </div>
  )
}

const INITIAL_SECTION_STATE: SectionLoadState = {
  status: 'idle',
  error: null,
  stale: false,
  updatedAt: null,
}

export function HomeView() {
  const navigate = useNavigate()
  const runtime = useRuntimeStore((state) => state)
  const { connectionState, connectionError, invalidationTokens, localEnvironment, snapshot } = runtime
  const config = snapshot.config

  const [recentState, setRecentState] = useState<SectionLoadState>(INITIAL_SECTION_STATE)
  const [actionError, setActionError] = useState<string | null>(null)
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const [notes, setNotes] = useState<InboxNote[]>([])
  const [launchContext, setLaunchContext] = useLaunchContextState()
  const [captureState] = useCaptureStateSubscription(EMPTY_CAPTURE_STATE)
  const recentRequestsRef = useRef(createLatestRequestController())
  const notesRef = useRef<InboxNote[]>([])
  const historyRef = useRef<HistoryItem[]>([])
  const recentStateRef = useRef<SectionLoadState>(INITIAL_SECTION_STATE)

  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  useEffect(() => {
    historyRef.current = historyItems
  }, [historyItems])

  useEffect(() => {
    recentStateRef.current = recentState
  }, [recentState])

  const loadRecentActivity = useCallback(async (quiet = false) => {
    const request = recentRequestsRef.current.begin()
    if (!quiet || (!historyRef.current.length && !notesRef.current.length)) {
      setRecentState((current) => ({
        ...current,
        status: 'loading',
        error: null,
      }))
    }

    try {
      const settled = await retryRead(async (signal) => (
        settleRecord<{
          history: Promise<{ items: HistoryItem[] }>
          notes: Promise<InboxResponse>
        }>({
          history: apiGet<{ items: HistoryItem[] }>('/history', withSignal({ timeout: 10000 }, signal)).then(responseData),
          notes: apiGet<InboxResponse>('/inbox', withSignal({ timeout: 10000 }, signal)).then(responseData),
        })
      ), { signal: request.signal })

      if (!recentRequestsRef.current.isLatest(request.token)) return

      if (settled.history.status === 'fulfilled') {
        setHistoryItems(settled.history.value.items || [])
      }
      if (settled.notes.status === 'fulfilled') {
        setNotes(settled.notes.value.notes || [])
      }

      const errors = [
        settled.history.status === 'rejected' ? 'Recent runs' : null,
        settled.notes.status === 'rejected' ? 'Notes' : null,
      ].filter(Boolean)

      setRecentState({
        status: errors.length ? 'stale' : 'ready',
        error: errors.length ? `${errors.join(' and ')} could not refresh. Showing the last successful load.` : null,
        stale: Boolean(errors.length),
        updatedAt: Date.now(),
      })
    } catch (nextError: unknown) {
      if (isAbortError(nextError) || !recentRequestsRef.current.isLatest(request.token)) return
      const hasLastGoodData = historyRef.current.length > 0 || notesRef.current.length > 0
      setRecentState({
        status: hasLastGoodData ? 'stale' : 'error',
        error: getErrorMessage(nextError, 'Unable to load recent activity right now.'),
        stale: hasLastGoodData,
        updatedAt: recentStateRef.current.updatedAt,
      })
    }
  }, [])

  useEffect(() => {
    const recentRequests = recentRequestsRef.current
    const initialLoadTimer = window.setTimeout(() => {
      void loadRecentActivity()
    }, 0)
    return () => {
      window.clearTimeout(initialLoadTimer)
      recentRequests.cancel()
    }
  }, [loadRecentActivity])

  useEffect(() => {
    const onFocus = () => {
      void loadRecentActivity(true)
    }

    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [loadRecentActivity])

  useEffect(() => {
    if (invalidationTokens.history === 0 && invalidationTokens.inbox === 0) return
    const refreshTimer = window.setTimeout(() => {
      void loadRecentActivity(true)
    }, 0)
    return () => {
      window.clearTimeout(refreshTimer)
    }
  }, [invalidationTokens.history, invalidationTokens.inbox, loadRecentActivity])

  const toggleRecording = async (mode: RecordingMode) => {
    if (!config) return

    const onboardingState = selectOnboardingState(runtime)
    if (!onboardingState) {
      setActionError(`${DISPLAY_NAME} is still checking local readiness.`)
      return
    }
    if (mode === 'dictation' && !onboardingState.dictationReady) {
      navigate(buildSettingsRoute('voice'))
      setActionError('Dictation still needs setup. Finish Voice settings and try again.')
      return
    }
    if (mode === 'smart_transform' && !onboardingState.rewriteReady) {
      navigate(buildSettingsRoute(onboardingState.dictationReady ? 'rewrite' : 'voice'))
      setActionError('Smart is not ready yet. Finish the missing setup first.')
      return
    }

    try {
      await window.windowControls?.toggleRecording?.(mode)
      setActionError(null)
    } catch (nextError: unknown) {
      setActionError(getErrorMessage(nextError, `${DISPLAY_NAME} is not ready yet. Open Settings and try again.`))
    }
  }

  const requestMicrophone = async () => {
    const nextStatus = await window.windowControls?.requestCapturePermission?.()
    if (nextStatus !== 'granted') {
      window.windowControls?.openPrivacySettings?.('microphone')
    }
    void refreshRuntimeLocalEnvironment({ mode: 'verify', target: 'microphone' })
  }

  const requestAccessibility = async () => {
    window.windowControls?.promptAccessibility?.()
    window.windowControls?.openPrivacySettings?.('accessibility')
    void refreshRuntimeLocalEnvironment({ mode: 'verify', target: 'accessibility' })
  }

  const completePackagedOnboarding = async () => {
    const nextContext = await window.windowControls?.completePackagedOnboarding?.()
    if (nextContext) setLaunchContext(nextContext)
  }

  const dismissPackagedOnboarding = async () => {
    const nextContext = await window.windowControls?.dismissPackagedOnboarding?.()
    if (nextContext) setLaunchContext(nextContext)
  }

  const readinessState = useMemo(() => selectReadinessState(runtime), [runtime])
  const onboardingState = useMemo(() => selectOnboardingState(runtime), [runtime])
  const primaryAttentionIssue = useMemo(() => selectPrimaryAttentionIssue(runtime), [runtime])

  const recentItems = useMemo(
    () => createLibraryItems(notes, historyItems).slice(0, 3),
    [historyItems, notes],
  )

  const showChecklist = Boolean(onboardingState && !onboardingState.completed)
  const showRewriteFollowUp = Boolean(onboardingState?.completed && !onboardingState.rewriteProviderReady)
  const isDictationRecording = captureState.is_recording && captureState.mode === 'dictation'
  const isRewriteRecording = captureState.is_recording && captureState.mode === 'smart_transform'
  const environmentPending = localEnvironment.status === 'checking' || localEnvironment.status === 'verifying'
  const environmentMessage = primaryAttentionIssue?.tone === 'neutral'
    ? primaryAttentionIssue.detail
    : localEnvironment.error
  const microphoneTone = environmentPending
    ? 'neutral'
    : readinessState?.microphoneReady
      ? 'good'
      : 'warn'
  const accessibilityTone = environmentPending
    ? 'neutral'
    : readinessState?.accessibilityReady
      ? 'good'
      : 'danger'

  if (connectionState === 'connecting' && !config) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <BrandedProgressLoader
          title={`Preparing ${DISPLAY_NAME}`}
          subtitle="Loading your voice workspace."
        />
      </div>
    )
  }

  if (connectionState === 'error' && !config) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <div className="w-full max-w-xl rounded-[28px] border border-semantic-error/20 bg-[linear-gradient(180deg,rgba(42,11,18,0.75),rgba(11,8,12,0.9))] p-8">
          <div className="text-lg font-semibold text-text-primary">{`${DISPLAY_NAME} is not ready`}</div>
          <p className="mt-3 text-sm leading-7 text-text-secondary">{connectionError || 'Unable to load the current workspace.'}</p>
          <div className="mt-6">
            <button
              type="button"
              onClick={() => void refreshRuntimeLocalEnvironment()}
              className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-white/[0.08]"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-6xl pb-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-text-muted">Home</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text-primary">Talk, polish, and keep moving.</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-text-secondary">
              {`${DISPLAY_NAME} is ready when voice capture, paste, and your provider choices are aligned. Use this screen for the daily path and keep the heavier controls in Settings.`}
            </p>
          </div>
          {readinessState ? (
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill label={environmentPending ? 'Checking access' : readinessState.dictationReady ? 'Dictation ready' : 'Dictation needs setup'} tone={environmentPending ? 'neutral' : readinessState.dictationReady ? 'good' : 'warn'} />
              <StatusPill label={environmentPending ? 'Verifying readiness' : readinessState.rewriteReady ? 'Smart ready' : 'Smart optional'} tone={environmentPending ? 'neutral' : readinessState.rewriteReady ? 'good' : 'neutral'} />
            </div>
          ) : null}
        </div>

        {actionError || connectionError || environmentMessage ? (
          <div className="mt-6 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
            {actionError || connectionError || environmentMessage}
          </div>
        ) : null}

        <section className="mt-6 grid gap-5 lg:grid-cols-3">
          <ActionButton
            title={isDictationRecording ? 'Stop dictation' : 'Dictate'}
            detail={isDictationRecording ? 'Recording right now. Stop when you are ready to paste.' : 'Capture speech and paste it back into the app you were using.'}
            icon={<MicIcon size={18} />}
            onClick={() => void toggleRecording('dictation')}
          />
          <ActionButton
            title={isRewriteRecording ? 'Stop Smart' : 'Smart'}
            detail={isRewriteRecording ? 'Recording right now. Stop when you are ready for Smart output.' : 'Turn rough speech into a cleaner message, note, or formatted result.'}
            icon={<SparkIcon size={18} />}
            onClick={() => void toggleRecording('smart_transform')}
          />
          <ActionButton
            title="Open Notes"
            detail="Jump into the unified Library and focus on saved notes first."
            icon={<InboxIcon size={18} />}
            onClick={() => navigate(buildLibraryRoute('notes'))}
          />
        </section>

        {readinessState ? (
          <section className="mt-8">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Readiness</div>
                <div className="mt-2 text-lg font-semibold text-text-primary">Current voice path</div>
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-4">
              <QuickStatusCard
                label="Microphone"
                detail={environmentPending ? 'Confirming microphone access with macOS.' : readinessState.microphoneReady ? 'Recording access is enabled.' : 'Enable microphone access before dictating.'}
                tone={microphoneTone}
              />
              <QuickStatusCard
                label="Accessibility"
                detail={environmentPending ? 'Confirming Accessibility access with macOS.' : readinessState.accessibilityReady ? 'Paste handoff and shortcuts are ready.' : 'Enable Accessibility for shortcuts and paste handoff.'}
                tone={accessibilityTone}
              />
              <QuickStatusCard
                label="Dictation provider"
                detail={readinessState.dictationProviderReady
                  ? providerRequiresKey(config?.stt.provider || '') ? `${config?.stt.provider || 'Provider'} is configured.` : `${config?.stt.provider || 'Provider'} is selected locally.`
                  : providerRequiresKey(config?.stt.provider || '') ? `${config?.stt.provider || 'Provider'} needs an API key.` : `${config?.stt.provider || 'Provider'} still needs local setup.`}
                tone={readinessState.dictationProviderReady ? 'good' : 'warn'}
              />
              <QuickStatusCard
                label="Smart provider"
                detail={readinessState.rewriteProviderReady
                  ? providerRequiresKey(config?.llm.provider || '') ? `${config?.llm.provider || 'Provider'} is configured.` : `${config?.llm.provider || 'Provider'} is selected. Add cloud keys only if you want hosted providers.`
                  : providerRequiresKey(config?.llm.provider || '') ? `${config?.llm.provider || 'Provider'} is optional until you want a hosted Smart provider.` : `${config?.llm.provider || 'Provider'} still needs local setup.`}
                tone={readinessState.rewriteProviderReady ? 'good' : 'neutral'}
              />
            </div>
          </section>
        ) : null}

        {showChecklist && onboardingState ? (
          <section className="mt-8 glass-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">First success</div>
                <h2 className="mt-2 text-xl font-semibold text-text-primary">Finish the voice checklist</h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
                  This sequence is intentionally short: get dictation working first, then unlock Smart when you want it.
                </p>
              </div>
              <StatusPill label={onboardingState.completed ? 'Ready to finish' : 'In progress'} tone={onboardingState.completed ? 'good' : 'warn'} />
            </div>

            <div className="mt-5 grid gap-4">
              <ChecklistRow
                title="Enable microphone"
                description={`Grant microphone access so ${DISPLAY_NAME} can listen for speech.`}
                completed={onboardingState.microphoneReady}
                action={!onboardingState.microphoneReady ? (
                  <button
                    type="button"
                    onClick={() => void requestMicrophone()}
                    className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-white/[0.08]"
                  >
                    Enable microphone
                  </button>
                ) : undefined}
              />
              <ChecklistRow
                title="Enable Accessibility"
                description="Accessibility powers shortcuts and reliable paste handoff."
                completed={onboardingState.accessibilityReady}
                action={!onboardingState.accessibilityReady ? (
                  <button
                    type="button"
                    onClick={() => void requestAccessibility()}
                    className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-white/[0.08]"
                  >
                    Enable Accessibility
                  </button>
                ) : undefined}
              />
              <ChecklistRow
                title="Configure dictation"
                description="Use one provider path for speech recognition first. Groq is the fastest one-key option."
                completed={onboardingState.dictationProviderReady}
                action={!onboardingState.dictationProviderReady ? (
                  <button
                    type="button"
                    onClick={() => navigate(buildSettingsRoute('voice'))}
                    className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-white/[0.08]"
                  >
                    Open voice settings
                  </button>
                ) : undefined}
              />
              <ChecklistRow
                title="Use Dictate once"
                description="Run one real dictation so you know the capture, transcription, and paste path works."
                completed={onboardingState.dictationTested}
                action={!onboardingState.dictationTested ? (
                  <button
                    type="button"
                    onClick={() => void toggleRecording('dictation')}
                    className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-white/[0.08]"
                  >
                    {isDictationRecording ? 'Stop dictation' : 'Start dictation'}
                  </button>
                ) : undefined}
              />
            </div>

            {launchContext?.is_packaged && !launchContext.onboarding_completed ? (
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void dismissPackagedOnboarding()}
                  className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-white/[0.06]"
                >
                  Continue later
                </button>
                <button
                  type="button"
                  onClick={() => void completePackagedOnboarding()}
                  disabled={!onboardingState.completed}
                  className="rounded-2xl border border-accent-primary/20 bg-accent-primary px-4 py-2.5 text-sm font-medium text-[#021318] transition-colors hover:bg-[#46f0f4] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {onboardingState.completed ? 'Finish setup' : 'Finish after dictation works'}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {showRewriteFollowUp ? (
          <section className="mt-6 rounded-[24px] border border-white/6 bg-white/[0.02] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-text-primary">Smart is optional until you need it</div>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
                  Dictation is working. When you want the polished Smart path, add an LLM provider in Settings. Groq remains the simplest one-key option for both speech and Smart.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate(buildSettingsRoute('rewrite'))}
                className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-white/[0.08]"
              >
                Open Smart settings
              </button>
            </div>
          </section>
        ) : null}

        <section className="mt-8 grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="glass-card p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Try saying</div>
                <h2 className="mt-2 text-xl font-semibold text-text-primary">Three fast starters</h2>
              </div>
            </div>
            <div className="mt-5 grid gap-4">
              <ExampleCard title="Dictate" example="project update new paragraph carrier confirmed pickup" />
              <ExampleCard title="Smart" example="draft a short customer update about the delay" />
              <ExampleCard title="Notes" example="summarize this and take a note" />
            </div>
          </div>

          <div className="glass-card p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Recent activity</div>
                <h2 className="mt-2 text-xl font-semibold text-text-primary">Latest saved work</h2>
              </div>
              <div className="flex items-center gap-2">
                {recentState.stale ? (
                  <span className="rounded-full border border-semantic-warning/20 bg-semantic-warning/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-semantic-warning">
                    Showing last load
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void loadRecentActivity()}
                  className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-white/[0.08]"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => navigate(buildLibraryRoute())}
                  className="rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-white/[0.08]"
                >
                  Open Library
                </button>
              </div>
            </div>

            {recentState.error ? (
              <div className="mt-4 rounded-2xl border border-semantic-warning/20 bg-semantic-warning/8 px-4 py-3 text-sm leading-6 text-text-secondary">
                {recentState.error}
              </div>
            ) : null}

            <div className="mt-5 space-y-3">
              {recentItems.length ? recentItems.map((item) => (
                <button
                  key={`${item.kind}:${item.id}`}
                  type="button"
                  onClick={() => navigate(buildLibraryRoute(item.kind === 'note' ? 'notes' : 'recent_runs'))}
                  className="w-full rounded-2xl border border-white/6 bg-black/20 px-4 py-3 text-left transition-colors hover:bg-black/26"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[11px] uppercase tracking-[0.18em] text-text-muted">{item.app_name}</div>
                    <div className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-text-muted">{formatLibraryTimestamp(item.created_at)}</div>
                  </div>
                  <div className="mt-2 text-sm leading-6 text-text-primary">{item.preview}</div>
                  <div className="mt-2 text-[11px] uppercase tracking-[0.18em] text-text-secondary">{formatLibraryItemLabel(item)}</div>
                </button>
              )) : (
                <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-5 text-sm leading-6 text-text-secondary">
                  Your saved notes and recent runs will show up here after the first dictation or rewrite.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
