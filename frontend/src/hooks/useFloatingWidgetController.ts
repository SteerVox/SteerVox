import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'

import { DISPLAY_NAME } from '../../shared/branding'
import { apiGet, apiPost } from '../lib/api'
import { getErrorMessage } from '../lib/errors'
import { claimPasteDeliveryAnnouncement, clearPasteDeliveryAttempt, deliverPendingPaste } from '../lib/pasteDelivery'
import { buildSettingsRoute } from '../lib/routes'
import { refreshRuntimeLocalEnvironment, useRuntimeStore } from '../lib/runtimeStore'
import { selectOnboardingState, selectPrimaryAttentionIssue, selectReadinessState } from '../lib/runtimeSelectors'
import { getPendingNotificationKey, isPreparingPasteBusy } from '../lib/widgetDelivery'
import type {
  BackendBootState,
  BackendStatus,
  CaptureState,
  DomainMode,
  LiveTranscription,
  PendingActionReview,
  PendingReviewItem,
  RecordingMode,
  Skill,
  WidgetPresentationSource,
} from '../types'

export type WidgetState =
  | 'disconnected'
  | 'idle'
  | 'starting'
  | 'recording'
  | 'processing'
  | 'booting'
  | 'error_nokey'

export type PresentationState = 'hidden' | 'entering' | 'visible' | 'exiting'

export type SuccessMessage = {
  title: string
  detail: string
}

export const DEFAULT_BOOT_STATE: BackendBootState = {
  phase: 'booting_backend',
  label: `Preparing ${DISPLAY_NAME}`,
  detail: 'Getting things ready.',
  progress: 20,
}

export const DEFAULT_CAPTURE_STATE: CaptureState = {
  is_recording: false,
  is_testing: false,
  mode: null,
  phase: 'idle',
  amplitude: 0,
  error: null,
  active_device_id: null,
  active_device_label: null,
  fallback_to_default: false,
  fallback_notice: null,
}

function compactHost(host?: string | null) {
  return host ? host.replace(/^www\./, '') : null
}

function resolveCapturedTarget(status: BackendStatus | null) {
  return compactHost(status?.captured_context?.url_host)
    || (status?.captured_context?.app_name && status.captured_context.app_name !== 'Unknown'
      ? status.captured_context.app_name
      : 'your app')
}

const WIDGET_VISIBLE_SYSTEM_SKILL_IDS: ReadonlySet<string> = new Set([
  'system_dictation',
  'system_grammar',
  'strict_grammar',
  'system_rewrite',
  'system_chat_reply',
  'system_email_draft',
  'system_social_post',
  'system_computer_use',
  'system_local_task',
  'system_terminal',
  'system_code',
  'system_issue_ticket',
  'system_doc_notes',
  'system_domain_structured_note',
  'system_bullets',
  'system_translate',
])

function createFallbackWidgetSkill(id: string, name: string): Skill {
  return {
    id,
    name,
    prompt: '',
    description: undefined,
    triggers: [],
    target_types: [],
    max_chars: null,
    style: null,
    fallback_behavior: 'selected_skill',
    output_mode: 'plain_text',
  }
}

const DEFAULT_WIDGET_TEMPLATE_OPTIONS: Skill[] = [
  createFallbackWidgetSkill('system_dictation', 'Standard Dictation'),
  createFallbackWidgetSkill('system_grammar', 'Fix Grammar & Tone'),
  createFallbackWidgetSkill('strict_grammar', 'Strict Grammar'),
  createFallbackWidgetSkill('system_rewrite', 'Professional Rewrite'),
  createFallbackWidgetSkill('system_chat_reply', 'Team Chat Reply'),
  createFallbackWidgetSkill('system_email_draft', 'Email Draft'),
  createFallbackWidgetSkill('system_social_post', 'Social / Professional Post'),
  createFallbackWidgetSkill('system_computer_use', 'Computer Use'),
  createFallbackWidgetSkill('system_local_task', 'Local Task Shell'),
  createFallbackWidgetSkill('system_terminal', 'Terminal Command'),
  createFallbackWidgetSkill('system_code', 'Code Snippet'),
  createFallbackWidgetSkill('system_issue_ticket', 'Issue / Ticket'),
  createFallbackWidgetSkill('system_doc_notes', 'Notes / Document'),
  createFallbackWidgetSkill('system_domain_structured_note', 'Structured Note'),
  createFallbackWidgetSkill('system_bullets', 'Bullet Summary'),
  createFallbackWidgetSkill('system_translate', 'Translate'),
]

function isWidgetVisibleSkill(skill: Skill) {
  if (!skill.id.startsWith('system_') && skill.id !== 'strict_grammar') {
    return true
  }
  return WIDGET_VISIBLE_SYSTEM_SKILL_IDS.has(skill.id)
}

function normalizeWidgetTemplateOptions(skills: Skill[]) {
  const filtered = skills.filter(isWidgetVisibleSkill)
  return filtered.length ? filtered : DEFAULT_WIDGET_TEMPLATE_OPTIONS
}

export function useFloatingWidgetController() {
  const runtime = useRuntimeStore((state) => state)
  const backendStatus = runtime.snapshot.status
  const runtimeConfig = runtime.snapshot.config
  const hasRuntimeConfig = Boolean(runtimeConfig)
  const localEnvironment = runtime.localEnvironment
  const readinessState = useMemo(() => selectReadinessState(runtime), [runtime])
  const onboardingState = useMemo(() => selectOnboardingState(runtime), [runtime])
  const primaryAttentionIssue = useMemo(() => selectPrimaryAttentionIssue(runtime), [runtime])
  const [widgetState, setWidgetState] = useState<WidgetState>('booting')
  const [captureState, setCaptureState] = useState<CaptureState>(DEFAULT_CAPTURE_STATE)
  const [localLiveTranscription, setLocalLiveTranscription] = useState<LiveTranscription | null>(null)
  const [bootState, setBootState] = useState<BackendBootState>(DEFAULT_BOOT_STATE)
  const [amplitude, setAmplitude] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [presentationState, setPresentationState] = useState<PresentationState>('hidden')
  const [isHovered, setIsHovered] = useState(false)
  const [successMessage, setSuccessMessage] = useState<SuccessMessage | null>(null)
  const [sheenCycle, setSheenCycle] = useState(0)
  const [templateOptions, setTemplateOptions] = useState<Skill[]>(DEFAULT_WIDGET_TEMPLATE_OPTIONS)
  const [switchingTemplate, setSwitchingTemplate] = useState(false)
  const [switchingDomainMode, setSwitchingDomainMode] = useState(false)
  const [actionReviewBusy, setActionReviewBusy] = useState<'approve' | 'reject' | null>(null)
  const autoRetractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bootStateRef = useRef<BackendBootState>(DEFAULT_BOOT_STATE)
  const captureStateRef = useRef<CaptureState>(DEFAULT_CAPTURE_STATE)
  const hideSourceRef = useRef<WidgetPresentationSource>('tray')
  const smoothedRef = useRef(0)
  const handledNotificationRef = useRef<string | null>(null)

  const loadTemplateOptions = useCallback(async () => {
    try {
      const response = await apiGet<{ skills: Skill[] }>('/skills', { timeout: 10000 })
      setTemplateOptions(normalizeWidgetTemplateOptions(response.data.skills || []))
    } catch {
      setTemplateOptions((current) => current.length ? current : DEFAULT_WIDGET_TEMPLATE_OPTIONS)
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.surface = 'widget'
    document.body.dataset.surface = 'widget'

    return () => {
      delete document.documentElement.dataset.surface
      delete document.body.dataset.surface
    }
  }, [])

  const clearAutoRetractTimer = useCallback(() => {
    if (autoRetractTimerRef.current) {
      clearTimeout(autoRetractTimerRef.current)
      autoRetractTimerRef.current = null
    }
  }, [])

  const clearSuccessTimer = useCallback(() => {
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current)
      successTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!captureState.is_recording) return
    clearSuccessTimer()
    setSuccessMessage(null)
  }, [captureState.is_recording, clearSuccessTimer])

  useEffect(() => {
    if (!hasRuntimeConfig) return
    void loadTemplateOptions()
  }, [hasRuntimeConfig, loadTemplateOptions, runtime.connectionState, runtime.invalidationTokens.skills])

  const engageWidget = useCallback(() => {
    clearAutoRetractTimer()
  }, [clearAutoRetractTimer])

  const revealWidget = useCallback((source: WidgetPresentationSource) => {
    hideSourceRef.current = source
    clearAutoRetractTimer()
    setIsHovered(false)
    setSheenCycle((current) => current + 1)
    setPresentationState((current) => (
      current === 'hidden' || current === 'exiting'
        ? 'entering'
        : 'visible'
    ))
  }, [clearAutoRetractTimer])

  const beginHide = useCallback((source: WidgetPresentationSource) => {
    hideSourceRef.current = source
    clearAutoRetractTimer()
    setPresentationState((current) => (current === 'hidden' ? current : 'exiting'))
  }, [clearAutoRetractTimer])

  const queueSuccess = useCallback((title: string, detail: string) => {
    clearSuccessTimer()
    setLastError(null)
    setSuccessMessage({ title, detail })
    successTimerRef.current = setTimeout(() => {
      setSuccessMessage(null)
      successTimerRef.current = null
      void window.windowControls?.hideTransientWindows?.('idle')
    }, 3000)
  }, [clearSuccessTimer])

  useEffect(() => {
    let mounted = true

    window.windowControls?.getBackendBootState?.().then((state) => {
      if (mounted && state) {
        bootStateRef.current = state
        setBootState(state)
      }
    })
    window.windowControls?.getCaptureState?.().then((state) => {
      if (mounted && state) {
        captureStateRef.current = state
        setCaptureState(state)
        if (state.is_recording) {
          smoothedRef.current = state.amplitude || 0
          setAmplitude(state.amplitude || 0)
        }
      }
    })
    const disposeBoot = window.windowControls?.onBackendBootState?.((state) => {
      if (mounted) {
        bootStateRef.current = state
        setBootState(state)
      }
    })
    const disposeCapture = window.windowControls?.onCaptureState?.((state) => {
      if (!mounted) return
      captureStateRef.current = state
      setCaptureState(state)

      if (state.is_recording) {
        smoothedRef.current = Math.max(state.amplitude || 0, smoothedRef.current * 0.6)
        setAmplitude(smoothedRef.current)
      } else {
        smoothedRef.current = 0
        setAmplitude(0)
      }

      if (state.error) {
        setLastError(state.error)
      }
    })
    const disposePaste = window.windowControls?.onPasteError?.(() => {
      setLastError(`Direct paste failed. ${DISPLAY_NAME} kept the output on your clipboard.`)
    })

    return () => {
      mounted = false
      clearSuccessTimer()
      disposeBoot?.()
      disposeCapture?.()
      disposePaste?.()
    }
  }, [clearSuccessTimer])

  const preparingPasteBusy = isPreparingPasteBusy(backendStatus, {
    successVisible: Boolean(successMessage),
    completedPasteId: null,
    handledNotificationKey: handledNotificationRef.current,
  })

  useEffect(() => {
    if (!backendStatus) {
      if (runtime.connectionState === 'connecting' || bootStateRef.current.phase === 'booting_backend') {
        setWidgetState('booting')
      } else {
        setWidgetState('disconnected')
      }
      return
    }

    setLastError(backendStatus.last_error || null)

    const liveCaptureState = captureStateRef.current

    if (liveCaptureState.phase === 'starting') {
      setWidgetState('starting')
      setLastError(liveCaptureState.error || backendStatus.last_error || null)
      return
    }

    if (liveCaptureState.is_recording) {
      setWidgetState('recording')
      setLastError(liveCaptureState.error || backendStatus.last_error || null)
      return
    }

    if (readinessState && !readinessState.dictationProviderReady) {
      setWidgetState('error_nokey')
      setAmplitude(0)
      smoothedRef.current = 0
      return
    }

    if (
      backendStatus.phase === 'transcribing'
      || backendStatus.phase === 'transforming'
      || Boolean(backendStatus.active_task_run)
      || preparingPasteBusy
    ) {
      setWidgetState('processing')
      setAmplitude(0)
      smoothedRef.current = 0
      return
    }

    if (runtime.connectionState === 'error' && !backendStatus.backend_ready) {
      setWidgetState('disconnected')
      return
    }

    setWidgetState('idle')
    setAmplitude(0)
    smoothedRef.current = 0
  }, [backendStatus, preparingPasteBusy, readinessState, runtime.connectionState])

  const pendingActionReview = backendStatus?.pending_action_review ?? null
  const pendingReview = backendStatus?.pending_review ?? (
    pendingActionReview
      ? {
          id: `desktop-action:${pendingActionReview.run_id}`,
          run_id: pendingActionReview.run_id,
          scope: 'desktop_action',
          kind: 'desktop_action',
          title: pendingActionReview.title,
          summary: pendingActionReview.summary,
          detail: null,
          command: null,
          cwd: null,
          risk_level: 'medium',
          status: pendingActionReview.status,
          error: pendingActionReview.error,
          language: pendingActionReview.language,
          script: pendingActionReview.script,
        } satisfies PendingReviewItem
      : null
  )
  const activeTaskRun = backendStatus?.active_task_run ?? null
  const showActionReview = Boolean(pendingReview)
  const smartPreview = backendStatus?.smart_preview
  const liveTranscription = localLiveTranscription ?? backendStatus?.live_transcription ?? null
  const showSmartPreview = Boolean(
    !showActionReview
      && backendStatus?.phase === 'transforming'
      && backendStatus?.active_mode === 'smart_transform'
      && smartPreview
      && ['started', 'streaming', 'done'].includes(smartPreview.state),
  )
  const showLiveTranscript = Boolean(
    !showActionReview
      && !showSmartPreview
      && ['starting', 'recording', 'stopping'].includes(captureState.phase || 'idle'),
  )

  useEffect(() => {
    void window.windowControls?.setWidgetPreviewExpanded?.(showSmartPreview)

    return () => {
      void window.windowControls?.setWidgetPreviewExpanded?.(false)
    }
  }, [showSmartPreview])

  useEffect(() => {
    void window.windowControls?.setWidgetActionReviewExpanded?.(showActionReview)

    return () => {
      void window.windowControls?.setWidgetActionReviewExpanded?.(false)
    }
  }, [showActionReview])

  useEffect(() => {
    void window.windowControls?.setWidgetLiveTranscriptExpanded?.(showLiveTranscript)

    return () => {
      void window.windowControls?.setWidgetLiveTranscriptExpanded?.(false)
    }
  }, [showLiveTranscript])

  useEffect(() => {
    if (!backendStatus?.pending_paste) {
      return
    }

    let cancelled = false
    const pendingPaste = backendStatus.pending_paste
    const deliveryTarget = resolveCapturedTarget(backendStatus)

    const handlePendingPaste = async () => {
      try {
        const pasteText = window.windowControls?.pasteText
        if (!pasteText) {
          throw new Error('Direct paste is unavailable in this window.')
        }

        const result = await deliverPendingPaste({
          id: pendingPaste.id,
          text: pendingPaste.text,
          restoreClipboardAfterPaste: pendingPaste.restore_clipboard_after_paste,
        }, pasteText)

        if (cancelled) {
          return
        }

        if (result.status === 'pasted') {
          if (claimPasteDeliveryAnnouncement(pendingPaste.id)) {
            queueSuccess('Pasted', `Pasted into ${deliveryTarget}.`)
          }
          return
        }

        if (result.status === 'copied') {
          if (claimPasteDeliveryAnnouncement(pendingPaste.id)) {
            queueSuccess('Copied output', result.detail || 'Copied the latest result.')
          }
          return
        }

        clearPasteDeliveryAttempt(pendingPaste.id)
        setLastError(result.detail || 'Unable to paste right now. The result is still pending.')
      } catch (error) {
        clearPasteDeliveryAttempt(pendingPaste.id)
        if (cancelled) {
          return
        }
        setLastError(getErrorMessage(error, 'Unable to paste right now. The result is still pending.'))
      }
    }

    void handlePendingPaste()
    return () => {
      cancelled = true
    }
  }, [
    backendStatus,
    backendStatus?.pending_paste?.id,
    backendStatus?.pending_paste?.text,
    backendStatus?.pending_paste?.restore_clipboard_after_paste,
    queueSuccess,
  ])

  useEffect(() => {
    const notification = backendStatus?.pending_notification
    if (!notification) {
      handledNotificationRef.current = null
      return
    }

    const notificationKey = getPendingNotificationKey(notification)
    if (handledNotificationRef.current === notificationKey) {
      return
    }

    handledNotificationRef.current = notificationKey
    let cancelled = false

    const handleNotification = async () => {
      await window.windowControls?.showNativeNotification?.(
        notification.title,
        notification.body,
      )
      if (cancelled) return

      if (notification.title === 'Saved to Inbox') {
        await window.windowControls?.notifyInboxChanged?.()
        queueSuccess('Saved to Notes', `Saved from ${resolveCapturedTarget(backendStatus)}.`)
      } else if (/copied/i.test(notification.title)) {
        queueSuccess('Copied output', notification.body || 'Copied the latest result.')
      } else {
        queueSuccess(notification.title, notification.body || `${DISPLAY_NAME} finished the latest action.`)
      }

      try {
        await apiPost('/status/clear_paste')
      } catch {
        setLastError('The action finished, but cleanup confirmation is still pending.')
      }
    }

    void handleNotification()
    return () => {
      cancelled = true
    }
  }, [backendStatus, backendStatus?.pending_notification?.body, backendStatus?.pending_notification?.title, queueSuccess])

  useEffect(() => {
    if (!pendingReview) {
      setActionReviewBusy(null)
    }
  }, [pendingReview])

  const clearErroredActionReview = useCallback(async (review: PendingActionReview) => {
    try {
      await apiPost('/actions/review/reject', {
        run_id: review.run_id,
      })
    } catch {
      // Keep the stale error visible if cleanup fails; the backend timer is still the primary cleanup path.
    }
  }, [])

  useEffect(() => {
    if (!pendingActionReview || pendingActionReview.status !== 'error') {
      return
    }

    const timer = setTimeout(() => {
      void clearErroredActionReview(pendingActionReview)
    }, 8500)

    return () => {
      clearTimeout(timer)
    }
  }, [clearErroredActionReview, pendingActionReview])

  useEffect(() => {
    const disposePresentation = window.windowControls?.onWidgetPresentationCommand?.((command) => {
      if (command.visible) {
        void refreshRuntimeLocalEnvironment({ quiet: true })
        revealWidget(command.source)
      } else {
        beginHide(command.source)
      }
    })

    return () => {
      disposePresentation?.()
      clearAutoRetractTimer()
    }
  }, [beginHide, clearAutoRetractTimer, revealWidget])

  useEffect(() => {
    let cancelled = false

    const initialLocalLivePromise = window.windowControls?.getLocalLiveTranscriptionState?.()
    if (initialLocalLivePromise) {
      void initialLocalLivePromise
        .then((state) => {
          if (!cancelled) {
            setLocalLiveTranscription(state || null)
          }
        })
        .catch(() => undefined)
    }

    const dispose = window.windowControls?.onLocalLiveTranscription?.((state) => {
      setLocalLiveTranscription(state || null)
    })

    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])

  const triggerRecording = async (mode: RecordingMode) => {
    engageWidget()
    if (pendingActionReview?.status === 'error') {
      await clearErroredActionReview(pendingActionReview)
    }
    const dictationReady = Boolean(onboardingState?.dictationReady)
    if (mode === 'dictation' && !dictationReady) {
      await window.windowControls?.showMainWindow?.(buildSettingsRoute('voice'))
      setLastError('Dictation still needs setup. Open Voice settings to finish it.')
      return
    }
    if (mode === 'smart_transform' && !dictationReady) {
      await window.windowControls?.showMainWindow?.(buildSettingsRoute('voice'))
      setLastError('Smart still needs the voice path to be ready first.')
      return
    }
    try {
      await window.windowControls?.toggleRecording?.(mode)
      setLastError(null)
      setSuccessMessage(null)
    } catch {
      setLastError(`${DISPLAY_NAME} is not ready. Open Settings and try again.`)
    }
  }

  const showSettings = () => {
    engageWidget()
    void window.windowControls?.showMainWindow?.(buildSettingsRoute('voice'))
  }

  const showSettingsStep = (step: 'voice' | 'privacy') => {
    engageWidget()
    void window.windowControls?.showMainWindow?.(buildSettingsRoute(step))
  }

  const setDefaultTemplate = async (skillId: string) => {
    if (!runtimeConfig || runtimeConfig.hotkeys.default_skill_id === skillId) return
    setSwitchingTemplate(true)
    try {
      await apiPost('/config', {
        hotkeys: {
          ...runtimeConfig.hotkeys,
          default_skill_id: skillId,
        },
      })
      setLastError(null)
    } catch (error) {
      setLastError(getErrorMessage(error, 'Unable to switch the active template right now.'))
    } finally {
      setSwitchingTemplate(false)
    }
  }

  const setDomainMode = async (mode: DomainMode) => {
    if (!runtimeConfig || runtimeConfig.domains.mode === mode) return
    setSwitchingDomainMode(true)
    try {
      await apiPost('/config', {
        domains: {
          ...runtimeConfig.domains,
          mode,
        },
      })
      setLastError(null)
    } catch (error) {
      setLastError(getErrorMessage(error, 'Unable to switch the active domain right now.'))
    } finally {
      setSwitchingDomainMode(false)
    }
  }

  const chooseTemplate = async (skillId: string) => {
    engageWidget()
    await setDefaultTemplate(skillId)
  }

  const chooseDomainMode = (mode: DomainMode) => {
    engageWidget()
    void setDomainMode(mode)
  }

  const submitActionReviewDecision = async (
    decision: 'approve' | 'reject',
    review: PendingReviewItem,
    retryMode?: 'retry_failed_step' | 'rerun_all',
  ) => {
    engageWidget()
    setActionReviewBusy(decision)
    try {
      if (review.scope === 'desktop_action') {
        await apiPost(`/actions/review/${decision}`, {
          run_id: review.run_id,
        })
      } else {
        const payload: Record<string, string> = {
          run_id: review.run_id,
          review_id: review.id,
        }
        if (decision === 'approve' && retryMode) {
          payload.retry_mode = retryMode
        }
        await apiPost(`/tasks/local/review/${decision}`, payload)
      }
      setLastError(null)
    } catch (error) {
      const fallback = decision === 'approve'
        ? review.scope === 'desktop_action'
          ? 'Unable to run that desktop action right now.'
          : 'Unable to start that local task right now.'
        : review.scope === 'desktop_action'
          ? 'Unable to dismiss that desktop action right now.'
          : 'Unable to dismiss that local task right now.'
      setLastError(getErrorMessage(error, fallback))
    } finally {
      setActionReviewBusy(null)
    }
  }

  const handleWidgetAction = (action: () => void, disabled = false) => (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    event.preventDefault()
    engageWidget()
    action()
  }

  return {
    runtime,
    backendStatus,
    runtimeConfig,
    localEnvironment,
    readinessState,
    onboardingState,
    primaryAttentionIssue,
    widgetState,
    captureState,
    localLiveTranscription,
    bootState,
    amplitude,
    lastError,
    presentationState,
    isHovered,
    successMessage,
    sheenCycle,
    templateOptions,
    switchingTemplate,
    switchingDomainMode,
    actionReviewBusy,
    hideSourceRef,
    autoRetractTimerRef,
    preparingPasteBusy,
    pendingActionReview,
    pendingReview,
    activeTaskRun,
    smartPreview,
    liveTranscription,
    showActionReview,
    showSmartPreview,
    showLiveTranscript,
    clearAutoRetractTimer,
    beginHide,
    showSettings,
    showSettingsStep,
    chooseTemplate,
    chooseDomainMode,
    submitActionReviewDecision,
    handleWidgetAction,
    triggerRecording,
    setPresentationState,
    setIsHovered,
    engageWidget,
  }
}
